import voiceControls from './.generated/voice-entry.txt';
import voiceSdk from './.generated/voice-sdk.txt';
import audioResampler from './.generated/voice-resampler.txt';
import { issueVoiceSession } from './voice-session.mjs';

const websiteOrigin = "https://verityresearch.us";
const signInLink = '<a class="btn sm" href="/auth/sign-in">Sign in</a>';

function accountControls(className) {
  return `<div class="${className}">
    <a class="btn sm" href="/auth/sign-in" data-verity-sign-in hidden>Sign in</a>
    <button class="btn sm" type="button" data-verity-sign-out hidden>Sign out</button>
    <noscript>${signInLink}</noscript>
  </div>`;
}

const accountStyles = `<style>
  #nav [data-verity-sign-in][hidden], #nav [data-verity-sign-out][hidden] {display:none!important}
  #gaiPanel [data-verity-voice] [hidden] {display:none!important}
  #nav .verity-account-mobile {display:none}
  .verity-account-message {margin:0; padding:.5rem var(--margin); color:var(--text-primary); background:var(--bg-elevated)}
  @media(max-width:1024px) {
    #nav .verity-account-mobile {display:flex; align-items:center; margin-inline-start:auto}
    #nav .verity-account-mobile .btn {min-height:44px}
    #nav .verity-account-mobile + .menu-btn {margin-left:0; flex-shrink:0}
    #nav .nav-inner {gap:12px}
    #nav .nav-inner > .status {white-space:normal}
  }
  @media(max-width:400px) {
    #nav .nav-inner {gap:8px}
    #nav .verity-account-mobile .btn {padding-inline:8px}
  }
</style>`;

const accountScript = String.raw`(() => {
  const signIn = document.querySelectorAll('[data-verity-sign-in]');
  const signOut = document.querySelectorAll('[data-verity-sign-out]');
  const message = document.getElementById('verity-account-message');
  let state;
  let version = 0;
  let checking = false;
  let leaving = false;

  function show(signedIn) {
    state = signedIn;
    for (const link of signIn) link.hidden = signedIn;
    for (const button of signOut) button.hidden = !signedIn;
  }

  function showMessage(text) {
    message.textContent = text;
    message.hidden = !text;
  }

  async function verifiedSession() {
    const response = await fetch('/auth/session', {
      credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(7000),
    });
    if (response.status === 200 && response.headers.get('content-type')?.startsWith('application/json')) return true;
    if (response.status === 401) return false;
    throw new Error('Session status unavailable');
  }

  async function refresh() {
    if (checking || leaving) return;
    checking = true;
    const started = version;
    try {
      const signedIn = await verifiedSession();
      if (version === started) show(signedIn);
    } catch {
      if (version === started && state === undefined) show(false);
    } finally {
      checking = false;
    }
  }

  for (const button of signOut) button.addEventListener('click', async () => {
    if (leaving) return;
    leaving = true;
    version++;
    showMessage('');
    for (const control of signOut) control.disabled = true;
    try {
      const response = await fetch('/auth/logout', {
        method: 'POST', credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(12000),
      });
      if (response.status !== 204 && await verifiedSession()) throw new Error('Sign-out unavailable');
      show(false);
      if (window.VERITY_ACCOUNT) {
        try { sessionStorage.removeItem('verity.mode'); } catch {}
        window.location.replace(window.location.pathname);
        return;
      }
      button.parentElement.querySelector('[data-verity-sign-in]')?.focus();
    } catch {
      showMessage('Could not sign out. Try again.');
    } finally {
      leaving = false;
      for (const control of signOut) control.disabled = false;
    }
  });

  window.addEventListener('pageshow', (event) => { if (event.persisted) void refresh(); });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void refresh();
  });
  void refresh();
})();`;

const homepageNavigation = new HTMLRewriter()
  .on('section#ledger[aria-labelledby="ldgTitle"], a[href="#ledger"]', {
    element(operatorLedger) {
      operatorLedger.remove();
    },
  })
  .on('#nav a.signin[href="/auth/sign-in"], #nav button.signout[data-signout]', {
    element(duplicateAccountControl) {
      duplicateAccountControl.remove();
    },
  })
  .on("head", {
    element(head) {
      head.append(accountStyles, { html: true });
    },
  })
  .on("#nav .nav-cta", {
    element(nav) {
      nav.append(accountControls("verity-account-desktop"), { html: true });
    },
  })
  .on("#nav #menuBtn", {
    element(menuButton) {
      menuButton.before(accountControls("verity-account-mobile"), { html: true });
    },
  })
  .on("#nav", {
    element(nav) {
      nav.append('<p class="verity-account-message" id="verity-account-message" role="status" hidden></p>', { html: true });
    },
  })
  .on("body", {
    element(body) {
      body.append(`<script>${accountScript}</script>`, { html: true });
    },
  });

function attachVoiceAgent(response, agentId, protectedVoice) {
  if (typeof agentId !== "string" || !/^(?:agent_)?[A-Za-z0-9]{16,64}$/.test(agentId)) return response;

  return new HTMLRewriter().on("#gaiPanel .ai-dock-body", {
    element(panel) {
      panel.prepend(`<div class="ai-market" data-verity-voice="${protectedVoice ? '' : agentId}"${protectedVoice ? ' data-verity-voice-protected' : ''}>
        <p class="gai-help" id="verity-voice-disclosure">Voice is optional. ElevenLabs receives and processes your microphone audio; the audio and transcript are not kept after the call. Share only public market rules. <a href="/privacy.html">Privacy notice</a>.</p>
        <p class="gai-help"><label><input type="checkbox" data-voice-consent aria-describedby="verity-voice-disclosure" autocomplete="off"> I agree to send microphone audio to ElevenLabs for this call.</label></p>
        <button class="btn ai-full" type="button" aria-describedby="verity-voice-disclosure" disabled>Start voice</button>
        <p class="gai-help" data-voice-allowance aria-live="polite" hidden></p>
        <p class="gai-help" role="status"></p>
        <p class="gai-help" data-voice-time hidden></p>
        <a class="btn ai-full" href="/auth/sign-in" data-voice-signin hidden>Sign in to use voice</a>
        <button class="btn ai-full" type="button" data-voice-mute hidden>Mute microphone</button>
        <script src="/_verity/voice.js" defer></script>
      </div>`, { html: true });
    },
  }).transform(response);
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const protectedVoice = env.VERITY_VOICE_MODE === 'protected';
    if (url.origin === websiteOrigin && ['/_verity/voice-session', '/_verity/voice-allowance'].includes(url.pathname)) {
      if (!protectedVoice) return new Response(null, { status: 404 });
      return issueVoiceSession(request, env);
    }
    if (url.origin === websiteOrigin && ['/_verity/voice.js', '/_verity/voice-sdk.js', '/_verity/voice-resampler.js'].includes(url.pathname)) {
      if (request.method !== 'GET' && request.method !== 'HEAD') return new Response(null, { status: 405, headers: { Allow: 'GET, HEAD' } });
      const entry = url.pathname === '/_verity/voice.js';
      const script = entry ? voiceControls : url.pathname === '/_verity/voice-sdk.js' ? voiceSdk : audioResampler;
      return new Response(request.method === 'HEAD' ? null : script, {
        headers: {
          'Content-Type': 'text/javascript; charset=utf-8',
          'X-Content-Type-Options': 'nosniff',
          'Cross-Origin-Resource-Policy': 'same-origin',
          'Cache-Control': entry ? 'no-cache' : 'public, max-age=3600',
        },
      });
    }
    if (request.method !== "GET" || url.origin !== websiteOrigin ||
        (url.pathname !== "/" && url.pathname !== "/index.html")) {
      return fetch(request);
    }

    ctx.passThroughOnException();
    const requestHeaders = new Headers(request.headers);
    requestHeaders.delete("if-none-match");
    requestHeaders.delete("if-modified-since");
    const response = await fetch(new Request(request, { headers: requestHeaders }));
    if (!response.ok || !response.headers.get("content-type")?.startsWith("text/html")) {
      return response;
    }

    const transformed = attachVoiceAgent(homepageNavigation.transform(response), env.VERITY_ELEVENLABS_AGENT_ID, protectedVoice);
    const headers = new Headers(transformed.headers);
    for (const name of ["etag", "last-modified", "content-md5", "content-digest"]) {
      headers.delete(name);
    }
    headers.set("cache-control", "no-cache");
    return new Response(transformed.body, { status: transformed.status, headers });
  },
};
