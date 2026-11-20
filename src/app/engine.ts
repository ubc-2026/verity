/**
 * Run engine behind the website. One run = one market, analyzed, then (for an
 * operator) quoted, decided by policy, approved or rejected, paid, verified,
 * observed on chain, reconciled, and reassessed, one step per request.
 *
 * Every run gets its own isolated FIXTURE world: an in-memory PaymentStore and
 * ledger, the real MerchantService behind the real HTTP route function, a
 * stubbed settlement (no chain), and a locally signed QuickNode delivery sent
 * through the real webhook handler. The fixture keys are the public Anvil test
 * keys from test/fixtures/scenario.ts. Nothing here spends money.
 */
import { createHash, randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Hex } from "viem";
import { GrokRoutineModel, type RoutineOutcome } from "../../scripts/e2e/grokRoutineModel.ts";
import { DEMO_MERCHANT_CONFIG, DEMO_MERCHANT_SIGNER, DEMO_OWNER, DEMO_PAYER } from "../../test/fixtures/scenario.ts";
import { feedTokenDigest, handleLedgerFeed, purchaseRecord, type FeedOptions } from "../alerts/ledgerFeed.ts";
import { overdueEvents } from "../alerts/overdue.ts";
import { ARC_TESTNET } from "../payments/arc.ts";
import { BINDING_HEADER } from "../payments/binding.ts";
import { catalogById } from "../payments/catalog.ts";
import { acceptDelivery, RECEIPT_HEADER, receiptDigest, type SignedDeliveryReceiptV1 } from "../payments/deliveryReceipt.ts";
import { approvalTypedData } from "../payments/policy.ts";
import { acceptPurchaseProposal, type AcceptedProposal } from "../payments/proposal.ts";
import { BuyerService, newPurchaseId, type PurchaseResult } from "../payments/purchase.ts";
import { parseQuote, type VerityQuote } from "../payments/quote.ts";
import { encodePaymentHeader, handleMerchantHttp, PAYMENT_HEADER } from "../payments/server.ts";
import { MerchantService } from "../payments/service.ts";
import { DEMO_POLICY, PaymentStore, type SpendingPolicy } from "../payments/store.ts";
import { ReconciliationLedger, type IngestResult } from "../reconciliation/ledger.ts";
import { createQuickNodeWebhookHandler, QUICKNODE_WEBHOOK_PATH } from "../reconciliation/webhook.ts";
import type { Analyst, AnalyzeOutput, Reassessment } from "./analyst.ts";
import { FIXTURE_FINALIZED_BLOCK, signedFixtureDelivery, StubSettlement, type SignedDelivery } from "./fixtureChain.ts";
import type { FixtureMarket } from "./markets.ts";

/** Fixture analysis clock (2026-11-18T01:00:00Z). Payments start two minutes later, as in npm run e2e. */
export const ANALYSIS_NOW = Date.UTC(2026, 10, 18, 1, 0, 0) / 1000;
export const PAYMENT_START = ANALYSIS_NOW + 120;
export const DELIVERY_WINDOW_SECONDS = 300;
/** Signed QuickNode deliveries older or newer than this (by X-QN-Timestamp) are refused. */
export const WEBHOOK_MAX_SKEW_SECONDS = 300;

// FIXTURE credentials for in-process services only. They never leave the server and protect nothing real.
const SESSION_TOKEN = "fixture-app-buyer-session-token-01";
const QUICKNODE_TOKEN = "fixture-app-quicknode-security-token";
const FEED_TOKEN = "fixture-app-ledger-feed-read-token-1";
const ROUTINE_KEY = "crsr_fixture_app_routine_key_0001";

export type ScenarioId = "standard" | "free_answers" | "approval" | "budget" | "tampered";

export const SCENARIOS: Record<ScenarioId, { label: string; detail: string; freeCheck: string | null; policy?: Partial<SpendingPolicy>; tamper?: boolean }> = {
  standard: {
    label: "Standard",
    detail: "Free official sources are checked first (observed reading of 2026-11-18). Demo policy.",
    freeCheck: "observed-2026-11-18",
  },
  free_answers: {
    label: "Free source answers",
    detail: "FIXTURE assumption: the free check answers the gap, so nothing is bought.",
    freeCheck: "free-check-answers",
  },
  approval: {
    label: "Owner approval",
    detail: "FIXTURE policy: the automatic tiers end at 0.01 USDC, so the 0.05 USDC item needs the owner's wallet signature.",
    freeCheck: "observed-2026-11-18",
    policy: { autoApproveMax: 10_000n, gapMax: 10_000n },
  },
  budget: {
    label: "Budget denial",
    detail: "FIXTURE policy: the mission budget is 0.04 USDC, below the 0.05 USDC item.",
    freeCheck: "observed-2026-11-18",
    policy: { missionBudget: 40_000n },
  },
  tampered: {
    label: "Receipt rejection",
    detail: "FIXTURE fault: one response byte is altered in transit, so the buyer must reject the delivery.",
    freeCheck: "observed-2026-11-18",
    tamper: true,
  },
};

export class AppError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const iso = (seconds: number) => new Date(seconds * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
const usdc = (units: string | bigint) => {
  const value = BigInt(units);
  const fraction = (value % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  return `${value / 1_000_000n}.${fraction.padEnd(2, "0")}`;
};

interface World {
  clock: number;
  store: PaymentStore;
  ledger: ReconciliationLedger;
  settlement: StubSettlement;
  merchant: MerchantService;
  buyer: BuyerService;
  routine: GrokRoutineModel;
  feedOptions: FeedOptions;
  webhookPort: number;
  webhookServer: Server;
}

type Actor = "visitor" | "operator" | "owner" | "system";

interface Attempt {
  kind: "pay" | "retry";
  atUtc: string;
  status: number;
  reason: string | null;
  receiptPresent: boolean;
  authorizationReused: boolean;
}

interface WebhookAttempt {
  kind: "observe" | "replay" | "forged" | "stale";
  atUtc: string;
  httpStatus: number;
  duplicateEvent: boolean | null;
  outcomes: IngestResult["outcomes"];
}

export interface Run {
  id: string;
  createdAtUtc: string;
  marketId: string;
  scenario: ScenarioId;
  analysis: AnalyzeOutput;
  market: FixtureMarket;
  world: World | null;
  purchaseId: string | null;
  accepted: AcceptedProposal | null;
  quote: VerityQuote | null;
  result: PurchaseResult | null;
  approval: { state: "not_needed" | "requested" | "approved" | "rejected" | "expired"; by: string | null; reason: string | null };
  attempts: Attempt[];
  lastResponse: { status: number; bytes: Uint8Array; receiptHeader: string | undefined } | null;
  delivery:
    | { state: "verified"; outcome: string; receipt: SignedDeliveryReceiptV1; body: Uint8Array; verifiedAtUtc: string }
    | { state: "rejected"; code: string; reason: string; verifiedAtUtc: string }
    | null;
  webhooks: WebhookAttempt[];
  lastDelivery: SignedDelivery | null;
  reassessment: Reassessment | null;
  incidents: { atUtc: string; outcome: RoutineOutcome; eventId: string | null; httpStatus: number }[];
  lastOverdueBody: string | null;
  timeline: { atUtc: string; actor: Actor; step: string; detail: string }[];
}

export interface EngineOptions {
  analyst: Analyst;
  markets: FixtureMarket[];
  /** Enrolled owner wallet for approvals. Fixture default: the Anvil test key #3 address. */
  owner?: Hex;
  maxRuns?: number;
}

export class RunEngine {
  readonly #analyst: Analyst;
  readonly #markets: Map<string, FixtureMarket>;
  readonly #owner: Hex;
  readonly #maxRuns: number;
  readonly runs = new Map<string, Run>();
  #paused = false;
  #pausedReason: string | null = null;

  constructor(options: EngineOptions) {
    this.#analyst = options.analyst;
    this.#markets = new Map(options.markets.map((m) => [m.contractId, m]));
    this.#owner = (options.owner ?? DEMO_OWNER.address).toLowerCase() as Hex;
    this.#maxRuns = options.maxRuns ?? 100;
  }

  get owner(): Hex {
    return this.#owner;
  }

  get fixtureOwnerEnrolled(): boolean {
    return this.#owner === DEMO_OWNER.address.toLowerCase();
  }

  get paused() {
    return { paused: this.#paused, reason: this.#pausedReason };
  }

  markets(): FixtureMarket[] {
    return [...this.#markets.values()];
  }

  /** Global pause switch: every world's durable store is paused, and new worlds start paused. */
  setPaused(paused: boolean, reason: string | null) {
    this.#paused = paused;
    this.#pausedReason = paused ? (reason ?? "paused by operator") : null;
    for (const run of this.runs.values()) {
      if (!run.world) continue;
      run.world.store.setPaused(paused, run.world.clock, this.#pausedReason);
      this.#log(run, "operator", paused ? "pause" : "resume", paused ? `Payments paused: ${this.#pausedReason}` : "Payments resumed.");
    }
  }

  async createRun(input: { marketId: unknown; scenario: unknown }, actor: Actor): Promise<Run> {
    if (typeof input.marketId !== "string" || !this.#markets.has(input.marketId)) throw new AppError(400, "unknown market");
    const scenario = (typeof input.scenario === "string" ? input.scenario : "standard") as ScenarioId;
    if (!(scenario in SCENARIOS)) throw new AppError(400, "unknown scenario");
    const analysis = await this.#analyst.analyze(input.marketId, SCENARIOS[scenario].freeCheck);
    const run: Run = {
      id: `run-${randomBytes(8).toString("hex")}`,
      createdAtUtc: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
      marketId: input.marketId,
      scenario,
      analysis,
      market: this.#markets.get(input.marketId)!,
      world: null,
      purchaseId: null,
      accepted: null,
      quote: null,
      result: null,
      approval: { state: "not_needed", by: null, reason: null },
      attempts: [],
      lastResponse: null,
      delivery: null,
      webhooks: [],
      lastDelivery: null,
      reassessment: null,
      incidents: [],
      lastOverdueBody: null,
      timeline: [],
    };
    this.#log(run, actor, "analyze", analysis.purchase_proposal
      ? `Proposal for ${analysis.purchase_proposal.evidence_gap_id}: up to ${usdc(analysis.purchase_proposal.max_amount_base_units)} USDC.`
      : `No purchase: ${analysis.no_purchase_reason ?? "no proposal"}`);
    this.runs.set(run.id, run);
    while (this.runs.size > this.#maxRuns) {
      const oldest = this.runs.keys().next().value!;
      await this.dispose(oldest);
    }
    return run;
  }

  get(runId: string): Run {
    const run = this.runs.get(runId);
    if (!run) throw new AppError(404, "unknown run");
    return run;
  }

  async dispose(runId: string) {
    const run = this.runs.get(runId);
    this.runs.delete(runId);
    if (run?.world) await this.#closeWorld(run.world);
  }

  async close() {
    for (const id of [...this.runs.keys()]) await this.dispose(id);
  }

  #log(run: Run, actor: Actor, step: string, detail: string) {
    run.timeline.push({ atUtc: iso(run.world?.clock ?? ANALYSIS_NOW), actor, step, detail });
  }

  async #world(run: Run): Promise<World> {
    if (run.world) return run.world;
    const scenario = SCENARIOS[run.scenario];
    const world = { clock: PAYMENT_START } as World;
    const now = () => world.clock;
    world.store = new PaymentStore(":memory:", { ...DEMO_POLICY, ...scenario.policy });
    if (this.#paused) world.store.setPaused(true, world.clock, this.#pausedReason);
    world.ledger = new ReconciliationLedger(world.store);
    world.settlement = new StubSettlement();
    world.merchant = new MerchantService({
      config: DEMO_MERCHANT_CONFIG,
      signer: DEMO_MERCHANT_SIGNER,
      settlement: world.settlement,
      now,
      sessions: { [SESSION_TOKEN]: `session-${run.id}` },
    });
    world.buyer = new BuyerService({
      store: world.store,
      catalog: catalogById(),
      owner: this.#owner,
      signer: DEMO_PAYER,
      tokenDomain: ARC_TESTNET.usdcDomain,
      missionId: `mission-${run.id}`,
    });
    world.feedOptions = { deliveryWindowSeconds: DELIVERY_WINDOW_SECONDS, merchantLabel: (_p, merchantId) => `${merchantId} (fixture)` };
    const feed = (purchaseId: string) =>
      handleLedgerFeed(
        { method: "GET", url: `/purchases/${encodeURIComponent(purchaseId)}`, authorization: `Bearer ${FEED_TOKEN}` },
        { tokenDigest: feedTokenDigest(FEED_TOKEN), db: world.store.database, options: world.feedOptions },
      );
    world.routine = new GrokRoutineModel({ routineKey: ROUTINE_KEY, recheck: feed, now: () => new Date(world.clock * 1000) });
    const handler = createQuickNodeWebhookHandler({
      securityToken: QUICKNODE_TOKEN,
      ledger: world.ledger,
      finalizedBlock: async () => FIXTURE_FINALIZED_BLOCK,
      now,
      source: "fixture-signed-locally",
      maxTimestampSkewSeconds: WEBHOOK_MAX_SKEW_SECONDS,
    });
    world.webhookServer = createServer((req, res) => void handler(req, res));
    world.webhookPort = await new Promise<number>((resolve) =>
      world.webhookServer.listen(0, "127.0.0.1", () => resolve((world.webhookServer.address() as AddressInfo).port)),
    );
    run.world = world;
    return world;
  }

  async #closeWorld(world: World) {
    await new Promise<void>((resolve) => world.webhookServer.close(() => resolve()));
    world.merchant.close();
    world.store.close();
  }

  // ------------------------------------------------------------ operator steps

  async step(runId: string, action: string, body: Record<string, unknown>): Promise<Run> {
    const run = this.get(runId);
    switch (action) {
      case "quote":
        await this.#quote(run);
        break;
      case "decide":
        await this.#decide(run);
        break;
      case "approve":
        await this.#approve(run, body);
        break;
      case "reject":
        this.#reject(run, body);
        break;
      case "advance":
        this.#advance(run, body);
        break;
      case "pay":
        await this.#pay(run, "pay");
        break;
      case "retry":
        await this.#pay(run, "retry");
        break;
      case "verify":
        await this.#verify(run);
        break;
      case "webhook":
        await this.#webhook(run, "observe");
        break;
      case "webhook-replay":
        await this.#webhook(run, "replay");
        break;
      case "webhook-forged":
        await this.#webhook(run, "forged");
        break;
      case "webhook-stale":
        await this.#webhook(run, "stale");
        break;
      case "reassess":
        await this.#reassess(run);
        break;
      case "overdue":
        this.#overdue(run, false);
        break;
      case "overdue-replay":
        this.#overdue(run, true);
        break;
      default:
        throw new AppError(404, "unknown action");
    }
    return run;
  }

  async #quote(run: Run) {
    const proposal = run.analysis.purchase_proposal;
    if (!proposal) throw new AppError(409, `nothing to quote: ${run.analysis.no_purchase_reason ?? "no proposal"}`);
    if (run.quote) throw new AppError(409, "this run already has a quote");
    const world = await this.#world(run);
    let accepted: AcceptedProposal;
    try {
      // The proposal must be for the market the person selected, an allowlisted item, and within the ceilings.
      accepted = acceptPurchaseProposal(proposal, catalogById(), { expectedContractId: run.marketId });
    } catch (error) {
      throw new AppError(422, (error as Error).message);
    }
    const purchaseId = newPurchaseId();
    const response = await handleMerchantHttp(
      world.merchant,
      "POST",
      "/quotes",
      { authorization: `Bearer ${SESSION_TOKEN}`, "content-type": "application/json" },
      new TextEncoder().encode(JSON.stringify({
        catalogItemId: accepted.selection.catalogItemId,
        purchaseId,
        parameters: accepted.selection.parameters,
        catalogParameters: accepted.catalogParameters,
      })),
      DEMO_MERCHANT_CONFIG.origin,
    );
    const body = response.body as { quote?: unknown; reason?: string };
    if (response.status !== 402 || !body.quote) throw new AppError(502, `merchant refused the quote: ${body.reason ?? response.status}`);
    run.accepted = accepted;
    run.purchaseId = purchaseId;
    run.quote = parseQuote(body.quote);
    this.#log(run, "operator", "quote", `Quote ${run.quote.quoteId}: ${usdc(run.quote.amount)} USDC to ${run.quote.payTo}, expires ${iso(run.quote.expiresAt)}.`);
  }

  async #decide(run: Run) {
    if (!run.quote || !run.accepted || !run.purchaseId || !run.world) throw new AppError(409, "request a quote first");
    if (run.result) throw new AppError(409, "policy already decided for this run");
    const result = await run.world.buyer.purchase({ accepted: run.accepted, purchaseId: run.purchaseId, quote: run.quote, now: run.world.clock });
    run.result = result;
    if (result.status === "awaiting_approval") run.approval = { state: "requested", by: null, reason: null };
    this.#log(run, "system", "policy", result.status === "rejected" ? `Refused: ${result.reason}` : result.explanation.text);
  }

  async #approve(run: Run, body: Record<string, unknown>) {
    const world = run.world;
    if (!world || !run.result || run.result.status !== "awaiting_approval") throw new AppError(409, "no approval request is open for this run");
    let signature: Hex;
    let by: string;
    if (body.method === "fixture-owner") {
      // FIXTURE: the Anvil test key #3 stands in for the owner's wallet. Only valid while that address is enrolled.
      signature = await DEMO_OWNER.signTypedData(approvalTypedData(run.result.request, run.result.requestHash));
      by = "FIXTURE owner key (Anvil #3)";
    } else if (body.method === "wallet" && typeof body.signature === "string" && /^0x[0-9a-fA-F]{130}$/.test(body.signature)) {
      signature = body.signature as Hex;
      by = "owner wallet (EIP-712)";
    } else {
      throw new AppError(400, "approve needs method fixture-owner, or method wallet with a 65-byte signature");
    }
    const result = await world.buyer.purchase({ accepted: run.accepted!, purchaseId: run.purchaseId!, quote: run.quote!, now: world.clock, ownerSignature: signature });
    if (result.status === "authorized") {
      run.result = result;
      run.approval = { state: "approved", by, reason: null };
      this.#log(run, "owner", "approve", `Approved by ${by} for request ${result.payment.record.requestHash.slice(0, 10)}…`);
      return;
    }
    const record = world.store.get(run.purchaseId!);
    if (record?.status === "expired") {
      run.result = result;
      run.approval = { state: "expired", by: null, reason: result.status === "rejected" ? result.reason : null };
    }
    const reason = result.status === "rejected" ? result.reason : "approval was not accepted";
    this.#log(run, "owner", "approve", `Approval refused: ${reason}`);
    throw new AppError(422, reason);
  }

  #reject(run: Run, body: Record<string, unknown>) {
    const world = run.world;
    if (!world || !run.result || run.result.status !== "awaiting_approval") throw new AppError(409, "no approval request is open for this run");
    const reason = typeof body.reason === "string" && body.reason.trim() ? body.reason.trim().slice(0, 200) : "declined by the owner";
    run.result = world.buyer.rejectApproval({ purchaseId: run.purchaseId!, reason, now: world.clock, quote: run.quote! });
    run.approval = { state: "rejected", by: "owner", reason };
    this.#log(run, "owner", "reject", `Rejected: ${reason}. The reservation is released.`);
  }

  #advance(run: Run, body: Record<string, unknown>) {
    const world = run.world;
    if (!world) throw new AppError(409, "the fixture clock starts with the quote");
    const seconds = Number(body.seconds);
    if (!Number.isInteger(seconds) || seconds < 1 || seconds > 3600) throw new AppError(400, "seconds must be an integer from 1 to 3600");
    world.clock += seconds;
    const expired = world.store.expireStale(world.clock);
    this.#log(run, "operator", "advance", `FIXTURE clock +${seconds} s.${expired.length ? ` Expired and released: ${expired.join(", ")}.` : ""}`);
    if (run.purchaseId && expired.includes(run.purchaseId)) {
      if (run.approval.state === "requested") run.approval = { state: "expired", by: null, reason: "the approval window closed" };
      const decision = { decision: "reject", reason: "the authorization window expired before signing" } as const;
      run.result = { status: "rejected", reason: decision.reason, decision, explanation: { provider: "elevenlabs", text: `Verity did not buy this evidence. Reason: ${decision.reason}. No payment was authorized.`, voice: { mode: "not_requested", audio: null } } };
    }
  }

  async #pay(run: Run, kind: "pay" | "retry") {
    const world = run.world;
    if (!world || !run.result || run.result.status !== "authorized") throw new AppError(409, "no authorized payment for this run");
    if (kind === "pay" && run.attempts.length > 0) throw new AppError(409, "already submitted; use retry to resend the same authorization");
    if (kind === "retry" && run.attempts.length === 0) throw new AppError(409, "nothing to retry yet");
    // A retry goes back through the buyer: the stored authorization is returned, never signed again.
    const again = await world.buyer.purchase({ accepted: run.accepted!, purchaseId: run.purchaseId!, quote: run.quote!, now: world.clock });
    if (again.status !== "authorized") {
      this.#log(run, "system", kind, `Not sent: ${again.status === "rejected" ? again.reason : again.status}`);
      throw new AppError(409, again.status === "rejected" ? again.reason : "not authorized");
    }
    const { request, payment } = again;
    const response = await handleMerchantHttp(
      world.merchant,
      "POST",
      new URL(request.resourceUrl).pathname,
      {
        authorization: `Bearer ${SESSION_TOKEN}`,
        "content-type": "application/json",
        [BINDING_HEADER.toLowerCase()]: payment.bindingHeader,
        [PAYMENT_HEADER.toLowerCase()]: encodePaymentHeader({ chainId: request.chainId, token: request.token, authorization: payment.authorization }),
      },
      new TextEncoder().encode(JSON.stringify(request.parameters)),
      DEMO_MERCHANT_CONFIG.origin,
    );
    const headers = Object.fromEntries(Object.entries(response.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
    let bytes = response.body instanceof Uint8Array ? new Uint8Array(response.body) : new Uint8Array();
    if (response.status === 200 && SCENARIOS[run.scenario].tamper && bytes.length > 3) {
      bytes[bytes.length - 3] = bytes[bytes.length - 3]! ^ 0x01; // FIXTURE: one byte altered in transit
    }
    const reason = response.body instanceof Uint8Array ? null : ((response.body as { reason?: string }).reason ?? null);
    run.attempts.push({ kind, atUtc: iso(world.clock), status: response.status, reason, receiptPresent: Boolean(headers[RECEIPT_HEADER.toLowerCase()]), authorizationReused: payment.reused });
    if (response.status === 200) run.lastResponse = { status: 200, bytes, receiptHeader: headers[RECEIPT_HEADER.toLowerCase()] };
    this.#log(run, "operator", kind, `Merchant answered ${response.status}${reason ? ` (${reason})` : ""}. Settle calls so far: ${world.settlement.settleCalls}. Authorization ${payment.reused ? "reused" : "signed once"}.`);
  }

  async #verify(run: Run) {
    const world = run.world;
    if (!world || !run.lastResponse) throw new AppError(409, "no delivered response to verify");
    const stored = world.store.get(run.purchaseId!)!;
    const result = await acceptDelivery({
      response: { body: run.lastResponse.bytes, receiptHeader: run.lastResponse.receiptHeader },
      trusted: { merchantId: DEMO_MERCHANT_CONFIG.merchantId, receiptSigner: DEMO_MERCHANT_SIGNER.address },
      request: stored.request,
      store: world.ledger,
      now: world.clock,
    });
    if (result.accepted) {
      run.delivery = { state: "verified", outcome: result.outcome.kind, receipt: result.receipt, body: result.body, verifiedAtUtc: iso(world.clock) };
      this.#log(run, "system", "verify", `Receipt and bytes verified (${result.outcome.kind}).`);
    } else {
      run.delivery = { state: "rejected", code: result.code, reason: result.reason, verifiedAtUtc: iso(world.clock) };
      this.#log(run, "system", "verify", `Delivery rejected: ${result.code}. The analyst never sees these bytes.`);
    }
  }

  async #webhook(run: Run, kind: WebhookAttempt["kind"]) {
    const world = run.world;
    if (!world) throw new AppError(409, "nothing has been paid in this run");
    let delivery: SignedDelivery;
    if (kind === "observe") {
      const settled = world.settlement.settled[0];
      if (!settled) throw new AppError(409, "the merchant has not settled anything yet");
      delivery = signedFixtureDelivery({
        settled,
        blockTimestamp: world.clock,
        txFrom: DEMO_MERCHANT_SIGNER.address,
        securityToken: QUICKNODE_TOKEN,
        timestamp: world.clock,
        streamId: "fixture-app-stream",
      });
      run.lastDelivery = delivery;
    } else {
      if (!run.lastDelivery) throw new AppError(409, "send the on-chain event first");
      delivery = run.lastDelivery;
      if (kind === "forged") {
        const sig = delivery.headers["x-qn-signature"]!;
        delivery = { ...delivery, headers: { ...delivery.headers, "x-qn-signature": `${sig.slice(0, -1)}${sig.endsWith("0") ? "1" : "0"}` } };
      }
      if (kind === "stale") {
        const settled = world.settlement.settled[0]!;
        delivery = signedFixtureDelivery({
          settled,
          blockTimestamp: Number(JSON.parse(run.lastDelivery.payload).matches?.[0]?.blockTimestamp ?? world.clock),
          txFrom: DEMO_MERCHANT_SIGNER.address,
          securityToken: QUICKNODE_TOKEN,
          timestamp: world.clock - WEBHOOK_MAX_SKEW_SECONDS - 60,
          streamId: "fixture-app-stream",
        });
      }
    }
    const response = await fetch(`http://127.0.0.1:${world.webhookPort}${QUICKNODE_WEBHOOK_PATH}`, { method: "POST", headers: delivery.headers, body: delivery.payload });
    const text = await response.text();
    let parsed: Partial<IngestResult> = {};
    try {
      parsed = JSON.parse(text) as Partial<IngestResult>;
    } catch {
      parsed = {};
    }
    run.webhooks.push({ kind, atUtc: iso(world.clock), httpStatus: response.status, duplicateEvent: parsed.duplicateEvent ?? null, outcomes: parsed.outcomes ?? [] });
    const counts = world.ledger.counts();
    this.#log(run, "system", `webhook:${kind}`, `QuickNode handler answered ${response.status}${parsed.duplicateEvent ? " (duplicate event)" : ""}. Settlements recorded: ${counts.settlements}.`);
  }

  async #reassess(run: Run) {
    // The gate: reassessment runs only on bytes the buyer verified against a signed receipt bound to this request.
    if (run.delivery?.state !== "verified") throw new AppError(409, "reassessment waits for a verified receipt and delivered bytes");
    if (run.reassessment) throw new AppError(409, "already reassessed");
    const proposal = run.analysis.purchase_proposal!;
    const { receipt, body } = run.delivery;
    const { signature: _sig, ...unsigned } = receipt;
    run.reassessment = await this.#analyst.reassess(run.analysis.risk_analysis, body, {
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
    });
    this.#log(run, "system", "reassess", `${run.reassessment.status}: ${run.reassessment.reason}`);
  }

  #overdue(run: Run, replay: boolean) {
    const world = run.world;
    if (!world) throw new AppError(409, "nothing has been paid in this run");
    let body = run.lastOverdueBody;
    if (!replay) {
      const events = overdueEvents(world.store.database, { now: world.clock, environment: "fixture", options: world.feedOptions });
      const mine = events.find((event) => event.purchaseId === run.purchaseId);
      if (!mine) {
        const record = run.purchaseId ? purchaseRecord(world.store.database, run.purchaseId, world.feedOptions) : undefined;
        this.#log(run, "system", "overdue", `No overdue event. Ledger status: ${record?.ledgerStatus ?? "no purchase"}${record ? `, deadline ${record.deliveryDeadlineUtc}` : ""}.`);
        return;
      }
      body = JSON.stringify(mine);
      run.lastOverdueBody = body;
    }
    if (!body) throw new AppError(409, "no overdue event to replay");
    const outcome = world.routine.receive(`Bearer ${ROUTINE_KEY}`, body);
    run.incidents.push({ atUtc: iso(world.clock), outcome: outcome.outcome, eventId: (JSON.parse(body) as { eventId: string }).eventId, httpStatus: outcome.httpStatus });
    this.#log(run, "system", replay ? "overdue-replay" : "overdue", `Grok routine model: ${outcome.outcome}. Incident cards: ${world.routine.cards.size}.`);
  }

  // ------------------------------------------------------------ views

  /** What any visitor may see. No credentials, no signatures, no authorization payloads. */
  publicView(run: Run) {
    const a = run.analysis;
    const ra = a.risk_analysis;
    const ruleIds = new Set(a.research.market.resolution.rule_excerpt_ids);
    const world = run.world;
    const record = world && run.purchaseId ? purchaseRecord(world.store.database, run.purchaseId, world.feedOptions) : undefined;
    const settlement = world && run.purchaseId ? world.ledger.settlement(run.purchaseId) : undefined;
    const stored = world && run.purchaseId ? world.store.get(run.purchaseId) : undefined;
    const proposal = a.purchase_proposal;
    return {
      id: run.id,
      label: "FIXTURE",
      createdAtUtc: run.createdAtUtc,
      scenario: { id: run.scenario, ...SCENARIOS[run.scenario], policy: undefined },
      market: {
        ...run.market,
        snapshotHash: ra.snapshot.snapshot_hash,
        unavailable: a.research.market.unavailable,
      },
      rating: {
        final: ra.rating.final_rating,
        total: ra.rating.raw_total,
        complete: ra.rating.complete,
        researchAction: ra.research_action,
        summary: ra.summary,
        scores: Object.entries(ra.scores).map(([name, s]) => ({ name, score: s.score, rationale: s.rationale, nullReason: s.null_reason, citationIds: s.citation_ids })),
        note: "Settlement-risk rating: how the contract resolves, separate from the market-implied price.",
      },
      rule: {
        settlementSource: a.research.market.resolution.settlement_source,
        termsUrl: a.research.market.resolution.terms_url,
        termsNote: a.research.market.resolution.terms_url_note ?? null,
        citations: ra.citations.filter((c) => ruleIds.has(c.id)),
      },
      citations: ra.citations,
      gaps: ra.evidence_gaps.map((g) => ({ id: g.id, question: g.question, why: g.why, affects: g.affects, material: g.material, open: g.material && g.affects === "resolution_risk" })),
      decision: {
        action: proposal ? "buy" : "abstain",
        reason: proposal ? proposal.rationale : (a.no_purchase_reason ?? "no proposal"),
        freeChecks: a.decision_log,
        proposal: proposal
          ? { gapId: proposal.evidence_gap_id, catalogItemId: proposal.catalog_item_id, maxUsdc: usdc(proposal.max_amount_base_units), label: proposal.fixture_label }
          : null,
      },
      states: {
        quote: run.quote ? { state: "issued", amountUsdc: usdc(run.quote.amount), expiresAtUtc: iso(run.quote.expiresAt) } : { state: proposal ? "not_requested" : "not_needed" },
        policy: run.result
          ? run.result.status === "rejected"
            ? { state: "refused", reason: run.result.reason }
            : { state: run.result.decision.decision === "needs_approval" ? "needs_owner_approval" : "allowed", tier: "tier" in run.result.decision ? run.result.decision.tier : null }
          : { state: "not_decided" },
        approval: run.approval,
        authorization: stored ? { state: stored.status, amountUsdc: usdc(stored.request.amount) } : { state: "none" },
        delivery: run.delivery
          ? run.delivery.state === "verified"
            ? { state: "verified", contentHash: run.delivery.receipt.contentHash, receiptTx: run.delivery.receipt.txHash, atUtc: run.delivery.verifiedAtUtc }
            : { state: "rejected", code: run.delivery.code, reason: run.delivery.reason, atUtc: run.delivery.verifiedAtUtc }
          : run.lastResponse
            ? { state: "received_unverified" }
            : { state: "not_received" },
        settlement: settlement
          ? { state: "confirmed", txHash: settlement.txHash, blockNumber: settlement.blockNumber, source: settlement.source, label: "FIXTURE: derived tx hash, not on Arc Testnet" }
          : world && world.settlement.settleCalls > 0
            ? { state: "submitted_unconfirmed", label: "FIXTURE stub settled; not yet observed by QuickNode" }
            : { state: "none" },
        reconciliation: record ? { state: record.ledgerStatus, deadlineUtc: record.deliveryDeadlineUtc, settlementConfirmed: record.settlementConfirmed } : { state: "none" },
        reassessment: run.reassessment
          ? {
              state: run.reassessment.status,
              reason: run.reassessment.reason,
              before: { final: ra.rating.final_rating, total: ra.rating.raw_total },
              after: { final: run.reassessment.revised.rating.final_rating, total: run.reassessment.revised.rating.raw_total },
              changes: run.reassessment.changes.filter((c) => c.changed),
              evidenceCitation: run.reassessment.evidence_citation,
            }
          : { state: run.delivery?.state === "verified" ? "ready" : "waits_for_verified_delivery" },
      },
      timeline: run.timeline,
    };
  }

  /** Operator view: adds the quote, the policy decision and explanation, the approval request, budget and event logs. */
  operatorView(run: Run) {
    const world = run.world;
    const stored = world && run.purchaseId ? world.store.get(run.purchaseId) : undefined;
    const result = run.result;
    return {
      ...this.publicView(run),
      operator: {
        purchaseId: run.purchaseId,
        fixtureClockUtc: world ? iso(world.clock) : iso(PAYMENT_START),
        paused: world ? world.store.isPaused() : this.#paused,
        quote: run.quote,
        policy: result
          ? {
              status: result.status,
              decision: result.decision,
              reason: result.status === "rejected" ? result.reason : null,
              explanation: result.explanation.text,
              voice: "Text only. No ElevenLabs audio is produced by this build.",
            }
          : null,
        approvalRequest:
          result?.status === "awaiting_approval"
            ? {
                owner: this.#owner,
                fixtureOwnerEnrolled: this.fixtureOwnerEnrolled,
                requestHash: result.requestHash,
                expiresAtUtc: iso(result.request.validBefore),
                typedData: result.approval,
              }
            : null,
        authorization: stored
          ? { status: stored.status, requestHash: stored.requestHash, nonce: stored.nonce, payer: stored.request.payer, payTo: stored.request.payTo, validBeforeUtc: iso(stored.request.validBefore) }
          : null,
        budget: world ? world.buyer.budget() : null,
        attempts: run.attempts,
        settleCalls: world?.settlement.settleCalls ?? 0,
        resumeCalls: world?.settlement.resumeCalls ?? 0,
        ledgerCounts: world?.ledger.counts() ?? null,
        webhooks: run.webhooks,
        incidents: run.incidents,
        incidentCards: world ? [...world.routine.cards.values()] : [],
      },
    };
  }
}

/** JSON with bigint as decimal strings. */
export function toJson(value: unknown): string {
  return JSON.stringify(value, (_key, v) => (typeof v === "bigint" ? v.toString(10) : v instanceof Uint8Array ? undefined : v));
}
