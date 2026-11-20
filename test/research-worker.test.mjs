import assert from "node:assert/strict";
import { it } from "node:test";
import { createResearchWorker } from "../research-worker.mjs";

const host = "https://api.verityresearch.us";
const symbol = "GEMI-WXHIGH-SFO-2611200459-56TO57";
const request = (path, options) => new Request(host + path, options);
const fakeBinding = { VERITY_HISTORY_DB: { connectionString: "test-only" } };
const isoTime = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

function liveResearchResponse() {
  return new Response(JSON.stringify({
    data: [{
      ticker: "WXHIGH-BOS-2611210459",
      title: "Highest temperature in Boston on November 20, 2026?",
      status: "active",
      contracts: [{
        status: "active",
        instrumentSymbol: "GEMI-WXHIGH-BOS-2611210459-66TO67",
        description: "The Expiration Value shall be the maximum temperature for November 20, 2026 as documented by the NWS.",
        prices: { bestBid: "0.43", bestAsk: "0.50" },
        marketState: "open",
      }],
    }],
  }), { status: 200, headers: { "content-type": "application/json" } });
}

it("serves a live research brief and the GET-only contract", async () => {
  const worker = createResearchWorker(undefined, { fetchImpl: async () => liveResearchResponse() });
  const response = await worker.fetch(request("/v1/research"));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.mode, "live");
  assert.equal(body.live, true);
  assert.match(body.source, /^https:\/\/api\.gemini\.com\/v1\/prediction-markets\/events\?/);
  assert.match(body.fetchedAt, isoTime);
  assert.match(body.data[0].resolutionCriteria, /maximum temperature/);
  assert.equal(JSON.stringify(body).includes("NBA-2611200100-LAC-SAS-T"), false);
  assert.equal((await worker.fetch(request("/v1/research", { method: "POST" }))).status, 405);
});

it("reads history for the full instrument symbol through the private binding", async () => {
  const observations = [{ observedAtUtc: "2026-11-20T02:15:46Z", bestBid: "0.83", bestAsk: "0.97" }];
  const worker = createResearchWorker(async (connection, instrument) => {
    assert.equal(connection, "test-only");
    assert.equal(instrument, symbol);
    return observations;
  });
  const response = await worker.fetch(request(`/v1/market-history?instrument=${symbol}`), fakeBinding);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.mode, "stored");
  assert.equal(body.live, false);
  assert.equal(body.newestObservedAtUtc, observations[0].observedAtUtc);
  assert.equal(body.source, "gemini-exchange");
  assert.equal(body.venue, "gemini-exchange");
  assert.equal(body.instrument, symbol);
  assert.match(body.fetchedAt, isoTime);
  assert.deepEqual(body.observations, observations);
});

it("labels an empty stored history as stored rather than live", async () => {
  const worker = createResearchWorker(async () => []);
  const response = await worker.fetch(request(`/v1/market-history?instrument=${symbol}`), fakeBinding);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.mode, "stored");
  assert.equal(body.live, false);
  assert.equal(body.newestObservedAtUtc, null);
  assert.equal(body.source, "gemini-exchange");
  assert.match(body.fetchedAt, isoTime);
  assert.deepEqual(body.observations, []);
});

it("keeps public reads from writing and collects once per instrument window", async () => {
  const writes = [];
  const worker = createResearchWorker(async () => [], {
    fetchImpl: async () => liveResearchResponse(),
    recordObservations: async (connection, observations) => {
      writes.push({ connection, count: observations.length });
      return observations.length;
    },
  });
  const env = { VERITY_HISTORY_DB: { connectionString: "postgres://verity:secret@127.0.0.1:1/verity" } };
  for (let n = 0; n < 5; n += 1) {
    assert.equal((await worker.fetch(request("/v1/markets?limit=20"), env)).status, 200);
    assert.equal((await worker.fetch(request("/v1/research"), env)).status, 200);
  }
  assert.equal(writes.length, 0);
  await worker.scheduled({ cron: "*/2 * * * *" }, env, {});
  assert.equal(writes.length, 1);
  assert.equal(writes[0].count, 1);
  assert.equal(writes[0].connection.includes("secret"), true);
  await worker.scheduled({ cron: "*/2 * * * *" }, env, {});
  assert.equal(writes.length, 1);
});

it("logs an upstream failure without secrets and does not serve a cached brief", async () => {
  const lines = [];
  const original = console.error;
  console.error = (line) => lines.push(String(line));
  try {
    const worker = createResearchWorker(undefined, {
      fetchImpl: async (url, init) => {
        assert.equal(init.redirect, "manual");
        assert.equal(init.headers.Accept, "application/json");
        assert.ok(init.signal);
        throw new TypeError("Invalid redirect value, must be one of \"follow\" or \"manual\"");
      },
    });
    const response = await worker.fetch(request("/v1/markets/NOPE-0000000000-XX"));
    assert.equal(response.status, 502);
    const body = await response.json();
    assert.equal(body.error, "Market source unavailable");
    assert.equal(body.mode, "unavailable");
    assert.equal(body.live, false);
    assert.equal(JSON.stringify(body).includes("NBA-2611200100-LAC-SAS-T"), false);
    const logged = JSON.parse(lines[0]);
    assert.equal(logged.event, "gemini_upstream_error");
    assert.equal(logged.name, "TypeError");
    assert.match(logged.message, /manual/);
    assert.equal(logged.source, "https://api.gemini.com/v1/prediction-markets/events/NOPE-0000000000-XX");
    assert.equal(logged.status, null);
    assert.equal(JSON.stringify(logged).includes("postgres://"), false);
  } finally {
    console.error = original;
  }
});

it("rejects invalid input and returns a safe error when the history connection is unavailable", async () => {
  let calls = 0;
  const worker = createResearchWorker(async () => {
    calls++;
    throw new Error("internal database connection details");
  });
  assert.equal((await worker.fetch(request("/v1/market-history?instrument=%20"), fakeBinding)).status, 400);
  assert.equal((await worker.fetch(request("/v1/market-history?instrument=A&instrument=B"), fakeBinding)).status, 400);
  const valid = request(`/v1/market-history?instrument=${symbol}`);
  assert.equal((await worker.fetch(valid)).status, 503);
  assert.equal(calls, 0);
  const response = await worker.fetch(valid, fakeBinding);
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: "Stored quote history is temporarily unavailable" });
  assert.equal(calls, 1);
});
