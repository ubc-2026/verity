/**
 * Connected fixture loop for the Circle Gateway (nanopayments) rail:
 * weather contract -> rule quote + one evidence gap -> free sources -> unsigned
 * proposal (0.001 USDC item) -> durable buyer (explicit nanopayment policy,
 * reservation, request binding, stable purchase ID) -> merchant HTTP route ->
 * deliverGatewayPaidRequest (Gateway verify + settle, MOCKED) -> V2 receipt bound
 * to Circle's transfer ID -> buyer receipt + byte verification -> Gateway
 * acceptance and batch settlement recorded separately -> reassessment.
 */
import { createHash } from "node:crypto";
import { keccak256, toBytes, type Hex } from "viem";
import { ARC_TESTNET } from "../../src/payments/arc.ts";
import { BINDING_HEADER } from "../../src/payments/binding.ts";
import { catalogById } from "../../src/payments/catalog.ts";
import { gatewayPaymentPayload, gatewayRequirements } from "../../src/payments/circleGateway.ts";
import { RECEIPT_HEADER } from "../../src/payments/deliveryReceipt.ts";
import { refreshGatewayBatch } from "../../src/payments/gatewayDelivery.ts";
import { GatewayLedger } from "../../src/payments/gatewayLedger.ts";
import { verifyGatewayDelivery } from "../../src/payments/gatewayReceipt.ts";
import { acceptPurchaseProposal } from "../../src/payments/proposal.ts";
import { BuyerService, type PurchaseResult } from "../../src/payments/purchase.ts";
import { parseQuote } from "../../src/payments/quote.ts";
import { encodePaymentHeader, handleMerchantHttp, listen, PAYMENT_HEADER } from "../../src/payments/server.ts";
import { MerchantService } from "../../src/payments/service.ts";
import { PaymentStore } from "../../src/payments/store.ts";
import { DEMO_MERCHANT_CONFIG, DEMO_MERCHANT_SIGNER, DEMO_OWNER, DEMO_PAYER } from "../../test/fixtures/scenario.ts";
import { MockGatewayProvider } from "./mockGateway.ts";
import { ANALYSIS_NOW, Analyst, findPython, summaryOf, type AnalyzeOutput } from "./workflow.ts";

const NYC = "fx-nyc-high-20261118";
const RAIL = "circle-gateway-batched" as const;
const SESSION_TOKEN = "fixture-buyer-session-token-0001"; // FIXTURE, local server only
type Proposal = NonNullable<AnalyzeOutput["purchase_proposal"]>;
type Authorized = Extract<PurchaseResult, { status: "authorized" }>;

async function createNanoWorld(name: string, options: { tamperResponses?: boolean; buyerGatewayBalance?: bigint } = {}) {
  let clock = ANALYSIS_NOW + 120;
  const now = () => clock;
  const store = new PaymentStore();
  const ledger = new GatewayLedger(store);
  const gateway = new MockGatewayProvider({ now, balances: { [DEMO_PAYER.address]: options.buyerGatewayBalance ?? 10_000n } });
  const merchant = new MerchantService({
    config: DEMO_MERCHANT_CONFIG,
    signer: DEMO_MERCHANT_SIGNER,
    settlement: { settle: async () => { throw new Error("direct settlement is not used on the Gateway rail"); } },
    now,
    sessions: { [SESSION_TOKEN]: "session-fixture-buyer" },
    gateway,
  });
  const server = await listen(merchant, { origin: DEMO_MERCHANT_CONFIG.origin });
  let salt = 0;
  const buyer = new BuyerService({
    store,
    catalog: catalogById(),
    owner: DEMO_OWNER.address,
    signer: DEMO_PAYER,
    tokenDomain: ARC_TESTNET.usdcDomain,
    missionId: `mission-${name}`,
    saltSource: () => keccak256(toBytes(`verity-fixture-salt|nano|${name}|${salt++}`)),
  });
  const base = `http://127.0.0.1:${server.port}`;
  async function post(path: string, headers: Record<string, string>, body: string) {
    const response = await fetch(`${base}${path}`, { method: "POST", headers: { authorization: `Bearer ${SESSION_TOKEN}`, "content-type": "application/json", ...headers }, body });
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (options.tamperResponses && response.status === 200 && bytes.length > 0) bytes[bytes.length - 3] = bytes[bytes.length - 3]! ^ 0x01; // FIXTURE: altered in transit
    return { status: response.status, headers: response.headers, bytes };
  }
  return {
    name, store, ledger, gateway, merchant, buyer, post, now,
    advance: (seconds: number) => (clock += seconds),
    close: async () => {
      await server.close();
      merchant.close();
      store.close();
    },
  };
}
type NanoWorld = Awaited<ReturnType<typeof createNanoWorld>>;

async function quoteAndAuthorize(world: NanoWorld, proposal: Proposal) {
  const accepted = acceptPurchaseProposal(proposal, catalogById());
  // Stable, buyer-generated purchase ID derived from the proposal: the same proposal can never become two purchases.
  const purchaseId = `purchase-${createHash("sha256").update(`${world.name}|${proposal.proposal_id}`).digest("hex").slice(0, 24)}`;
  const response = await world.post("/quotes", {}, JSON.stringify({
    catalogItemId: accepted.selection.catalogItemId, purchaseId, parameters: accepted.selection.parameters, catalogParameters: accepted.catalogParameters,
  }));
  const json = JSON.parse(new TextDecoder().decode(response.bytes)) as { quote?: unknown; reason?: string };
  if (response.status !== 402 || !json.quote) throw new Error(`quote refused: ${response.status} ${json.reason}`);
  const quote = parseQuote(json.quote);
  return { accepted, purchaseId, quote, result: await world.buyer.purchase({ accepted, purchaseId, quote, now: world.now() }) };
}

function paidHeaders(authorized: Authorized) {
  const { request, payment } = authorized;
  return {
    [BINDING_HEADER]: payment.bindingHeader,
    [PAYMENT_HEADER]: encodePaymentHeader({ chainId: request.chainId, token: request.token, authorization: payment.authorization }),
  };
}

async function sendPaid(world: NanoWorld, authorized: Authorized) {
  const response = await world.post(new URL(authorized.request.resourceUrl).pathname, paidHeaders(authorized), JSON.stringify(authorized.request.parameters));
  const reason = response.status === 200 ? null : ((JSON.parse(new TextDecoder().decode(response.bytes)) as { reason?: string }).reason ?? null);
  return { status: response.status, bytes: response.bytes, receiptHeader: response.headers.get(RECEIPT_HEADER) ?? undefined, reason };
}

function verify(world: NanoWorld, authorized: Authorized, attempt: { bytes: Uint8Array; receiptHeader: string | undefined }) {
  return verifyGatewayDelivery({
    receiptHeader: attempt.receiptHeader,
    body: attempt.bytes,
    trusted: { merchantId: DEMO_MERCHANT_CONFIG.merchantId, receiptSigner: DEMO_MERCHANT_SIGNER.address },
    request: world.store.get(authorized.request.purchaseId)!.request,
    authorizationNonce: world.store.get(authorized.request.purchaseId)!.nonce,
  });
}

export interface NanoScenarioReport {
  name: string;
  statuses: { analysis: string; payment: string; delivery: string; batchSettlement: string; quicknode: string };
  details: Record<string, unknown>;
  checks: Record<string, boolean>;
}

const report = (name: string): NanoScenarioReport => ({
  name,
  statuses: { analysis: "-", payment: "not_started", delivery: "not_requested", batchSettlement: "-", quicknode: "-" },
  details: {},
  checks: {},
});

async function freeEvidenceResolves(analyst: Analyst): Promise<NanoScenarioReport> {
  const r = report("free_evidence_resolves_gap");
  const analysis = analyst.analyze(NYC, "free-check-answers", RAIL);
  r.statuses.analysis = analysis.purchase_proposal ? "proposal" : "no_proposal";
  r.details = { finding: summaryOf(analysis.risk_analysis), reason: analysis.no_purchase_reason };
  r.checks.no_purchase = analysis.purchase_proposal === null && /answered by the free check/.test(analysis.no_purchase_reason ?? "");
  return r;
}

async function paidNanopayment(analyst: Analyst): Promise<NanoScenarioReport> {
  const r = report("paid_nanopayment_changes_assessment");
  const analysis = analyst.analyze(NYC, "observed-2026-11-18", RAIL);
  const proposal = analysis.purchase_proposal;
  const ruleQuote = (analysis.risk_analysis as unknown as { citations: { id: string; quote: string }[] }).citations.find((c) => c.id === "C-NYC-4");
  r.checks.rule_quoted = Boolean(ruleQuote?.quote);
  r.checks.proposal_for_gap = proposal?.evidence_gap_id === "GAP-NYC-SETTLE" && proposal.catalog_item_id === "cat-nws-cli-settlement-version-nano-v1" && proposal.max_amount_base_units === "1000";
  if (!proposal) return r;
  const world = await createNanoWorld("paid");
  try {
    const { purchaseId, result } = await quoteAndAuthorize(world, proposal);
    r.checks.nanopayment_policy = result.status === "authorized" && result.decision.decision === "allow" && result.decision.tier === "nanopayment";
    if (result.status !== "authorized") return r;
    const attempt = await sendPaid(world, result);
    const verdict = await verify(world, result, attempt);
    r.checks.receipt_and_bytes_verified = verdict.ok;
    if (!verdict.ok) return r;
    const accepted = world.ledger.recordVerifiedDelivery({ receipt: verdict.receipt, digest: verdict.digest, now: world.now() });
    const atAcceptance = world.ledger.status(purchaseId)!;
    // At acceptance the buyer knows only that Gateway accepted the payment; Circle's batch status is not reported yet.
    r.checks.acceptance_recorded_before_batch = accepted.kind === "accepted" && atAcceptance.settlement === "pending_batch" && atAcceptance.batch.status === "unknown";

    // Batch settlement arrives later and is recorded on its own.
    world.advance(60);
    world.gateway.advanceBatch();
    const batched = await world.gateway.transferById(verdict.receipt.paymentRef);
    const midBatch = world.ledger.recordBatch(purchaseId, batched, world.now());
    world.advance(60);
    world.gateway.advanceBatch();
    const completed = await world.gateway.transferById(verdict.receipt.paymentRef);
    const settled = world.ledger.recordBatch(purchaseId, completed, world.now());
    await refreshGatewayBatch(purchaseId, { gateway: world.gateway, deliveries: world.merchant.gatewayDeliveries, now: world.now });
    const merchantRecord = world.merchant.gatewayDeliveries.get(purchaseId)!;
    if ("error" in settled || "error" in midBatch) throw new Error("batch record refused");
    r.checks.batch_settlement_recorded_separately = midBatch.settlement === "pending_batch" && settled.settlement === "batch_settled" && settled.batch.txHash !== null;
    r.checks.provider_id_tied_to_purchase_and_receipt = verdict.receipt.paymentRef === merchantRecord.paymentRef && verdict.receipt.purchaseId === purchaseId;
    r.checks.quicknode_not_claimed = settled.quicknode.status === "not_claimed";
    r.checks.reservation_spent_after_confirmation = world.store.reservation(purchaseId)?.status === "spent";

    const body = attempt.bytes;
    const { signature: _s, ...unsigned } = verdict.receipt;
    const reassessed = analyst.reassess(analysis.risk_analysis, body, {
      purchase_id: purchaseId,
      contract_id: proposal.contract_id,
      evidence_gap_id: proposal.evidence_gap_id,
      catalog_item_id: proposal.catalog_item_id,
      merchant_id: verdict.receipt.merchantId,
      request_hash: verdict.receipt.requestHash,
      content_hash_keccak256: verdict.receipt.contentHash,
      content_sha256: `0x${createHash("sha256").update(body).digest("hex")}`,
      receipt_digest: verdict.digest,
      receipt_signer: unsigned.merchant,
      verified_by: "verifyGatewayDelivery",
      data_label: "FIXTURE",
      payment_rail: RAIL,
      payment_ref: verdict.receipt.paymentRef,
    });
    r.checks.assessment_revised = reassessed.status === "revised" && reassessed.changes.some((c) => c.finding === "scores.source" && c.changed);
    r.statuses = {
      analysis: reassessed.status,
      payment: `accepted_by_gateway; ${settled.settlement}`,
      delivery: "verified",
      batchSettlement: `${settled.batch.status} (batch tx ${settled.batch.txHash})`,
      quicknode: `not_claimed: ${settled.quicknode.reason}`,
    };
    r.details = {
      originalFinding: {
        rule: ruleQuote,
        gap: (analysis.risk_analysis.evidence_gaps as unknown as { id: string; question: string }[]).find((g) => g.id === "GAP-NYC-SETTLE"),
        assessment: summaryOf(analysis.risk_analysis),
        freeCheck: analysis.decision_log.find((l) => /free official-source check/.test(l)),
      },
      proposal,
      purchase: { purchaseId, decision: result.decision, amountBaseUnits: result.request.amount, explanation: result.explanation.text },
      evidencePurchased: {
        body: JSON.parse(new TextDecoder().decode(body)),
        receipt: { version: verdict.receipt.version, paymentRail: verdict.receipt.paymentRail, paymentRef: verdict.receipt.paymentRef, authorizationNonce: verdict.receipt.authorizationNonce, contentHash: verdict.receipt.contentHash },
        gatewaySettleCalls: world.gateway.settleCalls,
        batchHistory: [atAcceptance.batch, midBatch.batch, settled.batch],
      },
      whatChanged: reassessed.changes,
      revisedAssessment: summaryOf(reassessed.revised),
    };
  } finally {
    await world.close();
  }
  return r;
}

async function replay(analyst: Analyst): Promise<NanoScenarioReport> {
  const r = report("replay_without_second_charge");
  const proposal = analyst.analyze(NYC, "observed-2026-11-18", RAIL).purchase_proposal!;
  const world = await createNanoWorld("replay");
  try {
    const { accepted, purchaseId, quote, result } = await quoteAndAuthorize(world, proposal);
    if (result.status !== "authorized") throw new Error(result.status);
    // Two same-tick copies through the route function: both pass the pre-check; only the durable claim separates them.
    const headers = Object.fromEntries(Object.entries({ authorization: `Bearer ${SESSION_TOKEN}`, ...paidHeaders(result) }).map(([k, v]) => [k.toLowerCase(), v]));
    const body = new TextEncoder().encode(JSON.stringify(result.request.parameters));
    const path = new URL(result.request.resourceUrl).pathname;
    const [a, b] = await Promise.all([0, 1].map(() => handleMerchantHttp(world.merchant, "POST", path, headers, body, DEMO_MERCHANT_CONFIG.origin)));
    const again = await world.buyer.purchase({ accepted, purchaseId, quote, now: world.now() });
    if (again.status !== "authorized") throw new Error(again.status);
    const retry = await sendPaid(world, again);
    const first = await verify(world, result, retry);
    const settleCallsThroughVerity = world.gateway.settleCalls;
    // Provider-level replay: the identical signed authorization sent straight to Gateway again.
    const stored = world.store.get(purchaseId)!;
    const direct = await world.gateway.settle(
      gatewayPaymentPayload(stored.request, again.payment.authorization),
      gatewayRequirements(stored.request),
    );
    // A second proposal-to-purchase attempt for the same contract and gap is refused durably.
    const second = await world.buyer.purchase({ accepted, purchaseId: `${purchaseId}-again`, quote: { ...quote, purchaseId: `${purchaseId}-again` }, now: world.now() });
    r.details = {
      sameTickCopies: [a!.status, b!.status],
      retryStatus: retry.status,
      authorizationReused: again.payment.reused,
      gatewaySettleCallsThroughVerity: settleCallsThroughVerity,
      directGatewayReplay: direct,
      secondPurchaseForSameGap: second.status === "rejected" ? second.reason : second.status,
    };
    r.statuses = { analysis: "proposal", payment: "accepted_by_gateway (once)", delivery: first.ok ? "verified (replayed receipt)" : "rejected", batchSettlement: "received", quicknode: "not_claimed" };
    r.checks.same_tick_one_submission = [a!.status, b!.status].sort().join(",") === "200,202";
    r.checks.retry_replays_receipt = retry.status === 200 && first.ok;
    r.checks.authorization_reused = again.payment.reused;
    r.checks.gateway_settled_once = settleCallsThroughVerity === 1;
    r.checks.gateway_refuses_reused_nonce = direct.success === false && direct.errorReason === "nonce_already_used";
    r.checks.duplicate_purchase_refused = second.status === "rejected" && /duplicate purchase/.test(second.reason);
  } finally {
    await world.close();
  }
  return r;
}

async function invalidDelivery(analyst: Analyst): Promise<NanoScenarioReport> {
  const r = report("invalid_delivery_rejected");
  const proposal = analyst.analyze(NYC, "observed-2026-11-18", RAIL).purchase_proposal!;
  const world = await createNanoWorld("invalid", { tamperResponses: true });
  try {
    const { purchaseId, result } = await quoteAndAuthorize(world, proposal);
    if (result.status !== "authorized") throw new Error(result.status);
    const attempt = await sendPaid(world, result);
    const tampered = await verify(world, result, attempt);
    const wrongKey = await verifyGatewayDelivery({
      receiptHeader: attempt.receiptHeader,
      body: attempt.bytes,
      trusted: { merchantId: DEMO_MERCHANT_CONFIG.merchantId, receiptSigner: DEMO_OWNER.address },
      request: world.store.get(purchaseId)!.request,
      authorizationNonce: world.store.get(purchaseId)!.nonce,
    });
    r.details = { tampered: tampered.ok ? "accepted" : tampered.reason, wrongPinnedKey: wrongKey.ok ? "accepted" : wrongKey.code };
    r.statuses = { analysis: "not_reassessed (evidence rejected before the analyst)", payment: "accepted_by_gateway", delivery: tampered.ok ? "verified" : `rejected:${tampered.code}`, batchSettlement: "received", quicknode: "not_claimed" };
    r.checks.tamper_rejected = !tampered.ok && tampered.code === "content_mismatch";
    r.checks.wrong_signer_rejected = !wrongKey.ok && wrongKey.code === "wrong_signer";
    r.checks.nothing_recorded_as_delivered = world.ledger.status(purchaseId) === undefined;
  } finally {
    await world.close();
  }
  return r;
}

export interface NanoWorkflowReport {
  workflow: "verity-circle-gateway-fixture-loop-v1";
  dataLabels: Record<string, string>;
  scenarios: NanoScenarioReport[];
  ok: boolean;
  failedChecks: string[];
}

export async function runNanoWorkflow(options: { analysisDir: string; python?: string }): Promise<NanoWorkflowReport> {
  const analyst = new Analyst(options.python ?? findPython(options.analysisDir), options.analysisDir);
  const scenarios: NanoScenarioReport[] = [];
  for (const run of [freeEvidenceResolves, paidNanopayment, replay, invalidDelivery]) scenarios.push(await run(analyst));
  const failedChecks = scenarios.flatMap((s) => Object.entries(s.checks).filter(([, ok]) => !ok).map(([k]) => `${s.name}.${k}`));
  return {
    workflow: "verity-circle-gateway-fixture-loop-v1",
    dataLabels: {
      market: "FIXTURE NYC high-temperature contract (terms excerpts read from the real terms PDF on 2026-11-18)",
      freeCheck: "OBSERVED reading (observed-2026-11-18); FIXTURE assumption (free-check-answers)",
      gateway: "MOCKED Circle Gateway: verify/settle, transfer IDs, and batch tx hashes are generated locally; no Circle API call, no deposit, no testnet payment",
      merchantEvidence: "FIXTURE document served by the demo merchant",
      quicknode: "Not claimed for Gateway purchases (batch settlement; no provable per-payment match)",
    },
    scenarios,
    ok: failedChecks.length === 0,
    failedChecks,
  };
}

export type { Hex };
