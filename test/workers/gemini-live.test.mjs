import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { after, before, it } from "node:test";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";
import { Miniflare } from "miniflare";

// Node's fetch accepts redirect:"error", so these tests run the Worker inside
// workerd. On that runtime the old option throws before any request is sent.
const root = fileURLToPath(new URL("../..", import.meta.url));
const bundleDir = path.join(root, ".mf");
const host = "https://api.verityresearch.us";
const gemini = "https://api.gemini.com/v1/prediction-markets/events";
const settledTicker = "NBA-2611200100-LAC-SAS-T";
const isoTime = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

const liveEvent = {
  ticker: "WXHIGH-BOS-2611210459",
  title: "Highest temperature in Boston on November 20, 2026?",
  status: "active",
  termsLink: "https://assets.gemini.com/predictions/terms.pdf",
  contracts: [{
    label: "66°F to 67°F",
    status: "active",
    instrumentSymbol: "GEMI-WXHIGH-BOS-2611210459-66TO67",
    marketState: "open",
    description: "The Expiration Value shall be the maximum temperature for November 20, 2026 as documented by the NWS.",
    prices: { bestBid: "0.43", bestAsk: "0.50" },
  }],
};

let worker;
let upstream;
const calls = [];
const logs = [];
const originalError = console.error;

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function strip(value) {
  return String(value).replace(/\u001b\[[0-9;]*m/g, "");
}

before(async () => {
  const built = await esbuild.build({
    absWorkingDir: root,
    entryPoints: [path.join(root, "research-worker.mjs")],
    bundle: true,
    format: "esm",
    platform: "neutral",
    conditions: ["workerd", "worker", "browser"],
    target: "esnext",
    write: false,
    external: [
      "cloudflare:*", "node:*", "assert", "async_hooks", "buffer", "crypto",
      "diagnostics_channel", "dns", "events", "fs", "http", "https", "net",
      "os", "path", "perf_hooks", "stream", "string_decoder", "tls", "util", "zlib",
    ],
  });
  await mkdir(bundleDir, { recursive: true });
  await writeFile(path.join(bundleDir, "worker.mjs"), built.outputFiles[0].text);
  console.error = (...args) => logs.push(args.map(strip).join(" "));
  worker = new Miniflare({
    rootPath: bundleDir,
    modulesRoot: bundleDir,
    modules: true,
    scriptPath: "worker.mjs",
    compatibilityDate: "2026-01-01",
    compatibilityFlags: ["nodejs_compat"],
    outboundService(request) {
      calls.push(request.url);
      return upstream(request);
    },
  });
});

after(async () => {
  console.error = originalError;
  await worker?.dispose();
});

async function get(pathname) {
  calls.length = 0;
  logs.length = 0;
  const response = await worker.dispatchFetch(host + pathname);
  const body = await response.json();
  await new Promise((resolve) => setTimeout(resolve, 50));
  return { response, body, calls: [...calls], logs: [...logs] };
}

it("returns live Gemini markets from inside the Workers runtime", async () => {
  upstream = () => jsonResponse({ data: [liveEvent], pagination: { total: 1 } });
  const { response, body, calls: sent } = await get("/v1/markets?limit=20");
  assert.equal(response.status, 200);
  assert.deepEqual(sent, [`${gemini}?limit=20`]);
  assert.equal(body.mode, "live");
  assert.equal(body.live, true);
  assert.equal(body.source, `${gemini}?limit=20`);
  assert.match(body.fetchedAt, isoTime);
  assert.equal(body.data.data[0].ticker, liveEvent.ticker);
  assert.equal(JSON.stringify(body).includes(settledTicker), false);
});

it("returns one live event and maps an upstream 404 to 404", async () => {
  upstream = (request) => request.url.endsWith("/NOPE-0000000000-XX")
    ? jsonResponse({ error: "not found" }, 404)
    : jsonResponse(liveEvent);
  const found = await get("/v1/markets/WXHIGH-BOS-2611210459");
  assert.equal(found.response.status, 200);
  assert.deepEqual(found.calls, [`${gemini}/WXHIGH-BOS-2611210459`]);
  assert.equal(found.body.mode, "live");
  assert.equal(found.body.live, true);
  assert.equal(found.body.source, `${gemini}/WXHIGH-BOS-2611210459`);
  assert.match(found.body.fetchedAt, isoTime);
  assert.equal(found.body.data.ticker, liveEvent.ticker);

  const missing = await get("/v1/markets/NOPE-0000000000-XX");
  assert.equal(missing.response.status, 404);
  assert.equal(missing.body.error, "Market not found");
  assert.equal(missing.body.error === "Market source unavailable", false);
  assert.deepEqual(missing.calls, [`${gemini}/NOPE-0000000000-XX`]);
});

it("returns an explicit 502 when Gemini fails and does not serve the settled brief", async () => {
  upstream = () => jsonResponse({ error: "unavailable" }, 503);
  const list = await get("/v1/markets?limit=20");
  assert.equal(list.response.status, 502);
  assert.equal(list.body.error, "Market source unavailable");
  assert.equal(list.body.mode, "unavailable");
  assert.equal(list.body.live, false);
  assert.equal(list.body.source, `${gemini}?limit=20`);
  assert.match(list.body.fetchedAt, isoTime);
  assert.equal(JSON.stringify(list.body).includes(settledTicker), false);
  assert.equal(list.logs.some((line) => line.includes("gemini_upstream_error") && line.includes(`${gemini}?limit=20`)), true);
  assert.equal(list.logs.some((line) => /postgres:\/\/|connectionString|password/i.test(line)), false);

  upstream = () => jsonResponse(liveEvent);
  const settled = await get(`/v1/markets/${settledTicker}`);
  upstream = () => { throw new Error("connection reset"); };
  const failedSettled = await get(`/v1/markets/${settledTicker}`);
  assert.equal(settled.response.status, 200);
  assert.equal(failedSettled.response.status, 502);
  assert.equal(failedSettled.body.live, false);
  assert.equal(Object.hasOwn(failedSettled.body, "data"), false);
  assert.equal(JSON.stringify(failedSettled.body).includes("Los Angeles C vs San Antonio"), false);
  assert.equal(JSON.stringify(failedSettled.body).includes("GEMI-NBA-2611200100-LAC-SAS-T-O231"), false);
  assert.equal(failedSettled.logs.some((line) => line.includes("gemini_upstream_error") && line.includes(`${gemini}/${settledTicker}`)), true);
});

it("refuses an upstream redirect instead of following it", async () => {
  upstream = () => new Response(null, { status: 302, headers: { Location: "https://evil.example/markets" } });
  const { response, body, calls: sent } = await get("/v1/markets/WXHIGH-BOS-2611210459");
  assert.equal(response.status, 502);
  assert.equal(body.live, false);
  assert.deepEqual(sent, [`${gemini}/WXHIGH-BOS-2611210459`]);
});

it("builds research from live active markets and labels an outage as fallback", async () => {
  upstream = () => jsonResponse({
    data: [liveEvent, { ...liveEvent, ticker: settledTicker, status: "settled", title: "Settled game" }],
    pagination: { total: 2 },
  });
  const live = await get("/v1/research");
  assert.equal(live.response.status, 200);
  assert.deepEqual(live.calls, [`${gemini}?status=active&limit=20`]);
  assert.equal(live.body.mode, "live");
  assert.equal(live.body.live, true);
  assert.equal(live.body.source, `${gemini}?status=active&limit=20`);
  assert.match(live.body.fetchedAt, isoTime);
  assert.equal(live.body.data.length, 1);
  assert.equal(live.body.data[0].ticker, liveEvent.ticker);
  assert.match(live.body.data[0].resolutionCriteria, /maximum temperature/);
  assert.equal(JSON.stringify(live.body).includes(settledTicker), false);

  upstream = () => jsonResponse({ error: "down" }, 500);
  const fallback = await get("/v1/research");
  assert.equal(fallback.response.status, 200);
  assert.equal(fallback.body.mode, "fallback");
  assert.equal(fallback.body.live, false);
  assert.equal(fallback.body.error, "Market source unavailable");
  assert.deepEqual(fallback.body.data, []);
  assert.equal(fallback.body.source, `${gemini}?status=active&limit=20`);
  assert.match(fallback.body.fetchedAt, isoTime);
  assert.equal(JSON.stringify(fallback.body).includes(settledTicker), false);
});

it("records a live observation when a market is fetched and declares history mode", async () => {
  const instrument = "GEMI-TEST-LIVE-1";
  upstream = () => jsonResponse({
    ticker: "TEST-LIVE-1",
    title: "Test market",
    status: "active",
    contracts: [{
      status: "active",
      instrumentSymbol: instrument,
      marketState: "open",
      description: "Resolves from the live feed.",
      prices: { bestBid: "0.25", bestAsk: "0.30" },
    }],
  });
  const market = await get("/v1/markets/TEST-LIVE-1");
  assert.equal(market.response.status, 200);
  assert.equal(market.body.mode, "live");

  const history = await get(`/v1/market-history?instrument=${instrument}`);
  assert.equal(history.response.status, 200);
  assert.equal(history.calls.length, 0);
  assert.equal(history.body.mode, "live");
  assert.equal(history.body.live, true);
  assert.equal(history.body.newestObservedAtUtc, history.body.observations[0].observedAtUtc);
  assert.equal(history.body.source, "gemini-exchange");
  assert.equal(history.body.venue, "gemini-exchange");
  assert.equal(history.body.instrument, instrument);
  assert.match(history.body.fetchedAt, isoTime);
  assert.equal(history.body.observations.length, 1);
  assert.equal(history.body.observations[0].bestBid, "0.25");
  assert.equal(history.body.observations[0].bestAsk, "0.30");
  assert.equal(history.body.observations[0].marketState, "open");
  assert.equal(history.body.observations[0].timeBasis, "worker-fetch");
  assert.match(history.body.observations[0].observedAtUtc, isoTime);
});

async function bundleWorker(entry, filename) {
  const built = await esbuild.build({
    absWorkingDir: root,
    entryPoints: [path.join(root, entry)],
    bundle: true,
    format: "esm",
    platform: "neutral",
    conditions: ["workerd", "worker", "browser"],
    target: "esnext",
    write: false,
    external: [
      "cloudflare:*", "node:*", "assert", "async_hooks", "buffer", "crypto",
      "diagnostics_channel", "dns", "events", "fs", "http", "https", "net",
      "os", "path", "perf_hooks", "stream", "string_decoder", "tls", "util", "zlib",
    ],
  });
  await mkdir(bundleDir, { recursive: true });
  const file = path.join(bundleDir, filename);
  await writeFile(file, built.outputFiles[0].text);
  return file;
}

it("does not write on public reads and collects one batch from the schedule", async () => {
  await bundleWorker("research-worker.mjs", "collector.mjs");
  const seen = [];
  const collector = new Miniflare({
    rootPath: bundleDir,
    modulesRoot: bundleDir,
    modules: true,
    scriptPath: "collector.mjs",
    compatibilityDate: "2026-01-01",
    compatibilityFlags: ["nodejs_compat"],
    unsafeTriggerHandlers: true,
    hyperdrives: {
      VERITY_HISTORY_DB: "postgres://verity:secret@127.0.0.1:1/verity?sslmode=disable",
    },
    outboundService() {
      seen.push("gemini");
      return jsonResponse({
        data: [{
          ticker: "COLLECT-1",
          status: "active",
          contracts: [
            { status: "active", instrumentSymbol: "GEMI-COLLECT-A", marketState: "open", prices: { bestBid: "0.11", bestAsk: "0.12" } },
            { status: "active", instrumentSymbol: "GEMI-COLLECT-B", marketState: "open", prices: { bestBid: "0.21", bestAsk: "0.22" } },
          ],
        }],
        pagination: { total: 1 },
      });
    },
  });
  try {
    logs.length = 0;
    for (let n = 0; n < 8; n += 1) {
      const response = await collector.dispatchFetch(`${host}/v1/markets?limit=20`);
      assert.equal(response.status, 200);
      await response.arrayBuffer();
      const detail = await collector.dispatchFetch(`${host}/v1/markets/COLLECT-1`);
      assert.equal(detail.status, 200);
      await detail.arrayBuffer();
      const research = await collector.dispatchFetch(`${host}/v1/research`);
      assert.equal(research.status, 200);
      await research.arrayBuffer();
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
    const duringReads = logs.filter((line) => line.includes("market_history_collect") || line.includes("market_history_record_error"));
    assert.deepEqual(duringReads, []);
    assert.equal(seen.length, 24);

    logs.length = 0;
    const first = await collector.dispatchFetch("https://api.verityresearch.us/cdn-cgi/handler/scheduled", { method: "POST" });
    assert.equal(first.status, 200);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const collects = logs.filter((line) => line.includes("market_history_collect"));
    assert.equal(collects.length, 1);
    const recorded = JSON.parse(collects[0].slice(collects[0].indexOf("{")));
    assert.equal(recorded.batched, true);
    assert.equal(recorded.instruments, 2);
    assert.equal(collects[0].includes("secret"), false);

    logs.length = 0;
    const second = await collector.dispatchFetch("https://api.verityresearch.us/cdn-cgi/handler/scheduled", { method: "POST" });
    assert.equal(second.status, 200);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(logs.some((line) => line.includes("market_history_collect")), false);
  } finally {
    await collector.dispose();
  }
});

it("labels database history as stored and keeps only fresh isolate observations live", async () => {
  await bundleWorker("test/workers/history-label-harness.mjs", "history-label.mjs");
  const labeler = new Miniflare({
    rootPath: bundleDir,
    modulesRoot: bundleDir,
    modules: true,
    scriptPath: "history-label.mjs",
    compatibilityDate: "2026-01-01",
    compatibilityFlags: ["nodejs_compat"],
    outboundService: () => jsonResponse({}),
  });
  try {
    const response = await labeler.dispatchFetch(`${host}/v1/market-history?instrument=GEMI-WXHIGH-SFO-2611200459-56TO57`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.mode, "stored");
    assert.equal(body.live, false);
    assert.equal(body.newestObservedAtUtc, "2026-11-20T02:15:46.000Z");
    assert.equal(body.observations.length, 1);
    assert.equal(body.observations[0].bestBid, "0.83");
  } finally {
    await labeler.dispose();
  }
});

it("evicts the oldest in-memory instrument after 2000", async () => {
  for (let n = 0; n < 2001; n += 1) {
    const ticker = `CAP${String(n).padStart(4, "0")}`;
    upstream = () => jsonResponse({
      ticker,
      status: "active",
      contracts: [{
        status: "active",
        instrumentSymbol: `GEMI-${ticker}`,
        marketState: "open",
        prices: { bestBid: "0.10", bestAsk: "0.20" },
      }],
    });
    const response = await worker.dispatchFetch(`${host}/v1/markets/${ticker}`);
    assert.equal(response.status, 200);
    await response.arrayBuffer();
  }
  const oldest = await worker.dispatchFetch(`${host}/v1/market-history?instrument=GEMI-CAP0000`);
  assert.equal(oldest.status, 503);
  await oldest.arrayBuffer();
  const newest = await worker.dispatchFetch(`${host}/v1/market-history?instrument=GEMI-CAP2000`);
  assert.equal(newest.status, 200);
  const body = await newest.json();
  assert.equal(body.mode, "live");
  assert.equal(body.live, true);
  assert.equal(body.instrument, "GEMI-CAP2000");
});
