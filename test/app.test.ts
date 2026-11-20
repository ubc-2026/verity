import assert from "node:assert/strict";
import { createServer, request as httpRequest, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { Analyst, findPython } from "../src/app/analyst.ts";
import { RunEngine } from "../src/app/engine.ts";
import { createAppHandler } from "../src/app/http.ts";
import { classifyQuote, LiveMarkets, loadFixtureMarkets, shapeLiveEvent, termsPdfInDescription, type Fetcher } from "../src/app/markets.ts";
import { catalogById } from "../src/payments/catalog.ts";
import { acceptPurchaseProposal } from "../src/payments/proposal.ts";
import { signQuickNodePayload, verifyQuickNodeSignature } from "../src/reconciliation/quicknodeSignature.ts";
import { DEMO_OTHER_SIGNER } from "./fixtures/scenario.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const analysisDir = join(root, "analysis");
const OPERATOR = "test-operator-token-0123456789abcdef";
const NYC = "fx-nyc-high-20261118";
const OKC = "fx-okc-moneyline-20261118";

let python: string | undefined;
let skip: string | false = false;
try {
  python = findPython(analysisDir);
} catch (error) {
  skip = `app tests need Python: ${(error as Error).message}`;
}

type Json = Record<string, any>;

describe("app server (fixture)", { skip }, () => {
  let server: Server;
  let base = "";
  let engine: RunEngine;

  before(async () => {
    engine = new RunEngine({ analyst: new Analyst(python!, analysisDir), markets: loadFixtureMarkets(analysisDir) });
    const handler = createAppHandler({ engine, live: new LiveMarkets({ fetch: async () => ({ ok: false, status: 503, text: async () => "" }) }), operatorToken: OPERATOR, gatewayEnabled: true, repoRoot: root });
    server = createServer((req, res) => void handler(req, res));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  after(async () => {
    await engine.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  async function call(method: string, path: string, body?: unknown, token: string | null = OPERATOR): Promise<{ status: number; json: Json }> {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, json: (await response.json()) as Json };
  }
  const run = async (marketId: string, scenario = "standard", token: string | null = OPERATOR) => (await call("POST", "/api/runs", { marketId, scenario }, token)).json;
  const step = async (id: string, action: string, body: unknown = {}) => call("POST", `/api/operator/runs/${id}/${action}`, body);
  async function stepOk(id: string, action: string, body: unknown = {}) {
    const result = await step(id, action, body);
    assert.equal(result.status, 200, `${action}: ${JSON.stringify(result.json.error)}`);
    return result.json;
  }

  function raw(method: string, path: string, headers: Record<string, string>, body?: string): Promise<{ status: number; json: Json }> {
    const port = (server.address() as AddressInfo).port;
    return new Promise((resolve, reject) => {
      const req = httpRequest({ hostname: "127.0.0.1", port, path, method, headers }, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          resolve({ status: res.statusCode ?? 0, json: text ? (JSON.parse(text) as Json) : {} });
        });
      });
      req.on("error", reject);
      if (body !== undefined) req.write(body);
      req.end();
    });
  }

  it("refuses any host other than loopback and any POST that is not JSON", async () => {
    const port = (server.address() as AddressInfo).port;
    const health = await raw("GET", "/api/health", { host: `localhost:${port}` });
    assert.equal(health.status, 200);
    assert.equal(health.json.ok, true);
    assert.equal((await raw("GET", "/api/health", { host: "evil.example" })).status, 403);
    assert.equal((await raw("GET", "/api/health", { host: `127.0.0.1:${port + 1}` })).status, 403);
    assert.equal((await raw("GET", "/api/health", { host: "127.0.0.1" })).status, 403);
    const plain = await raw("POST", "/api/runs", { host: `127.0.0.1:${port}`, "content-type": "text/plain" }, "{}");
    assert.equal(plain.status, 403);
    assert.match(plain.json.error, /application\/json/);
    const missing = await raw("POST", "/api/runs", { host: `127.0.0.1:${port}` }, "{}");
    assert.equal(missing.status, 403);
    const created = await raw(
      "POST",
      "/api/runs",
      { host: `127.0.0.1:${port}`, "content-type": "application/json; charset=utf-8", authorization: `Bearer ${OPERATOR}` },
      JSON.stringify({ marketId: NYC, scenario: "standard" }),
    );
    assert.equal(created.status, 201);
    assert.equal(created.json.label, "FIXTURE");
  });

  it("refuses inherited object keys as a scenario or rail", async () => {
    for (const key of ["toString", "constructor", "__proto__", "hasOwnProperty"]) {
      assert.equal((await call("POST", "/api/runs", { marketId: NYC, scenario: key }, null)).status, 400, `scenario ${key}`);
      assert.equal((await call("POST", "/api/runs", { marketId: NYC, rail: key }, null)).status, 400, `rail ${key}`);
    }
  });

  it("gives visitors a fixture run and refuses every operator step", async () => {
    const config = (await call("GET", "/api/config", undefined, null)).json;
    assert.equal(config.role, "visitor");
    assert.match(config.ledger, /in memory/);
    assert.equal(config.gateway.circleTransferId, "018a216c-72ff-454b-94b1-9bfbdf637f2d");
    assert.equal(config.gateway.arcBatchTx, "0x3b31471543ae1a1bd08cdff377c57b9586c1c8ae7bd759703b5a1c3ebcaebd82");
    const markets = (await call("GET", "/api/markets", undefined, null)).json.markets as Json[];
    const nyc = markets.find((m) => m.contractId === NYC)!;
    assert.equal(nyc.quote.state, "two_sided");
    assert.equal(nyc.quote.impliedProbability, "0.56");
    assert.equal(markets.find((m) => m.contractId === "fx-fed-dec-hike25-2026")!.quote.state, "missing");

    const view = await run(NYC, "standard", null);
    assert.equal(view.label, "FIXTURE");
    assert.equal(view.operator, undefined, "visitors never get the operator view");
    assert.equal(view.rating.final, "Medium");
    // The total is the analysis output, so assert how it is built rather than one scoring model's number.
    const known = (view.rating.scores as Json[]).filter((s) => s.score !== null);
    assert.equal(view.rating.total, known.reduce((sum: number, s: Json) => sum + (s.score as number), 0));
    assert.equal(view.decision.action, "buy");
    assert.ok(view.rule.citations.some((c: Json) => c.id === "C-NYC-4"));
    assert.ok(view.gaps.some((g: Json) => g.id === "GAP-NYC-SETTLE" && g.open));
    assert.ok(view.decision.freeChecks.some((line: string) => line.includes("inconclusive")));

    assert.equal((await call("POST", `/api/operator/runs/${view.id}/quote`, {}, null)).status, 401);
    assert.equal((await call("POST", `/api/operator/runs/${view.id}/quote`, {}, "wrong-token-wrong-token-wrong")).status, 401);
    assert.equal((await call("POST", "/api/operator/pause", { paused: true }, null)).status, 401);
    assert.equal((await call("GET", `/api/runs/${view.id}`, undefined, null)).json.operator, undefined);
  });

  it("happy path, delivery first: one settlement and one delivery across replays and a retry", async () => {
    const id = (await run(NYC)).id;
    let v = await stepOk(id, "quote");
    assert.equal(v.operator.quote.amount, "50000");
    v = await stepOk(id, "decide");
    assert.equal(v.states.policy.state, "allowed");
    assert.equal(v.states.policy.tier, "auto");
    assert.equal(v.operator.budget.held, "50000");
    assert.equal((await step(id, "reassess")).status, 409, "no reassessment before a verified delivery");
    v = await stepOk(id, "pay");
    assert.equal(v.operator.attempts[0].status, 200);
    v = await stepOk(id, "verify");
    assert.equal(v.states.delivery.state, "verified");
    assert.equal(v.states.settlement.state, "submitted_unconfirmed");
    assert.equal(v.states.reconciliation.state, "Delivered, payment unconfirmed");
    v = await stepOk(id, "webhook");
    assert.equal(v.states.settlement.state, "confirmed");
    assert.equal(v.states.reconciliation.state, "Reconciled");
    assert.equal(v.operator.budget.spent, "50000");
    assert.equal(v.operator.budget.held, "0");

    v = await stepOk(id, "webhook-replay");
    assert.equal(v.operator.webhooks.at(-1).duplicateEvent, true);
    assert.equal(v.operator.ledgerCounts.settlements, 1);
    v = await stepOk(id, "retry");
    assert.equal(v.operator.attempts.at(-1).status, 200);
    assert.equal(v.operator.attempts.at(-1).authorizationReused, true);
    assert.equal(v.operator.settleCalls, 1, "a retried payment never settles twice");
    v = await stepOk(id, "verify");
    assert.equal(v.operator.ledgerCounts.deliveries, 1);
    assert.equal(v.states.reconciliation.state, "Reconciled");

    v = await stepOk(id, "reassess");
    assert.equal(v.states.reassessment.state, "revised");
    // Verified settlement evidence lowers the total; the exact numbers belong to the scoring model.
    assert.ok(v.states.reassessment.after.total < v.states.reassessment.before.total);
    v = await stepOk(id, "advance", { seconds: 400 });
    v = await stepOk(id, "overdue");
    assert.equal(v.operator.incidentCards.length, 0, "a reconciled purchase opens no incident");
  });

  it("happy path, settlement observed first, then the delivery", async () => {
    const id = (await run(NYC)).id;
    for (const action of ["quote", "decide", "pay"]) await stepOk(id, action);
    let v = await stepOk(id, "webhook");
    assert.equal(v.states.settlement.state, "confirmed");
    assert.equal(v.states.reconciliation.state, "Paid, delivery missing");
    assert.equal(v.states.delivery.state, "received_unverified");
    v = await stepOk(id, "verify");
    assert.equal(v.states.reconciliation.state, "Reconciled");
    v = await stepOk(id, "webhook-replay");
    assert.equal(v.operator.ledgerCounts.settlements, 1);
    assert.equal(v.operator.settleCalls, 1);
  });

  it("refuses forged and stale QuickNode deliveries", async () => {
    const id = (await run(NYC)).id;
    for (const action of ["quote", "decide", "pay", "webhook"]) await stepOk(id, action);
    let v = await stepOk(id, "webhook-forged");
    assert.equal(v.operator.webhooks.at(-1).httpStatus, 401);
    v = await stepOk(id, "webhook-stale");
    assert.equal(v.operator.webhooks.at(-1).httpStatus, 401);
    assert.equal(v.operator.ledgerCounts.events, 1);
  });

  it("abstains when there is no material gap or a free source answers it", async () => {
    const okc = await run(OKC);
    assert.equal(okc.decision.action, "abstain");
    assert.ok(okc.decision.reason.length > 0, "an abstention says why");
    assert.equal((await step(okc.id, "quote")).status, 409);
    const free = await run(NYC, "free_answers");
    assert.equal(free.decision.action, "abstain");
    assert.match(free.decision.reason, /free/i);
  });

  it("owner approval: a wrong signer is refused, rejection releases the hold", async () => {
    const id = (await run(NYC, "approval")).id;
    await stepOk(id, "quote");
    let v = await stepOk(id, "decide");
    assert.equal(v.states.policy.state, "needs_owner_approval");
    assert.equal(v.states.approval.state, "requested");
    assert.equal(v.operator.budget.held, "50000", "an approval request holds its funds");
    const typed = v.operator.approvalRequest.typedData;
    const wrong = await DEMO_OTHER_SIGNER.signTypedData({
      ...typed,
      message: { ...typed.message, amount: BigInt(typed.message.amount), expiry: BigInt(typed.message.expiry) },
    });
    const refused = await step(id, "approve", { method: "wallet", signature: wrong });
    assert.equal(refused.status, 422);
    assert.match(refused.json.error, /does not match the enrolled wallet/);
    v = await stepOk(id, "reject", { reason: "not worth it" });
    assert.equal(v.states.approval.state, "rejected");
    assert.equal(v.operator.budget.held, "0");
    assert.equal(v.operator.budget.released, "50000");
    assert.equal((await step(id, "pay")).status, 409);
    assert.equal((await step(id, "approve", { method: "fixture-owner" })).status, 409);
  });

  it("owner approval: expiry releases the hold and approval is refused afterwards", async () => {
    const id = (await run(NYC, "approval")).id;
    await stepOk(id, "quote");
    await stepOk(id, "decide");
    const v = await stepOk(id, "advance", { seconds: 301 });
    assert.equal(v.states.approval.state, "expired");
    assert.equal(v.states.authorization.state, "expired");
    assert.equal(v.operator.budget.held, "0");
    assert.equal((await step(id, "approve", { method: "fixture-owner" })).status, 409);
  });

  it("owner approval: the enrolled owner's signature over this request authorizes it", async () => {
    const id = (await run(NYC, "approval")).id;
    await stepOk(id, "quote");
    await stepOk(id, "decide");
    let v = await stepOk(id, "approve", { method: "fixture-owner" });
    assert.equal(v.states.approval.state, "approved");
    assert.equal(v.states.authorization.state, "signed");
    v = await stepOk(id, "pay");
    v = await stepOk(id, "verify");
    assert.equal(v.states.delivery.state, "verified");
  });

  it("budget denial reserves nothing", async () => {
    const id = (await run(NYC, "budget")).id;
    await stepOk(id, "quote");
    const v = await stepOk(id, "decide");
    assert.equal(v.states.policy.state, "refused");
    assert.match(v.states.policy.reason, /mission budget exceeded/);
    assert.equal(v.operator.budget.held, "0");
    assert.equal((await step(id, "pay")).status, 409);
  });

  it("an expired quote is refused", async () => {
    const id = (await run(NYC)).id;
    await stepOk(id, "quote");
    await stepOk(id, "advance", { seconds: 700 });
    const v = await stepOk(id, "decide");
    assert.equal(v.states.policy.state, "refused");
    assert.match(v.states.policy.reason, /expired/);
  });

  it("receipt rejection: no reassessment, one overdue incident across replays", async () => {
    const id = (await run(NYC, "tampered")).id;
    for (const action of ["quote", "decide", "pay"]) await stepOk(id, action);
    let v = await stepOk(id, "verify");
    assert.equal(v.states.delivery.state, "rejected");
    assert.equal(v.states.delivery.code, "content_mismatch");
    assert.equal((await step(id, "reassess")).status, 409);
    v = await stepOk(id, "webhook");
    assert.equal(v.states.reconciliation.state, "Paid, delivery missing");
    v = await stepOk(id, "overdue");
    assert.equal(v.operator.incidentCards.length, 0, "no incident before the deadline");
    await stepOk(id, "advance", { seconds: 301 });
    v = await stepOk(id, "overdue");
    assert.equal(v.operator.incidents.at(-1).outcome, "created");
    v = await stepOk(id, "overdue-replay");
    assert.equal(v.operator.incidents.at(-1).outcome, "duplicate");
    assert.equal(v.operator.incidentCards.length, 1);
    assert.equal(v.operator.incidentCards[0].replayCount, 1);
  });

  it("the pause switch stops new decisions and submissions", async () => {
    const authorized = (await run(NYC)).id;
    await stepOk(authorized, "quote");
    await stepOk(authorized, "decide");
    assert.equal((await call("POST", "/api/operator/pause", { paused: true, reason: "test" })).status, 200);
    const paused = (await step(authorized, "pay"));
    assert.equal(paused.status, 409);
    assert.match(paused.json.error, /paused/);
    const fresh = (await run(NYC)).id;
    await stepOk(fresh, "quote");
    const v = await stepOk(fresh, "decide");
    assert.match(v.states.policy.reason, /paused/);
    assert.equal((await call("POST", "/api/operator/pause", { paused: false })).status, 200);
    await stepOk(authorized, "pay");
  });
});

describe("selected-contract binding", () => {
  it("refuses a proposal for a different contract than the one selected", () => {
    const proposal = {
      version: "verity-purchase-proposal-v1",
      proposal_id: "prop-1",
      contract_id: "fx-nyc-high-20261118",
      evidence_gap_id: "GAP-NYC-SETTLE",
      catalog_item_id: "cat-nws-cli-settlement-version-v1",
      evidence_type: "settlement_source_version",
      catalog_parameters: { station: "Central Park, NY (CLINYC)", date: "2026-11-18" },
      rationale: "test",
      max_amount_base_units: "50000",
      asset: "USDC",
      network_label: "arc-testnet",
      fixture_label: null,
      signed: false,
      created_at_utc: "2026-11-18T01:00:00Z",
    };
    assert.doesNotThrow(() => acceptPurchaseProposal(proposal, catalogById(), { expectedContractId: "fx-nyc-high-20261118" }));
    assert.throws(() => acceptPurchaseProposal(proposal, catalogById(), { expectedContractId: "fx-okc-moneyline-20261118" }), /not the selected contract/);
  });
});

describe("quote states", () => {
  const now = 1_800_000_000;
  const at = new Date(now * 1000).toISOString();
  const q = (bestBid: unknown, bestAsk: unknown, extra: Partial<Parameters<typeof classifyQuote>[0]> = {}) =>
    classifyQuote({ bestBid, bestAsk, observedAtUtc: at, now, staleAfterSeconds: 120, ...extra });
  it("labels two-sided, one-sided, missing, crossed, stale and closed quotes", () => {
    assert.deepEqual([q("0.54", "0.58").state, q("0.54", "0.58").impliedProbability], ["two_sided", "0.56"]);
    assert.equal(q("0.54", null).state, "one_sided_bid");
    assert.equal(q(null, "0.58").state, "one_sided_ask");
    assert.equal(q(null, null, { lastTradePrice: "0.15" }).state, "missing");
    assert.equal(q(null, null, { lastTradePrice: "0.15" }).impliedProbability, null);
    assert.equal(q("0.60", "0.58").state, "crossed");
    assert.equal(q("0.54", "0.58", { now: now + 121 }).state, "stale");
    assert.equal(q("0.54", "0.58", { open: false }).state, "closed");
    for (const state of [q("0.54", null), q("0.60", "0.58"), q("0.54", "0.58", { now: now + 121 })]) assert.equal(state.impliedProbability, null);
  });

  it("keeps the last live reading, marked stale, when a refresh fails", async () => {
    let clock = now;
    let up = true;
    const body = JSON.stringify({ data: [{ ticker: "WXHIGH-SFO", title: "SFO high", status: "active", contracts: [{ label: "56 to 57", status: "active", prices: { bestBid: "0.57", bestAsk: "0.72" } }, { label: "62 to 63", status: "active", prices: { lastTradePrice: "0.15" } }] }] });
    const fake: Fetcher = async () => (up ? { ok: true, status: 200, text: async () => body } : { ok: false, status: 500, text: async () => "" });
    const live = new LiveMarkets({ fetch: fake, now: () => clock, cacheSeconds: 30, staleAfterSeconds: 120 });
    const first = await live.snapshot(5);
    assert.equal(first.state, "ok");
    assert.equal(first.events[0]!.contracts[0]!.quote.state, "two_sided");
    assert.equal(first.events[0]!.contracts[1]!.quote.state, "missing");
    up = false;
    clock += 200;
    const second = await live.snapshot(5);
    assert.equal(second.state, "stale");
    assert.equal(second.events[0]!.contracts[0]!.quote.state, "stale");
    assert.equal(second.events[0]!.contracts[0]!.quote.impliedProbability, null);
    const none = await new LiveMarkets({ fetch: fake, now: () => clock }).snapshot(5);
    assert.equal(none.state, "unavailable");
    assert.deepEqual(none.events, []);
  });
});

describe("live Gemini events", () => {
  const PDF = "https://assets.gemini.com/predictions/terms_and_conditions/Weather.pdf";
  it("finds the terms PDF in a weather contract description when termsLink is empty", () => {
    assert.equal(termsPdfInDescription(`Settles per the [rules](${PDF}).`), PDF);
    assert.equal(termsPdfInDescription({ text: `see ${PDF} and ${PDF}` }), PDF, "one distinct link");
    assert.equal(termsPdfInDescription(`${PDF} or https://assets.gemini.com/predictions/terms_and_conditions/Other.pdf`), null, "two links are ambiguous");
    assert.equal(termsPdfInDescription("https://evil.example/terms_and_conditions/x.pdf"), null);
    assert.equal(termsPdfInDescription(undefined), null);
    const event = shapeLiveEvent({ ticker: "WXHIGH-SFO", status: "active", contracts: [{ label: "56 to 57", status: "active", description: `Rules: ${PDF}` }] }, 0, 0, 120);
    assert.equal(event.termsUrl, PDF);
    assert.equal(event.contracts[0]!.termsUrl, PDF);
    const direct = shapeLiveEvent({ ticker: "X", termsLink: "https://assets.gemini.com/t.pdf", contracts: [{ label: "a", termsAndConditionsUrl: "https://assets.gemini.com/c.pdf", description: PDF }] }, 0, 0, 120);
    assert.equal(direct.termsUrl, "https://assets.gemini.com/t.pdf");
    assert.equal(direct.contracts[0]!.termsUrl, "https://assets.gemini.com/c.pdf");
  });

  it("drops feed terms links that are not https on assets.gemini.com and prefers the active contract", () => {
    const other = "https://assets.gemini.com/predictions/terms_and_conditions/Old.pdf";
    const event = shapeLiveEvent({
      ticker: "X",
      termsLink: "javascript:alert(1)",
      contracts: [null, { label: "old", status: "settled", description: other }, { label: "new", status: "active", termsAndConditionsUrl: "https://evil.example/t.pdf", description: PDF }],
    }, 0, 0, 120);
    assert.equal(event.termsUrl, PDF, "event-level link comes from the active contract");
    assert.equal(event.contracts.length, 2, "a null contract is skipped");
    assert.equal(event.contracts[1]!.termsUrl, PDF, "an off-site link falls back to the description");
  });

  it("keeps the larger reading when two reads race", async () => {
    const events = Array.from({ length: 60 }, (_, i) => ({ ticker: `E${i}`, status: "active", contracts: [] }));
    const pending: Array<() => void> = [];
    const fake: Fetcher = (url) => new Promise((resolve) => {
      const limit = Number(new URL(url).searchParams.get("limit"));
      pending.push(() => resolve({ ok: true, status: 200, text: async () => JSON.stringify({ data: events.slice(0, limit) }) }));
    });
    const live = new LiveMarkets({ fetch: fake, now: () => 1_800_000_000 });
    const big = live.snapshot(50);
    const small = live.snapshot(5);
    pending[0]!();
    pending[1]!();
    assert.equal((await big).events.length, 50);
    assert.equal((await small).events.length, 5);
    assert.equal((await live.snapshot(50)).events.length, 50, "the smaller read did not replace the larger one");
  });

  it("does not refetch a failed larger limit on every request and says it is short", async () => {
    let calls = 0;
    let clock = 1_800_000_000;
    const events = Array.from({ length: 60 }, (_, i) => ({ ticker: `E${i}`, status: "active", contracts: [] }));
    const fake: Fetcher = async (url) => {
      calls += 1;
      const limit = Number(new URL(url).searchParams.get("limit"));
      if (limit > 5) return { ok: false, status: 503, text: async () => "" };
      return { ok: true, status: 200, text: async () => JSON.stringify({ data: events.slice(0, limit) }) };
    };
    const live = new LiveMarkets({ fetch: fake, now: () => clock });
    await live.snapshot(5);
    const first = await live.snapshot(50);
    assert.equal(first.events.length, 5);
    assert.match(first.note, /read for 50 failed: HTTP 503/);
    await live.snapshot(50);
    await live.snapshot(40);
    assert.equal(calls, 2, "no new read while backing off");
    clock += 31;
    await live.snapshot(50);
    assert.equal(calls, 3, "retries after cacheSeconds");
  });

  it("honours the requested limit and refetches when a larger one is asked for", async () => {
    const urls: string[] = [];
    const events = Array.from({ length: 60 }, (_, i) => ({ ticker: `E${i}`, status: "active", contracts: [] }));
    const fake: Fetcher = async (url) => {
      urls.push(url);
      const limit = Number(new URL(url).searchParams.get("limit"));
      return { ok: true, status: 200, text: async () => JSON.stringify({ data: events.slice(0, limit) }) };
    };
    const live = new LiveMarkets({ fetch: fake, now: () => 1_800_000_000 });
    const five = await live.snapshot(5);
    assert.equal(five.events.length, 5);
    assert.match(five.source, /limit=5$/);
    const fifty = await live.snapshot(50);
    assert.equal(fifty.events.length, 50);
    assert.match(fifty.source, /limit=50$/);
    const three = await live.snapshot(3);
    assert.equal(three.events.length, 3, "a smaller limit is served from the cache");
    assert.equal(urls.length, 2);
    await live.snapshot(1000);
    assert.match(urls.at(-1)!, /limit=100$/, "the limit is capped at 100");
  });
});

describe("QuickNode replay window", () => {
  it("accepts a fresh signature and refuses one outside the window", () => {
    const token = "fixture-quicknode-security-token";
    const payload = '{"matches":[]}';
    const sign = (ts: string) => ({ nonce: "n1", timestamp: ts, signature: signQuickNodePayload(token, "n1", ts, payload), payload });
    assert.equal(verifyQuickNodeSignature(token, sign("1800000000"), { now: 1_800_000_100, maxSkewSeconds: 300 }), true);
    assert.equal(verifyQuickNodeSignature(token, sign("1800000000000"), { now: 1_800_000_100, maxSkewSeconds: 300 }), true);
    assert.equal(verifyQuickNodeSignature(token, sign("1800000000"), { now: 1_800_000_400, maxSkewSeconds: 300 }), false);
    assert.equal(verifyQuickNodeSignature(token, sign("not-a-time"), { now: 1_800_000_000, maxSkewSeconds: 300 }), false);
    assert.equal(verifyQuickNodeSignature(token, sign("1800000000")), true, "no window: unchanged behaviour");
  });
});
