const string = { type: 'STRING' };
const score = { type: 'INTEGER', minimum: 1, maximum: 3 };
const object = properties => ({ type: 'OBJECT', properties, required: Object.keys(properties) });
const schema = object({
  summary: string,
  settlement_source: string,
  ambiguities: { type: 'ARRAY', items: object({ issue: string, quote: string, why_it_matters: string }) },
  scores: object({ ambiguity: score, source: score, correlation: score }),
  agrees_with_rules_analyst: { type: 'BOOLEAN' },
  disagreement: string,
  research_to_close_gaps: { type: 'ARRAY', items: string },
  confidence: { type: 'STRING', enum: ['low', 'medium', 'high'] },
});
// Same schema in standard JSON Schema form (lower-case types) for Workers AI.
const lower = s => Array.isArray(s) ? s.map(lower) : s && typeof s === 'object'
  ? Object.fromEntries(Object.entries(s).map(([k, v]) => [k, k === 'type' ? String(v).toLowerCase() : lower(v)]))
  : s;
const jsonSchema = lower(schema);

const forecastSchema = object({
  probability_yes: { type: 'NUMBER', minimum: 0, maximum: 1 },
  confidence: { type: 'STRING', enum: ['low', 'medium', 'high'] },
  reasoning: string,
  drivers: { type: 'ARRAY', items: string },
  risks: { type: 'ARRAY', items: string },
});
const forecastJsonSchema = lower(forecastSchema);
const FORECAST_SYSTEM = 'You estimate the probability that a prediction-market outcome resolves Yes, using ONLY the supplied market data and price history. The market price already reflects traders\' views; move away from it only for reasons you can name from the data. Account for settlement-rule risk. Return a calibrated probability between 0 and 1. This is research, not trading advice; never tell anyone to buy or sell.';

const SYSTEM = 'Review prediction-market settlement rules using only the supplied market data. Say when evidence is missing. Give no trading advice or outcome predictions. Score risk as 1 low, 2 medium, 3 high. Keep answers concise.';

// If the configured model is retired (404), ask Google which models this key can use and
// pick the newest stable Flash model. The choice is cached while this Worker instance lives.
let chosenModel = null;
let candidates = null;
let lastGemini = { model: null, outcome: null, ms: null, at: null };
async function listModels(env) {
  if (candidates) return candidates;
  try {
    const r = await fetch('https://generativelanguage.googleapis.com/v1beta/models?pageSize=200', {
      redirect: 'manual', signal: AbortSignal.timeout(10000), headers: { 'x-goog-api-key': env.GEMINI_API_KEY },
    });
    if (!r.ok) return [];
    const list = ((await r.json()).models || [])
      .filter(m => (m.supportedGenerationMethods || []).includes('generateContent'))
      .map(m => m.name.replace(/^models\//, ''))
      .filter(n => /^gemini-/.test(n) && !/embedding|image|tts|audio|live|vision|thinking|deep|computer|robotics|native/.test(n));
    const ver = n => parseFloat((n.match(/^gemini-(\d+(?:\.\d+)?)/) || [])[1]) || 0;
    const rank = n => (/flash/.test(n) ? 100 : 0) + (/lite/.test(n) ? 5 : 0) - (/preview|exp/.test(n) ? 40 : 0) - (/pro/.test(n) ? 30 : 0) + ver(n);
    candidates = list.sort((a, b) => rank(b) - rank(a)).slice(0, 4);
    return candidates;
  } catch { return []; }
}
const noThinking = new Set();
const thinkingFor = n => noThinking.has(n) ? null : /^gemini-2\.5/.test(n) ? { thinkingBudget: 0 } : /^gemini-[3-9]/.test(n) ? { thinkingLevel: 'low' } : null;

async function askGemini(env, mode, prompt, market, opts = {}) {
  if (!env.GEMINI_API_KEY) return { ok: false, reason: 'no_key' };
  const tried = new Set();
  const order = [chosenModel || env.GEMINI_MODEL];
  let last = { ok: false, reason: 'unavailable' };
  for (let i = 0; i < 3; i++) {
    const m = order[i];
    if (!m || tried.has(m)) break;
    tried.add(m);
    const t0 = Date.now();
    last = await callGemini(env, m, mode, prompt, market, opts);
    lastGemini = { model: m, outcome: last.ok ? 'ok' : last.reason, ms: Date.now() - t0, at: new Date().toISOString() };
    if (last.ok) { chosenModel = m; return last; }
    if (last.reason === 'quota' || last.reason === 'blocked') return last;
    // 404 (retired), timeout, or other error: move to the next-best model
    for (const c of await listModels(env)) if (!tried.has(c) && !order.includes(c)) order.push(c);
  }
  return last;
}

async function callGemini(env, modelName, mode, prompt, market, opts = {}, withThinking = true) {
  const generationConfig = mode === 'ask'
    ? { temperature: 0.3, maxOutputTokens: 1024 }
    : { temperature: 0.2, maxOutputTokens: 2048, responseMimeType: 'application/json', responseSchema: opts.schema || schema };
  const thinking = withThinking ? thinkingFor(modelName) : null;
  if (thinking) generationConfig.thinkingConfig = thinking;
  try {
    const model = encodeURIComponent(modelName);
    const result = await fetch('https://generativelanguage.googleapis.com/v1beta/models/' + model + ':generateContent', {
      method: 'POST',
      redirect: 'manual', // Workers only support 'follow' or 'manual'
      signal: AbortSignal.timeout(14000),
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': env.GEMINI_API_KEY },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: opts.system || SYSTEM }] },
        contents: [{ role: 'user', parts: [{ text: prompt + '\n' + JSON.stringify(market) }] }],
        generationConfig,
      }),
    });
    if (result.status === 429) return { ok: false, reason: 'quota' };
    if (result.status === 400 && thinking) { noThinking.add(modelName); return callGemini(env, modelName, mode, prompt, market, opts, false); } // model rejects the thinking setting
    if (!result.ok) return { ok: false, reason: 'error_' + result.status };
    const data = await result.json();
    const candidates = (data.candidates ?? []).slice(0, 1).map(candidate => ({
      finishReason: candidate.finishReason,
      content: { parts: (candidate.content?.parts ?? []).filter(part => !part.thought).map(part => ({ text: part.text })) },
    }));
    const text = candidates[0]?.content.parts.map(p => p.text || '').join('') || '';
    if (!text.trim()) return { ok: false, reason: data.promptFeedback?.blockReason ? 'blocked' : 'empty' };
    return { ok: true, body: { provider: 'google-gemini', modelVersion: data.modelVersion || modelName, candidates, promptFeedback: data.promptFeedback, usageMetadata: data.usageMetadata } };
  } catch (e) {
    return { ok: false, reason: e && e.name === 'TimeoutError' ? 'timeout' : 'unreachable' };
  }
}

async function askWorkersAI(env, mode, prompt, market, opts = {}) {
  if (!env.AI) return { ok: false };
  const messages = [
    { role: 'system', content: (opts.system || SYSTEM) + (mode !== 'ask' ? ' Reply with one JSON object only.' : '') },
    { role: 'user', content: prompt + '\n' + JSON.stringify(market) },
  ];
  const attempts = mode === 'ask'
    ? [{ messages, max_tokens: 1024, temperature: 0.3 }]
    : [
        { messages, max_tokens: 2048, temperature: 0.2, response_format: { type: 'json_schema', json_schema: opts.jsonSchema || jsonSchema } },
        { messages, max_tokens: 2048, temperature: 0.2, response_format: { type: 'json_object' } },
      ];
  for (const input of attempts) {
    try {
      const out = await env.AI.run(env.BACKUP_MODEL, input);
      let text = out?.response;
      if (text && typeof text === 'object') text = JSON.stringify(text);
      if (typeof text !== 'string' || !text.trim()) continue;
      if (mode !== 'ask') { try { JSON.parse(text); } catch { continue; } }
      return { ok: true, body: {
        provider: 'workers-ai', modelVersion: env.BACKUP_MODEL,
        candidates: [{ finishReason: 'STOP', content: { parts: [{ text }] } }],
        usageMetadata: out?.usage ? { totalTokenCount: out.usage.total_tokens } : undefined,
      } };
    } catch {
      // try the next attempt (JSON mode can fail with "JSON Mode couldn't be met")
    }
  }
  return { ok: false };
}

const FEEDS = [
  ['CoinDesk', 'https://www.coindesk.com/arc/outboundfeeds/rss/'],
  ['Cointelegraph', 'https://cointelegraph.com/rss'],
  ['Decrypt', 'https://decrypt.co/feed'],
  ['The Block', 'https://www.theblock.co/rss.xml'],
];
const decode = t => t.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
  .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n)).replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
  .replace(/&quot;/g, '"').replace(/&apos;|&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');
const strip = t => decode(t).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
const tag = (x, n) => { const m = x.match(new RegExp('<' + n + '(?:\\s[^>]*)?>([\\s\\S]*?)</' + n + '>', 'i')); return m ? m[1] : ''; };
const attr = (x, re) => { const m = x.match(re); return m ? decode(m[1]) : null; };
const safeUrl = u => { try { const x = new URL(u); return x.protocol === 'https:' || x.protocol === 'http:' ? x.href : null; } catch { return null; } };
async function readFeed([source, url]) {
  try {
    const r = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(8000),
      headers: { 'User-Agent': 'VerityResearch/1.0 (+https://verityresearch.us)', Accept: 'application/rss+xml, application/xml, text/xml' } });
    if (!r.ok) return [];
    const xml = await r.text();
    return (xml.match(/<item[\s>][\s\S]*?<\/item>/gi) || []).slice(0, 15).map(it => {
      const title = strip(tag(it, 'title'));
      const link = safeUrl(strip(tag(it, 'link')) || attr(it, /<guid[^>]*>(https?:[^<]+)<\/guid>/i) || '');
      const when = Date.parse(strip(tag(it, 'pubDate')) || strip(tag(it, 'dc:date')));
      let summary = strip(tag(it, 'description'));
      if (summary.length > 180) summary = summary.slice(0, 177).replace(/\s+\S*$/, '') + '…';
      const image = safeUrl(attr(it, /<media:content[^>]+url="([^"]+)"/i) || attr(it, /<media:thumbnail[^>]+url="([^"]+)"/i) || attr(it, /<enclosure[^>]+url="([^"]+)"[^>]*type="image/i) || '');
      return title && link ? { title, link, source, published: isNaN(when) ? null : new Date(when).toISOString(), summary, image } : null;
    }).filter(Boolean);
  } catch { return []; }
}
async function news(request, env, headers) {
  const cache = caches.default;
  const key = new Request('https://verity-cache.internal/news-v1');
  let hit = await cache.match(key);
  if (!hit) {
    const lists = await Promise.all(FEEDS.map(readFeed));
    const seen = new Set();
    const items = lists.flat().filter(i => { const k = i.title.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; })
      .sort((a, b) => (b.published || '').localeCompare(a.published || '')).slice(0, 40);
    const body = JSON.stringify({ fetched_at: new Date().toISOString(), sources: FEEDS.map((f, i) => ({ name: f[0], items: lists[i].length })), items });
    hit = new Response(body, { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'max-age=600' } });
    if (items.length) await cache.put(key, hit.clone());
  }
  return new Response(hit.body, { status: 200, headers: { ...headers, 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=300' } });
}

// ---------- Exa research ----------
async function exaSearch(env, query, days, num) {
  if (!env.EXA_API_KEY) return { ok: false, reason: 'no_exa_key' };
  const since = new Date(Date.now() - days * 86400000).toISOString();
  try {
    const r = await fetch('https://api.exa.ai/search', {
      method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(15000),
      headers: { 'Content-Type': 'application/json', 'x-api-key': env.EXA_API_KEY },
      body: JSON.stringify({ query, type: 'auto', category: 'news', numResults: num, startPublishedDate: since, contents: { highlights: true } }),
    });
    if (r.status === 429) return { ok: false, reason: 'exa_rate_limit' };
    if (!r.ok) return { ok: false, reason: 'exa_error_' + r.status };
    const j = await r.json();
    const items = (j.results || []).map(x => {
      const link = safeUrl(x.url || '');
      let host = ''; try { host = new URL(link).hostname.replace(/^www\./, ''); } catch {}
      const hl = (Array.isArray(x.highlights) ? x.highlights : []).map(h => String(h).replace(/\s+/g, ' ').trim()).filter(Boolean);
      let summary = hl[0] || '';
      if (summary.length > 220) summary = summary.slice(0, 217).replace(/\s+\S*$/, '') + '…';
      return link && x.title ? { title: String(x.title).trim(), link, source: host, published: x.publishedDate || null, summary, image: safeUrl(x.image || '') , highlights: hl.slice(0, 2).map(h => h.slice(0, 400)) } : null;
    }).filter(Boolean);
    return { ok: true, items };
  } catch { return { ok: false, reason: 'exa_unreachable' }; }
}
async function research(request, env, headers, fail) {
  const u = new URL(request.url);
  const q = (u.searchParams.get('q') || 'crypto market trends bitcoin ethereum stablecoins regulation').trim();
  const days = Math.max(1, Math.min(30, parseInt(u.searchParams.get('days') || '7', 10) || 7));
  if (q.length < 3 || q.length > 200) return fail(400, 'Query must be 3 to 200 characters.');
  const cache = caches.default;
  const key = new Request('https://verity-cache.internal/research-v1?d=' + days + '&q=' + encodeURIComponent(q.toLowerCase()));
  const hit = await cache.match(key);
  if (hit) return new Response(hit.body, { status: 200, headers: { ...headers, 'Content-Type': 'application/json', 'X-Cache': 'HIT' } });
  const { success } = await env.REVIEW_LIMIT.limit({ key: 'research:' + (request.headers.get('CF-Connecting-IP') || 'unknown') });
  if (!success) return fail(429, 'Too many requests.');
  const res = await exaSearch(env, q, days, 10);
  if (!res.ok) return fail(res.reason === 'no_exa_key' ? 503 : 502, res.reason === 'no_exa_key' ? 'Research needs an Exa API key on the Worker.' : 'Exa research is unavailable right now.');
  const body = JSON.stringify({ query: q, days, fetched_at: new Date().toISOString(), source: 'Exa', items: res.items });
  await cache.put(key, new Response(body, { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'max-age=1800' } }));
  return new Response(body, { status: 200, headers: { ...headers, 'Content-Type': 'application/json', 'X-Cache': 'MISS' } });
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin');
    const headers = { Vary: 'Origin', 'Cache-Control': 'no-store' };
    const fail = (status, error) => Response.json({ error }, { status, headers });
    const path = new URL(request.url).pathname;
    if (!['/review', '/news', '/research', '/status'].includes(path)) return fail(404, 'Unknown endpoint.');
    if (origin !== env.SITE_ORIGIN) return fail(403, 'Origin unavailable.');
    headers['Access-Control-Allow-Origin'] = origin;
    if (path === '/news') {
      if (request.method === 'OPTIONS') { headers['Access-Control-Allow-Methods'] = 'GET'; return new Response(null, { status: 204, headers }); }
      if (request.method !== 'GET') return fail(405, 'Use GET.');
      return news(request, env, headers);
    }
    if (path === '/status') {
      if (request.method === 'OPTIONS') { headers['Access-Control-Allow-Methods'] = 'GET'; return new Response(null, { status: 204, headers }); }
      return Response.json({ version: 'v7', gemini: { key_configured: !!env.GEMINI_API_KEY, preferred_model: env.GEMINI_MODEL, chosen_model: chosenModel, last_call: lastGemini, candidates },
        workers_ai: { bound: !!env.AI, model: env.BACKUP_MODEL }, exa: { key_configured: !!env.EXA_API_KEY } }, { headers });
    }
    if (path === '/research') {
      if (request.method === 'OPTIONS') { headers['Access-Control-Allow-Methods'] = 'GET'; return new Response(null, { status: 204, headers }); }
      if (request.method !== 'GET') return fail(405, 'Use GET.');
      return research(request, env, headers, fail);
    }
    if (request.method === 'OPTIONS') {
      headers['Access-Control-Allow-Methods'] = 'POST';
      headers['Access-Control-Allow-Headers'] = 'Content-Type';
      return new Response(null, { status: 204, headers });
    }
    if (request.method !== 'POST') return fail(405, 'Use POST.');
    if (request.headers.get('Content-Type')?.split(';')[0].trim() !== 'application/json') {
      return fail(415, 'Send JSON.');
    }
    const { success } = await env.REVIEW_LIMIT.limit({
      key: request.headers.get('CF-Connecting-IP') || 'unknown',
    });
    if (!success) return fail(429, 'Too many requests.');

    let input;
    try {
      const reader = request.body.getReader();
      const decoder = new TextDecoder();
      let raw = '';
      let bytes = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > 24576) {
          await reader.cancel();
          return fail(413, 'Market data is too large.');
        }
        raw += decoder.decode(value, { stream: true });
      }
      input = JSON.parse(raw + decoder.decode());
    } catch {
      return fail(400, 'Invalid JSON.');
    }
    const { mode, market, question } = input ?? {};
    if (!['review', 'ask', 'forecast'].includes(mode) || !market || typeof market !== 'object' || Array.isArray(market)) {
      return fail(400, 'Choose a review mode and market.');
    }
    if (mode === 'ask' && (typeof question !== 'string' || !question.trim() || question.length > 1500)) {
      return fail(400, 'Enter a question of at most 1,500 characters.');
    }
    const prompt = mode === 'ask'
      ? 'Question: ' + question + '\nAnswer from the supplied market data.'
      : 'Review this contract for settlement risk and compare with verity_rules_v1. Return: summary, settlement_source, ambiguities [{issue, quote, why_it_matters}], scores {ambiguity, source, correlation} (1-3), agrees_with_rules_analyst (boolean), disagreement, research_to_close_gaps [strings], confidence (low|medium|high).';

    if (mode === 'forecast') {
      const fp = 'Estimate P(Yes) for the outcome named in the data. Use the price history (prices are 0-1 = implied probability), recent changes, volume and the settlement rules. Return probability_yes, confidence, reasoning (2-4 sentences), drivers [strings], risks [strings].';
      const opts = { system: FORECAST_SYSTEM, schema: forecastSchema, jsonSchema: forecastJsonSchema };
      let researchUsed = [];
      if (env.EXA_API_KEY && typeof market.title === 'string') {
        const q = (market.title + ' ' + (market.outcome || '')).slice(0, 200);
        const ex = await exaSearch(env, q, 30, 6);
        if (ex.ok) { researchUsed = ex.items.map(i => ({ title: i.title, link: i.link, source: i.source, published: i.published })); market.recent_research = ex.items.map(i => ({ title: i.title, source: i.source, published: i.published, highlights: i.highlights })); }
      }
      const [g, w] = await Promise.all([askGemini(env, 'forecast', fp, market, opts), askWorkersAI(env, 'forecast', fp, market, opts)]);
      const pack = (r, provider, fallbackModel) => {
        if (!r.ok) return { provider, ok: false, reason: r.reason || 'unavailable' };
        let result = null;
        try { result = JSON.parse(r.body.candidates[0].content.parts.map(p => p.text || '').join('')); } catch {}
        const p = Number(result?.probability_yes);
        if (!result || !(p >= 0 && p <= 1)) return { provider, ok: false, reason: 'bad_output' };
        return { provider, ok: true, model: r.body.modelVersion || fallbackModel, result };
      };
      const forecasts = [pack(g, 'google-gemini', env.GEMINI_MODEL), pack(w, 'workers-ai', env.BACKUP_MODEL)];
      if (!forecasts.some(f => f.ok)) return fail(502, 'Neither Google Gemini nor Workers AI could produce a forecast.');
      return Response.json({ mode: 'forecast', forecasts, research: researchUsed }, { headers });
    }
    const primary = await askGemini(env, mode, prompt, market);
    if (primary.ok) return Response.json(primary.body, { headers });
    const backup = await askWorkersAI(env, mode, prompt, market);
    if (backup.ok) return Response.json({ ...backup.body, fallbackReason: primary.reason }, { headers });
    return fail(primary.reason === 'quota' ? 429 : 502,
      primary.reason === 'quota' ? 'Google Gemini quota reached and the backup model is unavailable.' : 'Both Google Gemini and the backup model are unavailable.');
  },
};
