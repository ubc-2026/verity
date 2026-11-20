import assert from "node:assert/strict";
import { it } from "node:test";
import { createResearchWorker } from "../research-worker.mjs";

const host = "https://api.verityresearch.us";
const symbol = "GEMI-WXHIGH-SFO-2611200459-56TO57";
const request = (path, options) => new Request(host + path, options);
const fakeBinding = { VERITY_HISTORY_DB: { connectionString: "test-only" } };

it("keeps the research brief and the GET-only contract", async () => {
  const worker = createResearchWorker();
  const brief = await worker.fetch(request("/v1/research"));
  assert.equal(brief.status, 200);
  assert.ok((await brief.json()).data[0].resolutionCriteria);
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
  assert.deepEqual(await response.json(), { venue: "gemini-exchange", instrument: symbol, observations });
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
