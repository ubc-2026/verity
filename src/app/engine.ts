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
import { MockGatewayProvider } from "../../scripts/e2e/mockGateway.ts";
import { DEMO_MERCHANT_CONFIG, DEMO_MERCHANT_SIGNER, DEMO_OWNER, DEMO_PAYER } from "../../test/fixtures/scenario.ts";
import { feedTokenDigest, handleLedgerFeed, purchaseRecord, type FeedOptions } from "../alerts/ledgerFeed.ts";
import { overdueEvents } from "../alerts/overdue.ts";
import { ARC_TESTNET } from "../payments/arc.ts";
import { BINDING_HEADER } from "../payments/binding.ts";
import { catalogById } from "../payments/catalog.ts";
import type { GatewayProvider, GatewayTransfer, PaymentRail } from "../payments/circleGateway.ts";
import { acceptDelivery, RECEIPT_HEADER, receiptDigest, type SignedDeliveryReceiptV1 } from "../payments/deliveryReceipt.ts";
import { GatewayLedger } from "../payments/gatewayLedger.ts";
import { verifyGatewayDelivery, type SignedGatewayReceipt } from "../payments/gatewayReceipt.ts";
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
import { FIXTURE_FINALIZED_BLOCK, signedFixtureDelivery, signedGatewayBatchDelivery, StubSettlement, type SignedDelivery } from "./fixtureChain.ts";
import { classifyQuote, type FixtureMarket } from "./markets.ts";

/** Live quotes older than this are shown as stale, with no implied price. */
export const LIVE_QUOTE_STALE_SECONDS = 300;

function parseLive(value: unknown): { event: string; outcome: string } | null {
  if (value === undefined || value === null) return null;
  const v = value as Record<string, unknown>;
  if (typeof v !== "object" || typeof v.event !== "string" || typeof v.outcome !== "string") throw new AppError(400, "live needs event and outcome strings");
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(v.event)) throw new AppError(400, "invalid event ticker");
  const outcome = v.outcome.trim();
  if (!outcome || outcome.length > 160 || /[\u0000-\u001f]/.test(outcome)) throw new AppError(400, "invalid outcome label");
  return { event: v.event, outcome };
}

/** The run's market card for a live analysis: Gemini Exchange quote as read by the analysis, labelled LIVE. */
function liveMarketFrom(analysis: AnalyzeOutput, now: number): FixtureMarket {
  const m = analysis.research.market;
  const observed = m.observed_utc;
  return {
    contractId: m.contract_id,
    question: m.question,
    outcomeLabel: m.outcome_label,
    eventTicker: m.event_ticker,
    expiryUtc: m.expiry_utc,
    settlementSource: m.resolution.settlement_source,
    termsUrl: m.resolution.terms_url,
    source: { mode: "live", label: m.source_label, url: m.source_url, snapshotDate: m.observed_date ?? "", snapshotTimeUtc: observed },
    volumeUsd: m.quote.volume_usd,
    volumeBasis: m.quote.volume_basis,
    quote: classifyQuote({ bestBid: m.quote.best_bid, bestAsk: m.quote.best_ask, observedAtUtc: observed, now, staleAfterSeconds: LIVE_QUOTE_STALE_SECONDS }),
    label: "LIVE",
  };
}

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

export type ScenarioId = "standard" | "free_answers" | "approval" | "budget" | "tampered" | "lost_response";

export const RAILS: Record<PaymentRail, { label: string; detail: string }> = {
  "arc-eip3009": { label: "Arc direct (EIP-3009)", detail: "One signed USDC authorization settled in its own Arc transaction. QuickNode matches that transaction to the purchase." },
  "circle-gateway-batched": {
    label: "Circle Gateway (batched)",
    detail: "A 0.001 USDC nanopayment. Circle records the individual transfer; many transfers settle in one Arc batch transaction, which QuickNode confirms at batch level.",
  },
};

export interface Scenario {
  label: string;
  detail: string;
  freeCheck: string | null;
  policy?: Partial<SpendingPolicy>;
  /** Policy override on the Gateway rail, where the item costs 0.001 USDC. */
  gatewayPolicy?: Partial<SpendingPolicy>;
  tamper?: boolean;
  /** FIXTURE fault: Circle settles the first payment, but its response never reaches the merchant. */
  loseSettleResponse?: boolean;
  /** Rails the scenario applies to. Default: both. */
  rails?: PaymentRail[];
}

export const SCENARIOS: Record<ScenarioId, Scenario> = {
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
    rails: ["arc-eip3009"],
  },
  budget: {
    label: "Budget denial",
    detail: "FIXTURE policy: the mission budget is below the item price (0.04 USDC against 0.05 on Arc direct; 0.0005 against 0.001 on Gateway).",
    freeCheck: "observed-2026-11-18",
    policy: { missionBudget: 40_000n },
    gatewayPolicy: { missionBudget: 500n },
  },
  tampered: {
    label: "Receipt rejection",
    detail: "FIXTURE fault: one response byte is altered in transit, so the buyer must reject the delivery.",
    freeCheck: "observed-2026-11-18",
    tamper: true,
  },
  lost_response: {
    label: "Lost Gateway response",
    detail: "FIXTURE fault: Circle settles the payment but its answer never reaches the merchant. The retry must find the transfer by nonce and deliver without a second settlement.",
    freeCheck: "observed-2026-11-18",
    loseSettleResponse: true,
    rails: ["circle-gateway-batched"],
  },
};

/**
 * FIXTURE fault for the Gateway rail: Circle settles the first payment, then the answer is lost,
 * as with a socket hang-up. The merchant must recover by nonce on the retry without settling again.
 */
function dropFirstSettleResponse(inner: MockGatewayProvider, world: World): GatewayProvider {
  return {
    mode: inner.mode,
    verify: (payload, requirements) => inner.verify(payload, requirements),
    async settle(payload, requirements) {
      const result = await inner.settle(payload, requirements);
      if (world.lostSettleResponses > 0) return result;
      world.lostSettleResponses += 1;
      throw new Error("FIXTURE: settle response lost in transit");
    },
    transferByNonce: (lookup) => inner.transferByNonce(lookup),
    transferById: (id) => inner.transferById(id),
  };
}

export class AppError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const settleCalls = (world: World) => (world.gateway ? world.gateway.settleCalls : world.settlement.settleCalls);
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
  /** Gateway rail only: the FIXTURE Circle Gateway, and the buyer ledger for Gateway receipts and Circle statuses. */
  gateway: MockGatewayProvider | null;
  gatewayLedger: GatewayLedger | null;
  /** Settle responses the FIXTURE fault dropped after Circle had settled. */
  lostSettleResponses: number;
}

interface CircleObservation {
  kind: "poll" | "stale";
  atUtc: string;
  transfer: { id: string; status: GatewayTransfer["status"]; txHash: string | null } | null;
  /** What the buyer ledger did with it. */
  result: string;
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
  rail: PaymentRail;
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
    | { state: "verified"; outcome: string; receipt: SignedDeliveryReceiptV1 | SignedGatewayReceipt; receiptDigest: Hex; body: Uint8Array; verifiedAtUtc: string }
    | { state: "rejected"; code: string; reason: string; verifiedAtUtc: string }
    | null;
  webhooks: WebhookAttempt[];
  lastDelivery: SignedDelivery | null;
  /** Gateway rail: Circle transfer responses the buyer applied, oldest first. */
  circle: CircleObservation[];
  circleResponses: GatewayTransfer[];
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

  async createRun(input: { marketId?: unknown; scenario?: unknown; rail?: unknown; live?: unknown }, actor: Actor): Promise<Run> {
    const live = parseLive(input.live);
    if (!live && (typeof input.marketId !== "string" || !this.#markets.has(input.marketId))) throw new AppError(400, "unknown market");
    const scenario = (typeof input.scenario === "string" ? input.scenario : "standard") as ScenarioId;
    if (live && scenario !== "standard") throw new AppError(400, "live runs use the standard scenario only");
    if (!(scenario in SCENARIOS)) throw new AppError(400, "unknown scenario");
    const rail = (input.rail === undefined || input.rail === null ? "arc-eip3009" : input.rail) as PaymentRail;
    if (!(typeof rail === "string" && rail in RAILS)) throw new AppError(400, "unknown payment rail");
    const allowed = SCENARIOS[scenario].rails;
    if (allowed && !allowed.includes(rail)) throw new AppError(400, `scenario ${scenario} does not apply to the ${rail} rail`);
    let analysis: AnalyzeOutput;
    let market: FixtureMarket;
    if (live) {
      try {
        analysis = await this.#analyst.analyzeLive(live.event, live.outcome, rail);
      } catch (error) {
        throw new AppError(502, `live analysis failed: ${(error as Error).message.slice(0, 300)}`);
      }
      market = liveMarketFrom(analysis, Date.now() / 1000);
    } else {
      analysis = await this.#analyst.analyze(input.marketId as string, SCENARIOS[scenario].freeCheck, rail);
      market = this.#markets.get(input.marketId as string)!;
    }
    const run: Run = {
      id: `run-${randomBytes(8).toString("hex")}`,
      createdAtUtc: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
      marketId: market.contractId,
      scenario,
      rail,
      analysis,
      market,
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
      circle: [],
      circleResponses: [],
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
    const onGateway = run.rail === "circle-gateway-batched";
    world.store = new PaymentStore(":memory:", { ...DEMO_POLICY, ...(onGateway ? scenario.gatewayPolicy : scenario.policy) });
    if (this.#paused) world.store.setPaused(true, world.clock, this.#pausedReason);
    world.ledger = new ReconciliationLedger(world.store);
    world.settlement = new StubSettlement();
    world.lostSettleResponses = 0;
    world.gateway = onGateway ? new MockGatewayProvider({ now, balances: { [DEMO_PAYER.address]: 10_000n } }) : null;
    world.gatewayLedger = onGateway ? new GatewayLedger(world.store) : null;
    world.merchant = new MerchantService({
      config: DEMO_MERCHANT_CONFIG,
      signer: DEMO_MERCHANT_SIGNER,
      settlement: world.settlement,
      now,
      sessions: { [SESSION_TOKEN]: `session-${run.id}` },
      ...(world.gateway ? { gateway: scenario.loseSettleResponse ? dropFirstSettleResponse(world.gateway, world) : world.gateway } : {}),
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
      case "circle":
        await this.#circle(run, "poll");
        break;
      case "circle-stale":
        await this.#circle(run, "stale");
        break;
      case "batch":
        this.#batch(run);
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
    this.#log(run, "operator", kind, `Merchant answered ${response.status}${reason ? ` (${reason})` : ""}. Settle calls so far: ${settleCalls(world)}. Authorization ${payment.reused ? "reused" : "signed once"}.`);
  }

  async #verify(run: Run) {
    const world = run.world;
    if (!world || !run.lastResponse) throw new AppError(409, "no delivered response to verify");
    const stored = world.store.get(run.purchaseId!)!;
    if (world.gatewayLedger) {
      const verdict = await verifyGatewayDelivery({
        receiptHeader: run.lastResponse.receiptHeader,
        body: run.lastResponse.bytes,
        trusted: { merchantId: DEMO_MERCHANT_CONFIG.merchantId, receiptSigner: DEMO_MERCHANT_SIGNER.address },
        request: stored.request,
        authorizationNonce: stored.nonce,
      });
      if (!verdict.ok) {
        run.delivery = { state: "rejected", code: verdict.code, reason: verdict.reason, verifiedAtUtc: iso(world.clock) };
        this.#log(run, "system", "verify", `Delivery rejected: ${verdict.code}. The analyst never sees these bytes.`);
        return;
      }
      const recorded = world.gatewayLedger.recordVerifiedDelivery({ receipt: verdict.receipt, digest: verdict.digest, now: world.clock });
      if (recorded.kind === "mismatch") {
        run.delivery = { state: "rejected", code: "ledger_mismatch", reason: recorded.detail, verifiedAtUtc: iso(world.clock) };
        this.#log(run, "system", "verify", `Receipt verified but refused by the ledger: ${recorded.detail}. The analyst never sees these bytes.`);
        return;
      }
      run.delivery = { state: "verified", outcome: recorded.kind, receipt: verdict.receipt, receiptDigest: verdict.digest, body: run.lastResponse.bytes, verifiedAtUtc: iso(world.clock) };
      this.#log(run, "system", "verify", `V2 receipt and bytes verified (${recorded.kind}). Circle transfer ${verdict.receipt.paymentRef}.`);
      return;
    }
    const result = await acceptDelivery({
      response: { body: run.lastResponse.bytes, receiptHeader: run.lastResponse.receiptHeader },
      trusted: { merchantId: DEMO_MERCHANT_CONFIG.merchantId, receiptSigner: DEMO_MERCHANT_SIGNER.address },
      request: stored.request,
      store: world.ledger,
      now: world.clock,
    });
    if (result.accepted) {
      const { signature: _sig, ...unsigned } = result.receipt;
      run.delivery = { state: "verified", outcome: result.outcome.kind, receipt: result.receipt, receiptDigest: receiptDigest(unsigned), body: result.body, verifiedAtUtc: iso(world.clock) };
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
      delivery = this.#chainDelivery(run, world, world.clock, world.clock);
      run.lastDelivery = delivery;
    } else {
      if (!run.lastDelivery) throw new AppError(409, "send the on-chain event first");
      delivery = run.lastDelivery;
      if (kind === "forged") {
        const sig = delivery.headers["x-qn-signature"]!;
        delivery = { ...delivery, headers: { ...delivery.headers, "x-qn-signature": `${sig.slice(0, -1)}${sig.endsWith("0") ? "1" : "0"}` } };
      }
      if (kind === "stale") {
        const first = JSON.parse(run.lastDelivery.payload) as { matches?: { blockTimestamp?: string }[]; gatewayBatches?: { blockTimestamp?: string }[] };
        const blockTimestamp = Number(first.matches?.[0]?.blockTimestamp ?? first.gatewayBatches?.[0]?.blockTimestamp ?? world.clock);
        delivery = this.#chainDelivery(run, world, blockTimestamp, world.clock - WEBHOOK_MAX_SKEW_SECONDS - 60);
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
    const batch = world.gatewayLedger && run.purchaseId ? world.gatewayLedger.status(run.purchaseId)?.batch.txHash : null;
    const chain = world.gatewayLedger
      ? `Batch ${batch && world.ledger.gatewayBatch(batch) ? "confirmed" : "not confirmed"} by QuickNode.`
      : `Settlements recorded: ${counts.settlements}.`;
    this.#log(run, "system", `webhook:${kind}`, `QuickNode handler answered ${response.status}${parsed.duplicateEvent ? " (duplicate event)" : ""}. ${chain}`);
  }

  /**
   * The signed QuickNode delivery the fixture chain would send for this run: the purchase's own
   * transaction (Arc direct) or the Gateway batch transaction Circle reported for the transfer.
   */
  #chainDelivery(run: Run, world: World, blockTimestamp: number, timestamp: number): SignedDelivery {
    if (world.gatewayLedger) {
      const batchTx = run.purchaseId ? world.gatewayLedger.status(run.purchaseId)?.batch.txHash : null;
      if (!batchTx) throw new AppError(409, "Circle has not reported a batch transaction for this transfer yet");
      return signedGatewayBatchDelivery({ batchTxHash: batchTx as Hex, blockTimestamp, securityToken: QUICKNODE_TOKEN, timestamp, streamId: "fixture-app-stream" });
    }
    const settled = world.settlement.settled[0];
    if (!settled) throw new AppError(409, "the merchant has not settled anything yet");
    return signedFixtureDelivery({ settled, blockTimestamp, txFrom: DEMO_MERCHANT_SIGNER.address, securityToken: QUICKNODE_TOKEN, timestamp, streamId: "fixture-app-stream" });
  }

  /**
   * Gateway rail: the buyer asks Circle for the transfer behind its own authorization (by nonce,
   * payer and payee), or re-applies the oldest response it saw ("stale"). Either may come before or
   * after the verified receipt; the ledger keeps one transfer per purchase and moves status forward only.
   */
  async #circle(run: Run, kind: CircleObservation["kind"]) {
    const world = run.world;
    if (!world?.gateway || !world.gatewayLedger) throw new AppError(409, "Circle transfer status applies to the Gateway rail only");
    const stored = run.purchaseId ? world.store.get(run.purchaseId) : undefined;
    if (!stored || stored.signature === null) throw new AppError(409, "nothing has been authorized in this run");
    let transfer: GatewayTransfer | undefined;
    if (kind === "poll") {
      transfer = await world.gateway.transferByNonce({ nonce: stored.nonce, from: stored.request.payer, to: stored.request.payTo });
      if (transfer) run.circleResponses.push({ ...transfer });
    } else {
      transfer = run.circleResponses[0];
      if (!transfer) throw new AppError(409, "no earlier Circle response to replay");
    }
    let result: string;
    if (!transfer) {
      result = "Circle has no transfer for this authorization yet.";
    } else {
      const applied = world.gatewayLedger.recordBatch(stored.purchaseId, transfer, world.clock);
      result = "error" in applied
        ? `Refused: ${applied.error}`
        : `Ledger: ${applied.acceptance}, Circle status ${applied.batch.status}, settlement ${applied.settlement}.`;
    }
    run.circle.push({ kind, atUtc: iso(world.clock), transfer: transfer ? { id: transfer.id, status: transfer.status, txHash: transfer.txHash } : null, result });
    const what = kind === "poll" ? "Circle transfer" : "Replayed older Circle response";
    this.#log(run, "system", kind === "poll" ? "circle" : "circle-stale", `${what}${transfer ? ` ${transfer.id} (${transfer.status})` : ""}. ${result}`);
  }

  /** FIXTURE Circle: open transfers move one step (received -> batched with a batch tx -> completed). */
  #batch(run: Run) {
    const world = run.world;
    if (!world?.gateway) throw new AppError(409, "batching applies to the Gateway rail only");
    world.gateway.advanceBatch();
    this.#log(run, "system", "batch", "FIXTURE Circle advanced open transfers one step.");
  }

  async #reassess(run: Run) {
    // The gate: reassessment runs only on bytes the buyer verified against a signed receipt bound to this request.
    if (run.delivery?.state !== "verified") throw new AppError(409, "reassessment waits for a verified receipt and delivered bytes");
    if (run.reassessment) throw new AppError(409, "already reassessed");
    const proposal = run.analysis.purchase_proposal!;
    const { receipt, body, receiptDigest: digest } = run.delivery;
    const common = {
      purchase_id: receipt.purchaseId,
      contract_id: proposal.contract_id,
      evidence_gap_id: proposal.evidence_gap_id,
      catalog_item_id: proposal.catalog_item_id,
      merchant_id: receipt.merchantId,
      request_hash: receipt.requestHash,
      content_hash_keccak256: receipt.contentHash,
      content_sha256: `0x${createHash("sha256").update(body).digest("hex")}`,
      receipt_digest: digest,
      receipt_signer: receipt.merchant,
      data_label: "FIXTURE",
    };
    run.reassessment = await this.#analyst.reassess(
      run.analysis.risk_analysis,
      body,
      "paymentRef" in receipt
        ? { ...common, verified_by: "verifyGatewayDelivery", payment_rail: "circle-gateway-batched", payment_ref: receipt.paymentRef }
        : { ...common, tx_hash: receipt.txHash, verified_by: "verifyDelivery" },
    );
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
    const gatewayStatus = world?.gatewayLedger && run.purchaseId ? world.gatewayLedger.status(run.purchaseId) : undefined;
    const proposal = a.purchase_proposal;
    return {
      id: run.id,
      label: run.market.label === "LIVE" ? "LIVE read-only analysis (public sources); payments are FIXTURE" : "FIXTURE",
      createdAtUtc: run.createdAtUtc,
      scenario: { id: run.scenario, label: SCENARIOS[run.scenario].label, detail: SCENARIOS[run.scenario].detail },
      rail: { id: run.rail, ...RAILS[run.rail] },
      pricing: {
        marketImplied: {
          kind: "market-implied",
          value: run.market.quote.impliedProbability,
          state: run.market.quote.state,
          note: run.market.quote.note,
          observedAtUtc: run.market.quote.observedAtUtc,
          observedDate: run.market.quote.observedDate,
          source: run.market.source.label,
          sourceUrl: run.market.source.url,
          label: `${run.market.label === "LIVE" ? "LIVE reading" : "FIXTURE snapshot"} of the Gemini Exchange order book (mid of best bid and ask). Not a forecast.`,
        },
        modelEstimate: {
          kind: "model-estimate",
          value: null,
          state: "unavailable",
          note: "Verity's analysis does not produce an outcome probability. It rates how the contract settles, not who wins.",
        },
      },
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
            ? {
                state: "verified",
                contentHash: run.delivery.receipt.contentHash,
                receiptDigest: run.delivery.receiptDigest,
                receiptTx: "txHash" in run.delivery.receipt ? run.delivery.receipt.txHash : null,
                circleTransferId: "paymentRef" in run.delivery.receipt ? run.delivery.receipt.paymentRef : null,
                atUtc: run.delivery.verifiedAtUtc,
              }
            : { state: "rejected", code: run.delivery.code, reason: run.delivery.reason, atUtc: run.delivery.verifiedAtUtc }
          : run.lastResponse
            ? { state: "received_unverified" }
            : { state: "not_received" },
        settlement: gatewayStatus
          ? {
              state: gatewayStatus.settlement,
              circleStatus: gatewayStatus.batch.status,
              batchTxHash: gatewayStatus.batch.txHash,
              label: "FIXTURE: Circle Gateway mock; derived batch tx hash, not on Arc Testnet",
            }
          : world?.gateway
            ? { state: world.gateway.settleCalls > 0 ? "submitted_to_gateway" : "none", label: "FIXTURE Circle Gateway mock" }
          : settlement
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
      audit: this.audit(run),
      timeline: run.timeline,
    };
  }

  /**
   * One record per run that links the run, the purchase, the signed receipt, and the payment evidence,
   * naming the source of each value. Circle identifies an individual Gateway transfer; QuickNode
   * confirms only the Arc batch transaction it settled in. Every value here is FIXTURE.
   */
  audit(run: Run) {
    const world = run.world;
    const purchaseId = run.purchaseId;
    const stored = world && purchaseId ? world.store.get(purchaseId) : undefined;
    const delivery = run.delivery;
    const verified = delivery?.state === "verified" ? delivery : undefined;
    const clock = world?.clock ?? PAYMENT_START;
    const base = {
      label: "FIXTURE",
      runId: run.id,
      purchaseId,
      marketId: run.marketId,
      rail: run.rail,
      quote: run.quote
        ? {
            quoteId: run.quote.quoteId,
            amountUsdc: usdc(run.quote.amount),
            expiresAtUtc: iso(run.quote.expiresAt),
            freshness: run.quote.expiresAt > clock ? "fresh" : "expired",
            secondsLeft: Math.max(0, run.quote.expiresAt - clock),
            asOfUtc: iso(clock),
          }
        : null,
      approval: run.approval.state,
      authorization: stored ? { status: stored.status, requestHash: stored.requestHash, nonce: stored.nonce, payer: stored.request.payer, payTo: stored.request.payTo } : null,
      receipt: verified
        ? {
            state: "verified",
            version: verified.receipt.version,
            digest: verified.receiptDigest,
            signer: verified.receipt.merchant,
            merchantId: verified.receipt.merchantId,
            contentHash: verified.receipt.contentHash,
            issuedAtUtc: iso(verified.receipt.issuedAt),
            verifiedAtUtc: verified.verifiedAtUtc,
          }
        : delivery?.state === "rejected"
          ? { state: "rejected", code: delivery.code, reason: delivery.reason }
          : { state: run.lastResponse ? "received_unverified" : "not_received" },
      reassessment: {
        state: run.reassessment ? run.reassessment.status : verified ? "ready" : "waits_for_verified_delivery",
        gate: "Runs only on bytes verified against the signed receipt for this purchase.",
      },
    };
    if (run.rail === "circle-gateway-batched") {
      const g = world?.gatewayLedger && purchaseId ? world.gatewayLedger.status(purchaseId) : undefined;
      const batchTx = g?.batch.txHash ?? null;
      const confirmation = batchTx && world ? world.ledger.gatewayBatch(batchTx) : undefined;
      const receiptRef = verified && "paymentRef" in verified.receipt ? verified.receipt.paymentRef : null;
      return {
        ...base,
        payment: {
          circleTransfer: {
            source: "Circle Gateway transfer record (FIXTURE mock)",
            role: "Identifies this individual payment: payer, payee, amount, and authorization nonce.",
            id: g?.paymentRef ?? receiptRef,
            status: g?.batch.status ?? "unknown",
            ledger: g?.acceptance ?? "none",
            receiptNamesSameTransfer: receiptRef && g ? receiptRef === g.paymentRef : null,
          },
          arcBatch: { txHash: batchTx, settlement: g?.settlement ?? "none", source: batchTx ? "reported by Circle for this transfer" : null },
          quicknode: {
            batch: confirmation
              ? { state: "confirmed", blockNumber: confirmation.blockNumber, finalized: true, source: confirmation.source }
              : { state: batchTx ? "pending" : "waits_for_batch_tx" },
            perTransfer: g?.quicknode ?? { status: "not_claimed", reason: "Gateway batches many payments into one transaction; QuickNode confirms the batch only." },
          },
        },
        portal: purchaseId
          ? { paymentRef: g?.paymentRef ?? receiptRef, receiptDigest: verified?.receiptDigest ?? null, batchStatus: g?.batch.status ?? null, batchTxHash: batchTx }
          : null,
      };
    }
    const settlement = world && purchaseId ? world.ledger.settlement(purchaseId) : undefined;
    const receiptTx = verified && "txHash" in verified.receipt ? verified.receipt.txHash : null;
    return {
      ...base,
      payment: {
        transaction: { txHash: settlement?.txHash ?? receiptTx, source: settlement ? "QuickNode-observed AuthorizationUsed (FIXTURE delivery)" : receiptTx ? "named in the signed receipt" : null },
        quicknode: settlement
          ? { state: "confirmed", blockNumber: settlement.blockNumber, source: settlement.source, ledgerOutcome: settlement.ledgerOutcome }
          : { state: world && settleCalls(world) > 0 ? "pending" : "none" },
      },
      portal: null,
    };
  }

  /** Audit records for every run that reached a quote, newest first. */
  auditLog() {
    return [...this.runs.values()].filter((run) => run.purchaseId).reverse().map((run) => this.audit(run));
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
        settleCalls: world ? settleCalls(world) : 0,
        gateway: world?.gateway
          ? { verifyCalls: world.gateway.verifyCalls, settleCalls: world.gateway.settleCalls, lostSettleResponses: world.lostSettleResponses, circle: run.circle }
          : null,
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
