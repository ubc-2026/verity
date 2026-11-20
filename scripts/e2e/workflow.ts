/**
 * Connected fixture workflow: market -> research and risk analysis (Python) ->
 * unsigned proposal -> durable buyer (policy, reservation, signing) -> merchant
 * over HTTP (deliverPaidRequest, stubbed settlement) -> buyer receipt
 * verification -> QuickNode webhook join -> reassessment (Python) -> overdue
 * alerts. Every component is the shipping code except three FIXTURE parts:
 * settlement (no chain), the QuickNode delivery (signed locally), and the Grok
 * routine (a contract model). No network beyond 127.0.0.1, no keys.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { keccak256, pad, toBytes, toHex, type Hex } from "viem";
import { feedTokenDigest, handleLedgerFeed, purchaseRecord, type FeedOptions } from "../../src/alerts/ledgerFeed.ts";
import { overdueEvents } from "../../src/alerts/overdue.ts";
import { ARC_TESTNET } from "../../src/payments/arc.ts";
import { BINDING_HEADER } from "../../src/payments/binding.ts";
import { catalogById } from "../../src/payments/catalog.ts";
import { acceptDelivery, RECEIPT_HEADER, receiptDigest, type SignedDeliveryReceiptV1 } from "../../src/payments/deliveryReceipt.ts";
import type { DeliverySettlementAdapter } from "../../src/payments/merchantDelivery.ts";
import { acceptPurchaseProposal } from "../../src/payments/proposal.ts";
import { BuyerService, type PurchaseResult } from "../../src/payments/purchase.ts";
import { parseQuote } from "../../src/payments/quote.ts";
import { encodePaymentHeader, handleMerchantHttp, listen, PAYMENT_HEADER } from "../../src/payments/server.ts";
import { MerchantService } from "../../src/payments/service.ts";
import { DEMO_POLICY, PaymentStore, type SpendingPolicy } from "../../src/payments/store.ts";
import { AUTHORIZATION_USED_TOPIC, ReconciliationLedger, TRANSFER_TOPIC } from "../../src/reconciliation/ledger.ts";
import { signQuickNodePayload } from "../../src/reconciliation/quicknodeSignature.ts";
import { runStreamFilter } from "../../src/reconciliation/runFilter.ts";
import { createQuickNodeWebhookHandler, QUICKNODE_WEBHOOK_PATH } from "../../src/reconciliation/webhook.ts";
import { DEMO_MERCHANT_CONFIG, DEMO_MERCHANT_SIGNER, DEMO_OWNER, DEMO_PAYER } from "../../test/fixtures/scenario.ts";
import { GrokRoutineModel } from "./grokRoutineModel.ts";

/** Analysis fixture clock (2026-11-18T01:00:00Z); payments run two minutes later. */
export const ANALYSIS_NOW = Date.UTC(2026, 10, 18, 1, 0, 0) / 1000;
const PAYMENT_START = ANALYSIS_NOW + 120;
const DELIVERY_WINDOW_SECONDS = 300;
// FIXTURE credentials for local servers only. They protect nothing real.
const SESSION_TOKEN = "fixture-buyer-session-token-0001";
const QUICKNODE_TOKEN = "fixture-quicknode-security-token";
const FEED_TOKEN = "fixture-ledger-feed-read-token-01";
const ROUTINE_KEY = "crsr_fixture_routine_key_0001";
const NYC = "fx-nyc-high-20261118";
const OKC = "fx-okc-moneyline-20261118";

// ---------------------------------------------------------------- Python analyst

export function findPython(analysisDir: string): string {
  const candidates = [
    process.env.VERITY_PYTHON,
    join(analysisDir, ".venv", "Scripts", "python.exe"),
    join(analysisDir, ".venv", "bin", "python"),
    "python3",
    "python",
  ].filter((c): c is string => Boolean(c));
  for (const candidate of candidates) {
    if (candidate.includes("/") || candidate.includes("\\")) {
      if (!existsSync(candidate)) continue;
    }
    const probe = spawnSync(candidate, ["-c", "import pydantic, sys; print(sys.version_info[:2] >= (3, 11))"], { encoding: "utf8" });
    if (probe.status === 0 && probe.stdout.trim() === "True") return candidate;
  }
  throw new Error("No Python 3.11+ with pydantic found. Set VERITY_PYTHON or create analysis/.venv (see analysis/README.md).");
}

export interface AnalyzeOutput {
  research: Record<string, unknown> & { coverage: { status: string }; price_trend: { status: string } };
  risk_analysis: RiskAnalysis;
  purchase_proposal: (Record<string, unknown> & { contract_id: string; evidence_gap_id: string; catalog_item_id: string; evidence_type: string; max_amount_base_units: string; proposal_id: string }) | null;
  no_purchase_reason: string | null;
  decision_log: string[];
}
export interface RiskAnalysis {
  contract_id: string;
  rating: { final_rating: string | null; raw_total: number | null };
  research_action: string;
  scores: Record<string, { score: number | null }>;
  evidence_gaps: { id: string; material: boolean; affects: string }[];
  citations: { id: string }[];
}
export interface Reassessment {
  status: "revised" | "unchanged" | "evidence_rejected";
  reason: string;
  revised: RiskAnalysis;
  changes: { finding: string; before: string | null; after: string | null; changed: boolean; reason: string }[];
  evidence_citation: { id: string; source: string; quote: string } | null;
}

export class Analyst {
  readonly python: string;
  readonly dir: string;
  constructor(python: string, dir: string) {
    this.python = python;
    this.dir = dir;
  }
  #run(args: string[], input?: string): unknown {
    const out = execFileSync(this.python, ["-m", "verity.cli", ...args], {
      cwd: this.dir,
      input,
      encoding: "utf8",
      env: { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1" },
      maxBuffer: 16 * 1024 * 1024,
    });
    return JSON.parse(out);
  }
  analyze(contract: string, scenario?: string, rail?: "arc-eip3009" | "circle-gateway-batched"): AnalyzeOutput {
    return this.#run([
      "analyze", "--contract", contract,
      ...(scenario ? ["--free-check-scenario", scenario] : []),
      ...(rail ? ["--rail", rail] : []),
    ]) as AnalyzeOutput;
  }
  /** Times evidence was handed to the analyst. Scenarios read it to prove rejected evidence never arrives. */
  reassessCalls = 0;
  reassess(riskAnalysis: RiskAnalysis, body: Uint8Array, provenance: Record<string, string>): Reassessment {
    this.reassessCalls += 1;
    const input = JSON.stringify({ risk_analysis: riskAnalysis, body_b64: Buffer.from(body).toString("base64"), provenance });
    return this.#run(["reassess"], input) as Reassessment;
  }
}

// ---------------------------------------------------------------- FIXTURE settlement and chain

/** Stub settlement: no chain. The tx hash is derived from the nonce and is not a real transaction. */
class StubSettlement implements DeliverySettlementAdapter {
  settleCalls = 0;
  resumeCalls = 0;
  /** Next settle reports a submitted transfer whose outcome is unknown (a timeout after broadcast). */
  timeoutAfterSubmitOnce = false;
  readonly settled: { txHash: Hex; payer: Hex; payTo: Hex; amount: bigint; nonce: Hex }[] = [];

  #tx(nonce: Hex): Hex {
    return keccak256(toBytes(`verity-fixture-tx|${nonce}`));
  }
  async settle(verified: Parameters<DeliverySettlementAdapter["settle"]>[0]) {
    this.settleCalls += 1;
    await new Promise((resolve) => setTimeout(resolve, 15)); // widen the window for concurrent copies
    const txHash = this.#tx(verified.nonce);
    if (this.timeoutAfterSubmitOnce) {
      this.timeoutAfterSubmitOnce = false;
      throw Object.assign(new Error("FIXTURE: receipt wait timed out after broadcast"), { txHash, pending: true });
    }
    this.settled.push({ txHash, payer: verified.request.payer, payTo: verified.request.payTo, amount: BigInt(verified.request.amount), nonce: verified.nonce });
    return { txHash };
  }
  async resume(verified: Parameters<DeliverySettlementAdapter["settle"]>[0], _auth: unknown, txHash: Hex) {
    this.resumeCalls += 1;
    this.settled.push({ txHash, payer: verified.request.payer, payTo: verified.request.payTo, amount: BigInt(verified.request.amount), nonce: verified.nonce });
    return { txHash };
  }
}

function blockEntry(s: StubSettlement["settled"][number], blockTimestamp: number) {
  const topic = (a: Hex) => pad(a.toLowerCase() as Hex, { size: 32 });
  return {
    block: { number: toHex(72781628), hash: keccak256(toBytes(`block|${s.txHash}`)), timestamp: toHex(blockTimestamp) },
    receipts: [
      {
        transactionHash: s.txHash,
        transactionIndex: "0x0",
        from: DEMO_MERCHANT_SIGNER.address,
        to: ARC_TESTNET.usdc,
        status: "0x1",
        logs: [
          { address: ARC_TESTNET.usdc, topics: [AUTHORIZATION_USED_TOPIC, topic(s.payer), s.nonce], data: "0x", logIndex: "0x1" },
          { address: ARC_TESTNET.usdc, topics: [TRANSFER_TOPIC, topic(s.payer), topic(s.payTo)], data: toHex(s.amount, { size: 32 }), logIndex: "0x2" },
        ],
      },
    ],
  };
}

// ---------------------------------------------------------------- one isolated world per scenario

const listenOn = (server: Server) =>
  new Promise<number>((resolve) => server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port)));

interface WorldOptions {
  policy?: SpendingPolicy;
  artifactUnavailable?: boolean;
  tamperResponses?: boolean;
}

async function createWorld(name: string, options: WorldOptions = {}) {
  let clock = PAYMENT_START;
  const now = () => clock;
  const store = new PaymentStore(":memory:", options.policy ?? DEMO_POLICY);
  const ledger = new ReconciliationLedger(store);
  const settlement = new StubSettlement();
  const merchant = new MerchantService({
    config: DEMO_MERCHANT_CONFIG,
    signer: DEMO_MERCHANT_SIGNER,
    settlement,
    now,
    sessions: { [SESSION_TOKEN]: "session-fixture-buyer" },
    ...(options.artifactUnavailable ? { artifact: () => undefined } : {}),
  });
  const merchantServer = await listen(merchant, { origin: DEMO_MERCHANT_CONFIG.origin });
  const quicknode = createServer((req, res) =>
    void createQuickNodeWebhookHandler({ securityToken: QUICKNODE_TOKEN, ledger, finalizedBlock: async () => 72781700n, now })(req, res),
  );
  const quicknodePort = await listenOn(quicknode);
  let saltCounter = 0;
  const buyer = new BuyerService({
    store,
    catalog: catalogById(),
    owner: DEMO_OWNER.address,
    signer: DEMO_PAYER,
    tokenDomain: ARC_TESTNET.usdcDomain,
    missionId: `mission-${name}`,
    saltSource: () => keccak256(toBytes(`verity-fixture-salt|${name}|${saltCounter++}`)),
  });
  const feedOptions: FeedOptions = { deliveryWindowSeconds: DELIVERY_WINDOW_SECONDS, merchantLabel: (_p, merchantId) => `${merchantId} (fixture)` };
  const feed = (purchaseId: string, token = FEED_TOKEN) =>
    handleLedgerFeed(
      { method: "GET", url: `/purchases/${encodeURIComponent(purchaseId)}`, authorization: `Bearer ${token}` },
      { tokenDigest: feedTokenDigest(FEED_TOKEN), db: store.database, options: feedOptions },
    );
  const routine = new GrokRoutineModel({ routineKey: ROUTINE_KEY, recheck: (id) => feed(id), now: () => new Date(clock * 1000) });
  const base = `http://127.0.0.1:${merchantServer.port}`;

  async function http(path: string, init: { headers: Record<string, string>; body: string }) {
    const response = await fetch(`${base}${path}`, { method: "POST", headers: init.headers, body: init.body });
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (options.tamperResponses && response.status === 200 && bytes.length > 0) {
      bytes[bytes.length - 3] = bytes[bytes.length - 3]! ^ 0x01; // FIXTURE: one byte altered in transit
    }
    return { status: response.status, headers: response.headers, bytes };
  }

  async function observeOnChain(): Promise<{ status: number; settlements: number }> {
    const last = settlement.settled.at(-1);
    if (!last) return { status: 0, settlements: ledger.counts().settlements };
    const payload = JSON.stringify(runStreamFilter({ data: [blockEntry(last, clock)], metadata: { stream_id: "fixture-stream" } }, [last.txHash]));
    const nonce = createHash("sha256").update(`${name}|${last.txHash}`).digest("hex").slice(0, 16);
    const response = await fetch(`http://127.0.0.1:${quicknodePort}${QUICKNODE_WEBHOOK_PATH}`, {
      method: "POST",
      headers: { "x-qn-nonce": nonce, "x-qn-timestamp": String(clock), "x-qn-signature": signQuickNodePayload(QUICKNODE_TOKEN, nonce, String(clock), payload), "stream-id": "fixture-stream" },
      body: payload,
    });
    await response.arrayBuffer();
    return { status: response.status, settlements: ledger.counts().settlements };
  }

  async function close() {
    await merchantServer.close();
    await new Promise<void>((resolve) => quicknode.close(() => resolve()));
    merchant.close();
    store.close();
  }

  return {
    name, store, ledger, settlement, merchant, buyer, routine, feed, feedOptions, http, observeOnChain, close,
    now, advance: (seconds: number) => (clock += seconds),
  };
}
type World = Awaited<ReturnType<typeof createWorld>>;

// ---------------------------------------------------------------- buyer steps

interface PaidAttempt {
  status: number;
  bytes: Uint8Array;
  receiptHeader: string | undefined;
  reason?: string;
}

async function requestQuoteAndAuthorize(world: World, proposal: NonNullable<AnalyzeOutput["purchase_proposal"]>) {
  const accepted = acceptPurchaseProposal(proposal, catalogById());
  // Buyer-generated purchase ID. Deterministic here so the fixture output is reproducible; production uses newPurchaseId().
  const purchaseId = `purchase-${createHash("sha256").update(`${world.name}|${proposal.proposal_id}`).digest("hex").slice(0, 24)}`;
  const quoteResponse = await world.http("/quotes", {
    headers: { authorization: `Bearer ${SESSION_TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({ catalogItemId: accepted.selection.catalogItemId, purchaseId, parameters: accepted.selection.parameters, catalogParameters: accepted.catalogParameters }),
  });
  const quoteJson = JSON.parse(new TextDecoder().decode(quoteResponse.bytes)) as { quote?: unknown; reason?: string };
  if (quoteResponse.status !== 402 || !quoteJson.quote) throw new Error(`quote refused: ${quoteResponse.status} ${quoteJson.reason}`);
  const quote = parseQuote(quoteJson.quote);
  const result = await world.buyer.purchase({ accepted, purchaseId, quote, now: world.now() });
  return { accepted, purchaseId, quote, result };
}

async function sendPaid(world: World, authorized: Extract<PurchaseResult, { status: "authorized" }>): Promise<PaidAttempt> {
  const { request, payment } = authorized;
  const response = await world.http(new URL(request.resourceUrl).pathname, {
    headers: {
      authorization: `Bearer ${SESSION_TOKEN}`,
      "content-type": "application/json",
      [BINDING_HEADER]: payment.bindingHeader,
      [PAYMENT_HEADER]: encodePaymentHeader({ chainId: request.chainId, token: request.token, authorization: payment.authorization }),
    },
    body: JSON.stringify(request.parameters),
  });
  if (response.status === 200) return { status: 200, bytes: response.bytes, receiptHeader: response.headers.get(RECEIPT_HEADER) ?? undefined };
  const json = JSON.parse(new TextDecoder().decode(response.bytes)) as { reason?: string };
  return { status: response.status, bytes: new Uint8Array(), receiptHeader: undefined, reason: json.reason };
}

/**
 * The same route function the server runs, called in-process. Two calls started in the same tick both
 * pass the "already recorded?" pre-check, so only the atomic claim keeps them from settling twice.
 */
async function sendPaidSameTick(world: World, authorized: Extract<PurchaseResult, { status: "authorized" }>, copies: number) {
  const { request, payment } = authorized;
  const headers = {
    authorization: `Bearer ${SESSION_TOKEN}`,
    [BINDING_HEADER.toLowerCase()]: payment.bindingHeader,
    [PAYMENT_HEADER.toLowerCase()]: encodePaymentHeader({ chainId: request.chainId, token: request.token, authorization: payment.authorization }),
  };
  const body = new TextEncoder().encode(JSON.stringify(request.parameters));
  const path = new URL(request.resourceUrl).pathname;
  const results = await Promise.all(
    Array.from({ length: copies }, () => handleMerchantHttp(world.merchant, "POST", path, headers, body, DEMO_MERCHANT_CONFIG.origin)),
  );
  return results.map((r) => ({ status: r.status, reason: r.body instanceof Uint8Array ? null : ((r.body as { reason?: string }).reason ?? null) }));
}

async function verifyAndRecord(world: World, purchaseId: string, attempt: PaidAttempt) {
  const stored = world.store.get(purchaseId)!;
  return acceptDelivery({
    response: { body: attempt.bytes, receiptHeader: attempt.receiptHeader },
    trusted: { merchantId: DEMO_MERCHANT_CONFIG.merchantId, receiptSigner: DEMO_MERCHANT_SIGNER.address },
    request: stored.request,
    store: world.ledger,
    now: world.now(),
  });
}

/**
 * The only route from a delivery to the analyst: evidence that failed buyer verification
 * returns null and is never passed to reassess. The paid and tampered scenarios share it.
 */
function reassessIfVerified(
  analyst: Analyst,
  analysis: AnalyzeOutput,
  proposal: NonNullable<AnalyzeOutput["purchase_proposal"]>,
  verdict: Awaited<ReturnType<typeof verifyAndRecord>>,
): Reassessment | null {
  if (!verdict.accepted) return null;
  return analyst.reassess(analysis.risk_analysis, verdict.body, provenance(proposal, verdict.receipt, verdict.body));
}

function provenance(proposal: NonNullable<AnalyzeOutput["purchase_proposal"]>, receipt: SignedDeliveryReceiptV1, body: Uint8Array) {
  const { signature: _sig, ...unsigned } = receipt;
  return {
    purchase_id: receipt.purchaseId,
    contract_id: proposal.contract_id,
    evidence_gap_id: proposal.evidence_gap_id,
    catalog_item_id: proposal.catalog_item_id,
    merchant_id: receipt.merchantId,
    request_hash: receipt.requestHash,
    content_hash_keccak256: receipt.contentHash,
    content_sha256: `0x${createHash("sha256").update(body).digest("hex")}`,
    receipt_digest: receiptDigest(unsigned),
    receipt_signer: receipt.merchant,
    tx_hash: receipt.txHash,
    verified_by: "verifyDelivery",
    data_label: "FIXTURE",
  };
}

export const summaryOf = (ra: RiskAnalysis) => ({
  final_rating: ra.rating.final_rating,
  raw_total: ra.rating.raw_total,
  research_action: ra.research_action,
  scores: Object.fromEntries(Object.entries(ra.scores).map(([k, v]) => [k, v.score])),
  open_material_gaps: ra.evidence_gaps.filter((g) => g.material && g.affects === "resolution_risk").map((g) => g.id),
});

// ---------------------------------------------------------------- scenarios

export interface ScenarioReport {
  name: string;
  market: string;
  freeCheckScenario: string | null;
  research: { coverage: unknown; priceTrend: unknown; normalizedMarket: unknown; citations: unknown };
  analysis: { original: ReturnType<typeof summaryOf>; proposal: unknown; noPurchaseReason: string | null };
  statuses: { payment: string; delivery: string; analysis: string; ledger: string | null };
  purchase: Record<string, unknown> | null;
  delivery: Record<string, unknown> | null;
  reassessment: { status: string; reason: string; revised: ReturnType<typeof summaryOf>; changes: Reassessment["changes"]; evidenceCitation: unknown } | null;
  alerts: Record<string, unknown> | null;
  checks: Record<string, boolean>;
}

function baseReport(name: string, market: string, scenario: string | null, analysis: AnalyzeOutput): ScenarioReport {
  return {
    name,
    market,
    freeCheckScenario: scenario,
    research: {
      normalizedMarket: analysis.research.market,
      coverage: analysis.research.coverage,
      priceTrend: analysis.research.price_trend,
      citations: analysis.research.citations,
    },
    analysis: { original: summaryOf(analysis.risk_analysis), proposal: analysis.purchase_proposal, noPurchaseReason: analysis.no_purchase_reason },
    statuses: { payment: "not_started", delivery: "not_requested", analysis: analysis.purchase_proposal ? "proposal" : "no_proposal", ledger: null },
    purchase: null,
    delivery: null,
    reassessment: null,
    alerts: null,
    checks: {},
  };
}

/** Full positive path: a specific risk finding triggers a purchase and the delivered evidence changes the assessment. */
async function positive(analyst: Analyst): Promise<ScenarioReport> {
  const scenario = "observed-2026-11-18";
  const analysis = analyst.analyze(NYC, scenario);
  const report = baseReport("positive_purchase_changes_assessment", NYC, scenario, analysis);
  const proposal = analysis.purchase_proposal;
  report.checks.proposal_emitted = proposal !== null && proposal.evidence_gap_id === "GAP-NYC-SETTLE";
  if (!proposal) return report;
  const world = await createWorld("positive");
  try {
    const { purchaseId, result } = await requestQuoteAndAuthorize(world, proposal);
    report.checks.policy_auto_approved = result.status === "authorized" && result.decision.decision === "allow";
    if (result.status !== "authorized") return report;
    report.purchase = {
      purchaseId,
      decision: result.decision,
      amountBaseUnits: result.request.amount,
      payTo: result.request.payTo,
      resourceUrl: result.request.resourceUrl,
      explanation: result.explanation,
      transport: "Verity custom paid transport (X-Verity-Binding, X-Verity-Payment, X-Verity-Receipt); not standard x402",
    };
    const attempt = await sendPaid(world, result);
    const accepted = await verifyAndRecord(world, purchaseId, attempt);
    report.checks.receipt_verified = accepted.accepted;
    const chain = await world.observeOnChain();
    report.checks.quicknode_join_reconciled = world.ledger.settlement(purchaseId)?.ledgerOutcome === "reconciled";
    const record = purchaseRecord(world.store.database, purchaseId, world.feedOptions);
    report.statuses = {
      payment: world.ledger.settlement(purchaseId) ? "settled_confirmed_by_quicknode" : "submitted_unconfirmed",
      delivery: accepted.accepted ? "verified" : `rejected:${accepted.code}`,
      analysis: "proposal",
      ledger: record?.ledgerStatus ?? null,
    };
    if (!accepted.accepted) return report;
    report.delivery = {
      httpStatus: attempt.status,
      receipt: { merchant: accepted.receipt.merchant, txHash: accepted.receipt.txHash, contentHash: accepted.receipt.contentHash, requestHash: accepted.receipt.requestHash },
      body: JSON.parse(new TextDecoder().decode(accepted.body)),
      settlementWebhookStatus: chain.status,
      settleCalls: world.settlement.settleCalls,
    };
    const reassessed = reassessIfVerified(analyst, analysis, proposal, accepted)!;
    report.reassessment = { status: reassessed.status, reason: reassessed.reason, revised: summaryOf(reassessed.revised), changes: reassessed.changes, evidenceCitation: reassessed.evidence_citation };
    report.statuses.analysis = reassessed.status;
    report.checks.assessment_revised = reassessed.status === "revised" && reassessed.changes.some((c) => c.finding === "scores.source" && c.changed);

    // Audit: a reconciled purchase produces no overdue event, and a forged event for it opens no card.
    world.advance(DELIVERY_WINDOW_SECONDS + 60);
    const events = overdueEvents(world.store.database, { now: world.now(), environment: "fixture", options: world.feedOptions });
    const forged = {
      schema: "verity.overdue_delivery.v1", eventId: "evt-forged", environment: "fixture", purchaseId, exceptionType: "paid_delivery_missing",
      ledgerStatus: "Paid, delivery missing", settlementConfirmed: true, txHash: accepted.receipt.txHash, amountBaseUnits: result.request.amount,
      merchantLabel: "forged", deliveryDeadlineUtc: "2026-11-18T01:00:00Z", emittedAtUtc: "2026-11-18T01:10:00Z",
    };
    const forgedResult = world.routine.receive(`Bearer ${ROUTINE_KEY}`, JSON.stringify(forged));
    report.alerts = { overdueEvents: events.length, forgedEventOutcome: forgedResult.outcome, cards: world.routine.cards.size };
    report.checks.reconciled_zero_alerts = events.length === 0 && world.routine.cards.size === 0 && forgedResult.outcome === "skipped_delivery_verified";
  } finally {
    await world.close();
  }
  return report;
}

async function noMaterialGap(analyst: Analyst): Promise<ScenarioReport> {
  const analysis = analyst.analyze(OKC);
  const report = baseReport("no_material_gap", OKC, null, analysis);
  report.statuses.payment = "not_started";
  report.checks.no_proposal = analysis.purchase_proposal === null && /no material resolution gap/.test(analysis.no_purchase_reason ?? "");
  report.checks.coverage_unavailable_explicit = analysis.research.coverage.status === "unavailable";
  return report;
}

async function freeEvidence(analyst: Analyst): Promise<ScenarioReport> {
  const scenario = "free-check-answers";
  const analysis = analyst.analyze(NYC, scenario);
  const report = baseReport("evidence_available_free", NYC, scenario, analysis);
  report.checks.no_proposal = analysis.purchase_proposal === null;
  report.checks.free_check_logged = analysis.decision_log.some((line) => /GAP-NYC-SETTLE/.test(line) && /free/i.test(line));
  return report;
}

async function budgetDenial(analyst: Analyst): Promise<ScenarioReport> {
  const scenario = "observed-2026-11-18";
  const analysis = analyst.analyze(NYC, scenario);
  const report = baseReport("budget_denial", NYC, scenario, analysis);
  const proposal = analysis.purchase_proposal!;
  const world = await createWorld("budget", { policy: { ...DEMO_POLICY, missionBudget: 40_000n } });
  try {
    const { purchaseId, result } = await requestQuoteAndAuthorize(world, proposal);
    report.purchase = { purchaseId, missionBudgetBaseUnits: "40000", quoteBaseUnits: proposal.max_amount_base_units, status: result.status, reason: result.status === "rejected" ? result.reason : null, explanation: result.explanation };
    report.statuses.payment = result.status === "rejected" ? "denied_by_policy" : result.status;
    report.checks.denied = result.status === "rejected" && /mission budget exceeded/.test(result.reason);
    report.checks.nothing_signed_or_settled = world.store.get(purchaseId) === undefined && world.settlement.settleCalls === 0;
  } finally {
    await world.close();
  }
  return report;
}

async function tamperedDelivery(analyst: Analyst): Promise<ScenarioReport> {
  const scenario = "observed-2026-11-18";
  const analysis = analyst.analyze(NYC, scenario);
  const report = baseReport("tampered_delivery", NYC, scenario, analysis);
  const proposal = analysis.purchase_proposal!;
  const world = await createWorld("tampered", { tamperResponses: true });
  try {
    const { purchaseId, result } = await requestQuoteAndAuthorize(world, proposal);
    if (result.status !== "authorized") throw new Error(`unexpected ${result.status}`);
    const attempt = await sendPaid(world, result);
    const verdict = await verifyAndRecord(world, purchaseId, attempt);
    const callsBefore = analyst.reassessCalls;
    const reassessed = reassessIfVerified(analyst, analysis, proposal, verdict);
    await world.observeOnChain();
    const record = purchaseRecord(world.store.database, purchaseId, world.feedOptions);
    report.statuses = {
      payment: world.ledger.settlement(purchaseId) ? "settled_confirmed_by_quicknode" : "submitted_unconfirmed",
      delivery: verdict.accepted ? "verified" : `rejected:${verdict.code}`,
      analysis: "not_reassessed (evidence rejected before the analyst)",
      ledger: record?.ledgerStatus ?? null,
    };
    report.delivery = { httpStatus: attempt.status, accepted: verdict.accepted, reason: verdict.accepted ? null : verdict.reason, settleCalls: world.settlement.settleCalls };
    report.checks.tamper_rejected = !verdict.accepted && verdict.code === "content_mismatch";
    report.checks.ledger_shows_paid_delivery_missing = record?.ledgerStatus === "Paid, delivery missing";
    report.checks.analyst_not_called = reassessed === null && analyst.reassessCalls === callsBefore;
  } finally {
    await world.close();
  }
  return report;
}

async function retryWithoutSecondSettlement(analyst: Analyst): Promise<ScenarioReport> {
  const scenario = "observed-2026-11-18";
  const analysis = analyst.analyze(NYC, scenario);
  const report = baseReport("retry_without_second_settlement", NYC, scenario, analysis);
  const proposal = analysis.purchase_proposal!;
  const world = await createWorld("retry");
  try {
    const { accepted: acceptedProposal, purchaseId, quote, result } = await requestQuoteAndAuthorize(world, proposal);
    if (result.status !== "authorized") throw new Error(`unexpected ${result.status}`);
    // Two identical copies of the first paid request race. The first to claim submits; its receipt wait
    // times out after broadcast, so the purchase is left `submitted` with a tx hash.
    world.settlement.timeoutAfterSubmitOnce = true;
    const [first, racing] = await sendPaidSameTick(world, result, 2);
    const signatureBefore = world.store.get(purchaseId)!.signature;
    // Buyer retry: the same purchase returns the stored authorization; nothing is signed again.
    const again = await world.buyer.purchase({ accepted: acceptedProposal, purchaseId, quote, now: world.now() });
    if (again.status !== "authorized") throw new Error(`unexpected ${again.status}`);
    const resumed = await sendPaid(world, again);
    const [copyA, copyB] = await Promise.all([sendPaid(world, again), sendPaid(world, again)]);
    const verdict = await verifyAndRecord(world, purchaseId, resumed);
    await world.observeOnChain();
    report.delivery = {
      racingFirstCopies: [
        { httpStatus: first!.status, reason: first!.reason },
        { httpStatus: racing!.status, reason: racing!.reason },
      ],
      retryAfterSubmission: { httpStatus: resumed.status },
      copiesAfterDelivery: [copyA.status, copyB.status],
      settleCalls: world.settlement.settleCalls,
      resumeCalls: world.settlement.resumeCalls,
      authorizationReused: again.payment.reused,
    };
    report.statuses = {
      payment: world.ledger.settlement(purchaseId) ? "settled_confirmed_by_quicknode" : "submitted_unconfirmed",
      delivery: verdict.accepted ? "verified" : `rejected:${verdict.code}`,
      analysis: "proposal",
      ledger: purchaseRecord(world.store.database, purchaseId, world.feedOptions)?.ledgerStatus ?? null,
    };
    report.checks.racing_copies_pending_not_settled_twice = first!.status === 202 && racing!.status === 202;
    report.checks.resumed_by_tx_hash = resumed.status === 200 && world.settlement.resumeCalls === 1;
    report.checks.settled_once = world.settlement.settleCalls === 1 && copyA.status === 200 && copyB.status === 200;
    report.checks.authorization_reused = again.payment.reused && world.store.get(purchaseId)!.signature === signatureBefore;
    report.checks.retry_delivery_verified = verdict.accepted;
  } finally {
    await world.close();
  }
  return report;
}

/** Isolated overdue fixture: paid and confirmed, never delivered. One card, even after an exact replay. */
async function overdueAlert(analyst: Analyst): Promise<ScenarioReport> {
  const scenario = "observed-2026-11-18";
  const analysis = analyst.analyze(NYC, scenario);
  const report = baseReport("overdue_delivery_alert", NYC, scenario, analysis);
  const proposal = analysis.purchase_proposal!;
  const world = await createWorld("overdue", { artifactUnavailable: true });
  try {
    const { purchaseId, result } = await requestQuoteAndAuthorize(world, proposal);
    if (result.status !== "authorized") throw new Error(`unexpected ${result.status}`);
    const attempt = await sendPaid(world, result);
    await world.observeOnChain();
    const beforeDeadline = overdueEvents(world.store.database, { now: world.now(), environment: "fixture", options: world.feedOptions });
    world.advance(DELIVERY_WINDOW_SECONDS + 1);
    const events = overdueEvents(world.store.database, { now: world.now(), environment: "fixture", options: world.feedOptions });
    const body = JSON.stringify(events[0]);
    const first = world.routine.receive(`Bearer ${ROUTINE_KEY}`, body);
    const replay = world.routine.receive(`Bearer ${ROUTINE_KEY}`, body);
    const wrongKey = world.routine.receive("Bearer crsr_wrong_key", body);
    const feedWithoutToken = world.feed(purchaseId, "not-the-feed-token-000");
    const card = world.routine.cards.values().next().value;
    report.statuses = { payment: "settled_confirmed_by_quicknode", delivery: `not_delivered (merchant ${attempt.status}: ${attempt.reason})`, analysis: "not_reassessed", ledger: purchaseRecord(world.store.database, purchaseId, world.feedOptions)?.ledgerStatus ?? null };
    report.alerts = {
      eventsBeforeDeadline: beforeDeadline.length,
      eventsAfterDeadline: events.length,
      event: events[0],
      first: first.outcome,
      exactReplay: replay.outcome,
      wrongRoutineKey: wrongKey.httpStatus,
      feedWithoutToken: feedWithoutToken.status,
      cardCount: world.routine.cards.size,
      card,
    };
    report.checks.no_event_before_deadline = beforeDeadline.length === 0;
    report.checks.one_event_after_deadline = events.length === 1;
    report.checks.one_card_after_exact_replay = first.outcome === "created" && replay.outcome === "duplicate" && world.routine.cards.size === 1;
    report.checks.wrong_key_rejected = wrongKey.httpStatus === 401 && world.routine.cards.size === 1;
    report.checks.feed_requires_token = feedWithoutToken.status === 401;
  } finally {
    await world.close();
  }
  return report;
}

export interface WorkflowReport {
  workflow: "verity-connected-fixture-workflow-v1";
  dataLabels: Record<string, string>;
  scenarios: ScenarioReport[];
  ok: boolean;
  failedChecks: string[];
}

export async function runWorkflow(options: { analysisDir: string; python?: string }): Promise<WorkflowReport> {
  const analyst = new Analyst(options.python ?? findPython(options.analysisDir), options.analysisDir);
  const scenarios: ScenarioReport[] = [];
  for (const run of [positive, noMaterialGap, freeEvidence, budgetDenial, tamperedDelivery, retryWithoutSecondSettlement, overdueAlert]) {
    scenarios.push(await run(analyst));
  }
  const failedChecks = scenarios.flatMap((s) => Object.entries(s.checks).filter(([, ok]) => !ok).map(([check]) => `${s.name}.${check}`));
  return {
    workflow: "verity-connected-fixture-workflow-v1",
    dataLabels: {
      market: "FIXTURE (workbook snapshot 2026-11-17; NYC terms excerpts read 2026-11-18)",
      freeCheck: "OBSERVED reading for observed-2026-11-18; FIXTURE assumption for free-check-answers",
      coverage: "CAPTURED Exa results (2026-11-18) for NYC; none for OKC",
      settlement: "FIXTURE stub: no chain, tx hashes are derived, not real",
      quicknode: "FIXTURE delivery signed locally with a fixture token, through the real webhook handler and stream filter",
      merchantEvidence: "FIXTURE document served by the demo merchant",
      grokRoutine: "FIXTURE contract model; the real Grok Bot routine was not called",
      voice: "ElevenLabs explanation text only; no audio requested",
    },
    scenarios,
    ok: failedChecks.length === 0,
    failedChecks,
  };
}
