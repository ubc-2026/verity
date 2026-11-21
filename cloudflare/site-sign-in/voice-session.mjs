import { voiceLimits } from './voice-budget.mjs';

const browserCookie = '__Host-verity-voice-browser';
const guestCookie = '__Host-verity-voice-guest';
const siteOrigin = 'https://verityresearch.us';

function cookieValue(request, name) {
  const entry = request.headers.get('cookie')?.split(';').map(part => part.trim()).find(part => part.startsWith(`${name}=`));
  return entry?.slice(name.length + 1) ?? '';
}

function reply(status, body, extra = {}) {
  return Response.json(body, {
    status, headers: { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff', ...extra },
  });
}

function unavailable(step, status) {
  console.warn('Verity voice unavailable', step, status);
  return reply(503, { error: 'voice_unavailable' });
}

async function quotaDenial(response, mode) {
  if (response.status !== 429) return unavailable('budget', response.status);
  const { error, reset } = await response.json();
  const headers = reset ? { 'Retry-After': String(Math.max(1, Math.ceil((reset - Date.now()) / 1000))) } : {};
  return reply(429, { error, reset, mode, remaining: 0 }, headers);
}

export async function issueVoiceSession(request, env, send = fetch) {
  if (request.method !== 'POST') return reply(405, { error: 'method_not_allowed' }, { Allow: 'POST' });
  if (request.headers.get('origin') !== siteOrigin) return reply(403, { error: 'denied' });
  const ip = request.headers.get('cf-connecting-ip');
  const statusOnly = new URL(request.url).pathname === '/_verity/voice-allowance';
  const session = cookieValue(request, '__Host-verity-session');
  const agent = env.VERITY_ELEVENLABS_AGENT_ID;
  if (!ip || !env.ELEVENLABS_API_KEY || !/^agent_[A-Za-z0-9]{16,64}$/.test(agent ?? '')) return unavailable('configuration');

  let step = 'rate_limit';
  try {
    const rate = await env.VOICE_IP_LIMIT.limit({ key: statusOnly ? `status:${ip}` : ip });
    if (!rate.success) return reply(429, { error: 'rate_limit' }, { 'Retry-After': '60' });
    let accountId = null;
    if (session) {
      step = 'account';
      const verified = await env.VERITY_VOICE_ACCOUNT.fetch(`${siteOrigin}/auth/session`, {
        headers: { cookie: `__Host-verity-session=${session}`, 'cf-connecting-ip': ip },
        redirect: 'manual', signal: AbortSignal.timeout(7000),
      });
      if (verified.status === 401) return reply(401, { error: 'signin_required' });
      if (verified.status === 429) return reply(429, { error: 'rate_limit' }, { 'Retry-After': '60' });
      if (!verified.ok) return unavailable(step, verified.status);
      ({ accountId } = await verified.json());
      if (typeof accountId !== 'string') return unavailable(step);
    }
    const cookieName = session ? browserCookie : guestCookie;
    const cookieAge = session ? 2678400 : 34560000;
    const mode = accountId === null ? 'guest' : 'account';
    step = 'budget';
    const budget = env.VOICE_BUDGET.getByName('verity-voice');
    const checkAllowance = (method, browser) => budget.fetch('https://voice-budget.internal/', {
      method, body: JSON.stringify({ account: accountId, browser, ip: session ? undefined : ip }),
    });
    const available = await checkAllowance('PUT', cookieValue(request, cookieName));
    if (!available.ok) return await quotaDenial(available, mode);
    const { browser, remaining } = await available.json();
    if (statusOnly) {
      // The allowance probe reports the balance after a hypothetical start.
      return reply(200, { mode, remaining: remaining + 1 });
    }

    step = 'provider';
    const endpoint = new URL('https://api.elevenlabs.io/v1/convai/conversation/get-signed-url');
    endpoint.searchParams.set('agent_id', agent);
    endpoint.searchParams.set('include_conversation_id', 'true');
    const upstream = await send(endpoint, { headers: { 'xi-api-key': env.ELEVENLABS_API_KEY }, redirect: 'manual', signal: AbortSignal.timeout(7000) });
    if (!upstream.ok) return unavailable(step, upstream.status);
    const { signed_url: signedUrl } = await upstream.json();
    const url = new URL(signedUrl);
    if (url.origin !== 'wss://api.elevenlabs.io' || url.pathname !== '/v1/convai/conversation' ||
        url.username || url.password || url.hash || url.searchParams.get('agent_id') !== agent || !url.searchParams.get('conversation_signature')) {
      return unavailable('provider_url');
    }

    step = 'budget';
    const admitted = await checkAllowance('POST', browser);
    if (!admitted.ok) return await quotaDenial(admitted, mode);
    const charged = await admitted.json();
    const cookie = { 'Set-Cookie': `${cookieName}=${charged.browser}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=${cookieAge}` };
    return reply(200, { signedUrl, mode, remaining: charged.remaining, callSeconds: voiceLimits.seconds }, cookie);
  } catch {
    return unavailable(step);
  }
}
