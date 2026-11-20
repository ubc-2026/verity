import { readHyperdriveHistory, recordHyperdriveObservations, validInstrument } from "./cloudflare/public-history.mjs";

const events = "https://api.gemini.com/v1/prediction-markets/events";
const UPSTREAM_TIMEOUT_MS = 10_000;
const MAX_INSTRUMENTS = 2_000;
const QUOTES_PER_INSTRUMENT = 120;
const FRESH_MS = 60_000;
const RECORD_INTERVAL_MS = 60_000;
const COLLECT_LIMIT = 20;
const recentObservations = new Map();
const lastWrittenAt = new Map();
const loggedHistoryErrors = new Set();

function json(data, status = 200, extra = {}) {
  return Response.json(data, { status, headers: {
    "Access-Control-Allow-Origin": "*",
    "Cache-Control": status === 200 ? "public, max-age=30" : "no-store",
    ...extra
  } });
}

function safeMessage(error) {
  const message = error instanceof Error ? error.message : "upstream request failed";
  return message.replace(/postgres(?:ql)?:\/\/\S+/gi, "postgres://redacted").replace(/password=\S+/gi, "password=redacted").slice(0, 300);
}

function logUpstream(source, error, status) {
  console.error(JSON.stringify({
    event: "gemini_upstream_error",
    source,
    status: status ?? null,
    name: error instanceof Error ? error.name : "UpstreamError",
    message: safeMessage(error),
  }));
}

function logRecordError(error) {
  const message = safeMessage(error);
  if (loggedHistoryErrors.has(message)) return;
  loggedHistoryErrors.add(message);
  console.error(JSON.stringify({
    event: "market_history_record_error",
    name: error instanceof Error ? error.name : "Error",
    message,
  }));
}

function isEvent(value) {
  return Boolean(value) && typeof value === "object" && typeof value.ticker === "string";
}

function eventsIn(payload) {
  if (isEvent(payload) && Array.isArray(payload.contracts)) return [payload];
  if (payload && Array.isArray(payload.data)) return payload.data.filter((item) => isEvent(item));
  return [];
}

function plainText(value, depth = 0) {
  if (depth > 8 || value == null) return "";
  if (typeof value === "string") return value.trim();
  if (typeof value !== "object") return "";
  const parts = [];
  if (typeof value.value === "string") parts.push(value.value);
  for (const child of value.content || []) {
    const text = plainText(child, depth + 1);
    if (text) parts.push(text);
  }
  return parts.join(" ").replace(/\s+/g, " ").trim();
}

function quotePrice(value) {
  if (typeof value === "number" && Number.isFinite(value)) value = String(value);
  if (typeof value !== "string" || !value.trim()) return null;
  const text = value.trim();
  const number = Number(text);
  if (!Number.isFinite(number) || number < 0 || number > 1) return null;
  return text;
}

function marketStateOf(contract, event) {
  const state = String(contract?.marketState || event?.status || "unknown");
  return state === "open" || state === "closed" || state === "unknown" ? state : "unknown";
}

function outcomeLabel(contract, symbol) {
  const label = typeof contract?.label === "string" ? contract.label.trim() : "";
  return (label || symbol).slice(0, 180);
}

function observationsFrom(payload, fetchedAt) {
  const observations = [];
  for (const event of eventsIn(payload)) {
    for (const contract of event.contracts || []) {
      if (!validInstrument(contract?.instrumentSymbol)) continue;
      observations.push({
        instrument: contract.instrumentSymbol,
        outcomeLabel: outcomeLabel(contract, contract.instrumentSymbol),
        observedAtUtc: fetchedAt,
        timeBasis: "collector",
        bestBid: quotePrice(contract.prices?.bestBid),
        bestAsk: quotePrice(contract.prices?.bestAsk),
        marketState: marketStateOf(contract, event),
      });
      if (observations.length === 200) return observations;
    }
  }
  return observations;
}

function remember(observations) {
  for (const observation of observations) {
    const kept = recentObservations.get(observation.instrument) ?? [];
    if (!recentObservations.has(observation.instrument)) recentObservations.set(observation.instrument, kept);
    kept.push({
      observedAtUtc: observation.observedAtUtc,
      timeBasis: observation.timeBasis,
      bestBid: observation.bestBid,
      bestAsk: observation.bestAsk,
      marketState: observation.marketState,
    });
    if (kept.length > QUOTES_PER_INSTRUMENT) kept.splice(0, kept.length - QUOTES_PER_INSTRUMENT);
  }
  while (recentObservations.size > MAX_INSTRUMENTS) {
    const oldest = recentObservations.keys().next().value;
    recentObservations.delete(oldest);
  }
}

function observationsDue(observations, now = Date.now()) {
  const due = [];
  const seen = new Set();
  for (const observation of observations) {
    if (seen.has(observation.instrument)) continue;
    seen.add(observation.instrument);
    const previous = lastWrittenAt.get(observation.instrument);
    if (previous != null && now - previous < RECORD_INTERVAL_MS) continue;
    due.push(observation);
  }
  return due;
}

function markWritten(observations, now = Date.now()) {
  for (const observation of observations) lastWrittenAt.set(observation.instrument, now);
  while (lastWrittenAt.size > MAX_INSTRUMENTS) {
    const oldest = lastWrittenAt.keys().next().value;
    lastWrittenAt.delete(oldest);
  }
}

function remembered(instrument) {
  return (recentObservations.get(instrument) ?? []).map((observation) => ({ ...observation }));
}

function mergeObservations(stored, fresh) {
  const seen = new Set();
  const merged = [];
  for (const observation of [...stored, ...fresh]) {
    const key = [observation.observedAtUtc, observation.bestBid, observation.bestAsk, observation.marketState].join("\0");
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(observation);
  }
  merged.sort((left, right) => left.observedAtUtc < right.observedAtUtc ? -1 : left.observedAtUtc > right.observedAtUtc ? 1 : 0);
  return merged.slice(-120);
}

function track(ctx, pending) {
  if (typeof ctx?.waitUntil === "function") ctx.waitUntil(pending);
  else return pending;
}

async function fetchGemini(url, fetchImpl) {
  try {
    const response = await fetchImpl(url, {
      headers: { Accept: "application/json" },
      // Workers reject redirect:"error" before sending the request. "manual"
      // is the supported mode; a 3xx is an upstream failure, not a hop to follow.
      redirect: "manual",
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      cf: { cacheTtlByStatus: { "200-299": 30, "400-599": 0 } },
    });
    if (response.status >= 300 && response.status < 400) {
      logUpstream(url, new Error(`upstream redirect refused (${response.status})`), response.status);
      return { failure: true };
    }
    return { response };
  } catch (error) {
    logUpstream(url, error, null);
    return { failure: true };
  }
}

function upstreamFailure(source, fetchedAt) {
  return json({ error: "Market source unavailable", mode: "unavailable", live: false, source, fetchedAt }, 502);
}

function researchBrief(event, source, fetchedAt) {
  const contracts = Array.isArray(event.contracts) ? event.contracts : [];
  const contract = contracts.find((item) => item?.status === "active") || contracts[0] || {};
  const criteria = plainText(contract.description) || plainText(event.description) || event.title || event.ticker;
  return {
    ticker: event.ticker,
    title: event.title || event.ticker,
    status: event.status || null,
    researchDate: fetchedAt.slice(0, 10),
    instrumentSymbol: contract.instrumentSymbol || null,
    resolutionCriteria: criteria.slice(0, 2000),
    terms: contract.termsAndConditionsUrl || event.termsLink || null,
    source,
    quotes: contracts.slice(0, 20).map((item) => ({
      instrumentSymbol: item?.instrumentSymbol || null,
      label: item?.label || null,
      bestBid: quotePrice(item?.prices?.bestBid),
      bestAsk: quotePrice(item?.prices?.bestAsk),
      marketState: marketStateOf(item, event),
      status: item?.status || null,
    })),
  };
}

function researchFallback(source, fetchedAt) {
  return json({
    mode: "fallback",
    live: false,
    source,
    fetchedAt,
    data: [],
    error: "Market source unavailable",
  });
}

function newestTimestamp(observations) {
  let newest = null;
  let newestMs = -Infinity;
  for (const observation of observations) {
    const ms = Date.parse(observation.observedAtUtc);
    if (Number.isFinite(ms) && ms >= newestMs) {
      newestMs = ms;
      newest = observation.observedAtUtc;
    }
  }
  return newest;
}

function historyPayload(instrument, stored, fresh) {
  const observations = mergeObservations(stored, fresh);
  const now = Date.now();
  const freshEnough = fresh.some((observation) => {
    const observed = Date.parse(observation.observedAtUtc);
    return Number.isFinite(observed) && now - observed <= FRESH_MS;
  });
  return {
    mode: freshEnough ? "live" : "stored",
    live: freshEnough,
    newestObservedAtUtc: newestTimestamp(observations),
    source: "gemini-exchange",
    fetchedAt: new Date().toISOString(),
    venue: "gemini-exchange",
    instrument,
    observations,
  };
}

export function createResearchWorker(readHistory = readHyperdriveHistory, options = {}) {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const recordObservations = options.recordObservations ?? recordHyperdriveObservations;
  async function handleRequest(request, env = {}, ctx) {
    if (request.method !== "GET") return json({ error: "Use GET" }, 405, { Allow: "GET" });
    const { pathname, searchParams } = new URL(request.url);
    if (pathname === "/") return json({ name: "Verity Research API", version: 1,
      endpoints: ["/v1/markets", "/v1/markets/{eventTicker}", "/v1/market-history", "/v1/research"], source: "Gemini Exchange" });
    if (pathname === "/v1/research") {
      const source = new URL(events);
      source.searchParams.set("status", "active");
      source.searchParams.set("limit", "20");
      const fetchedAt = new Date().toISOString();
      const result = await fetchGemini(source.href, fetchImpl);
      if (result.failure || !result.response.ok) {
        if (result.response && !result.response.ok) logUpstream(source.href, new Error(`upstream status ${result.response.status}`), result.response.status);
        return researchFallback(source.href, fetchedAt);
      }
      let payload;
      try {
        payload = await result.response.json();
      } catch (error) {
        logUpstream(source.href, error, result.response.status);
        return researchFallback(source.href, fetchedAt);
      }
      const active = eventsIn(payload).filter((event) => event.status === "active");
      remember(observationsFrom({ data: active }, fetchedAt));
      return json({
        mode: "live",
        live: true,
        source: source.href,
        fetchedAt,
        data: active.map((event) => researchBrief(event, source.href, fetchedAt)),
      });
    }
    if (pathname === "/v1/market-history") {
      const instrument = searchParams.get("instrument");
      if (searchParams.getAll("instrument").length !== 1 || !validInstrument(instrument)) {
        return json({ error: "Use one valid full instrument symbol" }, 400);
      }
      const fresh = remembered(instrument);
      const connectionString = env.VERITY_HISTORY_DB?.connectionString;
      if (!connectionString) {
        if (fresh.length === 0) return json({ error: "Stored quote history is not configured" }, 503);
        return json(historyPayload(instrument, [], fresh));
      }
      try {
        const stored = await readHistory(connectionString, instrument);
        return json(historyPayload(instrument, stored, fresh));
      } catch {
        return json({ error: "Stored quote history is temporarily unavailable" }, 503);
      }
    }
    const match = /^\/v1\/markets(?:\/([A-Za-z0-9_-]{1,128}))?\/?$/.exec(pathname);
    if (!match) return json({ error: "Endpoint not found" }, 404);
    const source = new URL(match[1] ? events + "/" + match[1] : events);
    if (!match[1]) {
      const limit = Number(searchParams.get("limit") ?? 20);
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) return json({ error: "limit must be 1–100" }, 400);
      source.searchParams.set("limit", String(limit));
    }
    const fetchedAt = new Date().toISOString();
    const result = await fetchGemini(source.href, fetchImpl);
    if (result.failure) return upstreamFailure(source.href, fetchedAt);
    if (result.response.status === 404 && match[1]) return json({ error: "Market not found", source: source.href }, 404);
    if (!result.response.ok) {
      logUpstream(source.href, new Error(`upstream status ${result.response.status}`), result.response.status);
      return upstreamFailure(source.href, fetchedAt);
    }
    let payload;
    try {
      payload = await result.response.json();
    } catch (error) {
      logUpstream(source.href, error, result.response.status);
      return upstreamFailure(source.href, fetchedAt);
    }
    remember(observationsFrom(payload, fetchedAt));
    return json({ mode: "live", live: true, source: source.href, fetchedAt, data: payload });
  }

  async function handleScheduled(event, env = {}, ctx) {
    const connectionString = env?.VERITY_HISTORY_DB?.connectionString;
    if (!connectionString) return;
    const source = new URL(events);
    source.searchParams.set("status", "active");
    source.searchParams.set("limit", String(COLLECT_LIMIT));
    const fetchedAt = new Date().toISOString();
    const result = await fetchGemini(source.href, fetchImpl);
    if (result.failure || !result.response.ok) {
      if (result.response && !result.response.ok) logUpstream(source.href, new Error(`upstream status ${result.response.status}`), result.response.status);
      return;
    }
    let payload;
    try {
      payload = await result.response.json();
    } catch (error) {
      logUpstream(source.href, error, result.response.status);
      return;
    }
    const active = eventsIn(payload).filter((item) => item.status === "active").slice(0, COLLECT_LIMIT);
    const due = observationsDue(observationsFrom({ data: active }, fetchedAt));
    if (due.length === 0) return;
    markWritten(due);
    console.error(JSON.stringify({ event: "market_history_collect", instruments: due.length, batched: true }));
    await track(ctx, recordObservations(connectionString, due).catch((error) => logRecordError(error)));
  }

  return { fetch: handleRequest, scheduled: handleScheduled };
}

export default createResearchWorker();
