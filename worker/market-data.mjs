// Live public market data from the Gemini Exchange prediction-markets API (no key needed).
// The AI routes use it so the models read current prices and activity themselves instead of relying on
// what the page loaded or asking the visitor to describe the market. /market and /markets expose the
// same compact view to the voice agent's tools. Everything here is public data; responses are cached
// briefly at the edge so a busy page or a long call cannot hammer the upstream API.

export const GEMINI_EVENTS = 'https://api.gemini.com/v1/prediction-markets/events';
const TICKER = /^[A-Za-z0-9_-]{2,64}$/;
const EVENT_TTL = 30;   // seconds; prices move, so keep it short
const ACTIVE_TTL = 120; // the most-active list is a 50-event pull, so refresh it less often
const ACTIVE_PULL = 50;

export const validTicker = t => typeof t === 'string' && TICKER.test(t);

const num = v => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));

// Contract descriptions arrive as a rich-text tree; keep only the words.
function plain(node, out = []) {
  if (!node || typeof node !== 'object') return out;
  if (typeof node.value === 'string') out.push(node.value);
  if (Array.isArray(node.content)) for (const c of node.content) plain(c, out);
  return out;
}
const ruleText = (d, max) => {
  const t = (typeof d === 'string' ? d : plain(d).join(' ')).replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max - 1) + '…' : t;
};
const mid = c => {
  const b = num(c?.prices?.bestBid), a = num(c?.prices?.bestAsk);
  return b !== null && a !== null ? (a + b) / 2 : (b ?? a ?? num(c?.prices?.lastTradePrice) ?? -1);
};

/**
 * Reduces one Gemini event to what a model needs: prices, volume, expiry, settlement source and (optionally)
 * each contract's rule text. Contracts are ordered by implied probability, highest first.
 */
export function compactEvent(e, { contracts = 12, rules = true, ruleChars = 500, pin } = {}) {
  const list = Array.isArray(e?.contracts) ? [...e.contracts].sort((x, y) => mid(y) - mid(x)) : [];
  // The outcome the visitor is looking at always makes the cut, first in the list.
  const at = typeof pin === 'string' ? list.findIndex(c => c.label === pin) : -1;
  if (at > 0) list.unshift(...list.splice(at, 1));
  return {
    ticker: e?.ticker ?? null,
    title: e?.title ?? null,
    category: e?.category ?? null,
    status: e?.status ?? null,
    expiry: e?.expiryDate ?? null,
    volume_usd: num(e?.volume),
    volume_24h_usd: num(e?.volume24h),
    volume_change_24h_pct: num(e?.volumeDelta24hPct),
    settlement_source: e?.sourceDetails ?? e?.source ?? null,
    terms_pdf: e?.termsLink ?? null,
    contracts_total: list.length,
    contracts: list.slice(0, contracts).map(c => ({
      label: c.label ?? null,
      ticker: c.ticker ?? null,
      best_bid: num(c.prices?.bestBid),
      best_ask: num(c.prices?.bestAsk),
      last_trade: num(c.prices?.lastTradePrice),
      state: c.marketState ?? c.status ?? null,
      expiry: c.expiryDate ?? null,
      ...(rules ? { rule: ruleText(c.description, ruleChars) } : {}),
    })),
  };
}

async function upstream(url) {
  const r = await fetch(url, { signal: AbortSignal.timeout(6000), headers: { Accept: 'application/json', 'User-Agent': 'VerityResearch/1.0 (+https://verityresearch.us)' } });
  if (r.status === 404) return { ok: false, reason: 'not_found' };
  if (!r.ok) return { ok: false, reason: 'upstream_' + r.status };
  return { ok: true, json: await r.json() };
}

// Caches the compact result (small), not the raw upstream body (the active list is over a megabyte).
// The cache is best effort: a failed read falls through to Gemini, and a failed write still returns the data.
async function cached(key, ttl, build) {
  const cache = globalThis.caches?.default;
  const req = new Request('https://verity-cache.internal/' + key);
  if (cache) {
    try {
      const hit = await cache.match(req);
      if (hit) return { ok: true, data: await hit.json(), cache: 'HIT' };
    } catch { /* read failed: fetch fresh */ }
  }
  const res = await build();
  if (res.ok && cache) {
    try {
      await cache.put(req, new Response(JSON.stringify(res.data), { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'max-age=' + ttl } }));
    } catch { /* write failed: the fresh data is still good */ }
  }
  return { ...res, cache: 'MISS' };
}

/** One event by ticker, with rules. */
export function liveEvent(ticker, opts = {}) {
  if (!validTicker(ticker)) return Promise.resolve({ ok: false, reason: 'bad_ticker' });
  const rules = opts.rules !== false;
  const pin = typeof opts.pin === 'string' ? opts.pin.slice(0, 200) : undefined;
  return cached(`market-v1/${ticker.toUpperCase()}?rules=${rules ? 1 : 0}&pin=${encodeURIComponent(pin ?? '')}`, EVENT_TTL, async () => {
    try {
      const r = await upstream(`${GEMINI_EVENTS}/${encodeURIComponent(ticker)}`);
      if (!r.ok) return r;
      return { ok: true, data: { fetched_at: new Date().toISOString(), source: 'Gemini Exchange public API', event: compactEvent(r.json, { rules, pin }) } };
    } catch { return { ok: false, reason: 'unavailable' }; }
  });
}

/**
 * Active events, busiest first by 24-hour volume. `query` narrows by Gemini's own search.
 * Gemini's list is not ordered by 24-hour volume and has no sort option, and each page of 50 is about 2 MB, so this
 * ranks one page. The response says how many events were checked out of how many are open, so callers never
 * present a partial ranking as the whole market.
 */
export function activeEvents(query, limit = 8) {
  const q = typeof query === 'string' ? query.trim().slice(0, 80) : '';
  const n = Math.max(1, Math.min(10, Number(limit) || 8));
  return cached(`markets-v2/${n}?q=${encodeURIComponent(q.toLowerCase())}`, ACTIVE_TTL, async () => {
    try {
      const r = await upstream(`${GEMINI_EVENTS}?status=active&limit=${ACTIVE_PULL}${q ? '&search=' + encodeURIComponent(q) : ''}`);
      if (!r.ok) return r;
      const page = Array.isArray(r.json?.data) ? r.json.data : [];
      const checked = page.length;
      const total = Math.max(checked, Number(r.json?.pagination?.total) || checked);
      const complete = checked >= total;
      const events = page.filter(e => e?.status === 'active')
        .sort((a, b) => (num(b.volume24h) ?? 0) - (num(a.volume24h) ?? 0)).slice(0, n)
        .map(e => compactEvent(e, { contracts: 3, rules: false }));
      return { ok: true, data: {
        fetched_at: new Date().toISOString(), source: 'Gemini Exchange public API', query: q || null,
        order: complete ? 'volume_24h_usd, highest first' : 'volume_24h_usd, highest first, among the events checked only',
        ranked_from: { events_checked: checked, open_events_total: total, complete },
        ...(complete ? {} : { note: `Ranked within the first ${checked} of ${total} open events Gemini returned. A busier market outside them would not appear, so do not call any of these the busiest overall.` }),
        events,
      } };
    } catch { return { ok: false, reason: 'unavailable' }; }
  });
}
