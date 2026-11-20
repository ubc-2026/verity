/**
 * Acceptance: the whole Issue #8 flow on fixtures, from fixture analysis through
 * proposal validation, the capped quote, policy and owner approval, signing,
 * the merchant (Arc direct or Circle Gateway), receipt verification, the durable
 * buyer ledgers, Circle transfer status, QuickNode confirmation, and reassessment.
 *
 * Buyer and merchant state live in SQLite files, so a "restart" closes every
 * service and reopens it from disk. Circle Gateway and the chain are external:
 * the FIXTURE Circle mock and the stubbed settlement survive restarts, as the
 * real ones would. The payer signer counts its calls.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";
import { keccak256, toBytes, type Hex } from "viem";
import { MockGatewayProvider } from "../scripts/e2e/mockGateway.ts";
import { Analyst, findPython, withResearch, type AnalyzeOutput, type LiveAnalyzeOutput } from "../src/app/analyst.ts";
import { PAYMENT_START, RunEngine } from "../src/app/engine.ts";
import { FIXTURE_FINALIZED_BLOCK, signedFixtureDelivery, signedGatewayBatchDelivery, StubSettlement, type SignedDelivery } from "../src/app/fixtureChain.ts";
import { loadFixtureMarkets } from "../src/app/markets.ts";
import { ARC_TESTNET } from "../src/payments/arc.ts";
import { BINDING_HEADER } from "../src/payments/binding.ts";
import { catalogById } from "../src/payments/catalog.ts";
import type { GatewayProvider, GatewayTransfer, PaymentRail } from "../src/payments/circleGateway.ts";
import { acceptDelivery, RECEIPT_HEADER } from "../src/payments/deliveryReceipt.ts";
import { GatewayLedger } from "../src/payments/gatewayLedger.ts";
import { verifyGatewayDelivery } from "../src/payments/gatewayReceipt.ts";
import type { PaymentSigner } from "../src/payments/paymentService.ts";
import { approvalTypedData } from "../src/payments/policy.ts";
import { acceptPurchaseProposal, type AcceptedProposal } from "../src/payments/proposal.ts";
import { BuyerService, type PurchaseResult } from "../src/payments/purchase.ts";
import { parseQuote, type VerityQuote } from "../src/payments/quote.ts";
import { encodePaymentHeader, handleMerchantHttp, PAYMENT_HEADER } from "../src/payments/server.ts";
import { MerchantService } from "../src/payments/service.ts";
import { DEMO_POLICY, PaymentStore, type SpendingPolicy } from "../src/payments/store.ts";
import { ReconciliationLedger } from "../src/reconciliation/ledger.ts";
import { createQuickNodeWebhookHandler, QUICKNODE_WEBHOOK_PATH } from "../src/reconciliation/webhook.ts";
import { DEMO_MERCHANT_CONFIG, DEMO_MERCHANT_SIGNER, DEMO_OWNER, DEMO_PAYER } from "./fixtures/scenario.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const analysisDir = join(root, "analysis");
const NYC = "fx-nyc-high-20261118";
const SESSION = "fixture-acceptance-session-token-01"; // FIXTURE, in-process only
const QUICKNODE_TOKEN = "fixture-acceptance-quicknode-token"; // FIXTURE
const TRUSTED = { merchantId: DEMO_MERCHANT_CONFIG.merchantId, receiptSigner: DEMO_MERCHANT_SIGNER.address };

let python: string | undefined;
let skip: string | false = false;
try {
  python = findPython(analysisDir);
} catch (error) {
  skip = `acceptance tests need Python for the fixture analysis: ${(error as Error).message}`;
}

/** The payer's signer, counting every signature. Nothing else can sign a payment. */
class CountingSigner implements PaymentSigner {
  readonly address = DEMO_PAYER.address;
  calls = 0;
  signTypedData(args: Parameters<PaymentSigner["signTypedData"]>[0]) {
    this.calls += 1;
    return DEMO_PAYER.signTypedData(args);
  }
}

interface PaidResponse {
  status: number;
  bytes: Uint8Array;
  receiptHeader: string | undefined;
  reason: string | null;
}

/** One buyer + merchant deployment on disk, plus the external Circle and chain. */
class Harness {
  readonly rail: PaymentRail;
  readonly dir = mkdtempSync(join(tmpdir(), "verity-acceptance-"));
  readonly signer = new CountingSigner();
  readonly circle: MockGatewayProvider;
  readonly chain = new StubSettlement();
  readonly policy: SpendingPolicy;
  clock = PAYMENT_START;
  lostSettles = 0;
  #loseFirstSettle: boolean;
  #salt = 0;
  store!: PaymentStore;
  ledger!: ReconciliationLedger;
  gatewayLedger!: GatewayLedger;
  merchant!: MerchantService;
  buyer!: BuyerService;
  #webhook!: { server: Server; port: number };

  constructor(rail: PaymentRail, options: { policy?: Partial<SpendingPolicy>; loseFirstSettle?: boolean } = {}) {
    this.rail = rail;
    this.policy = { ...DEMO_POLICY, ...options.policy };
    this.#loseFirstSettle = options.loseFirstSettle ?? false;
    this.circle = new MockGatewayProvider({ now: () => this.clock, balances: { [DEMO_PAYER.address]: 10_000n } });
  }

  async open() {
    const now = () => this.clock;
    this.store = new PaymentStore(join(this.dir, "buyer.sqlite"), this.policy);
    this.ledger = new ReconciliationLedger(this.store);
    this.gatewayLedger = new GatewayLedger(this.store);
    const circle = this.circle;
    const harness = this;
    const gateway: GatewayProvider = {
      mode: "fixture",
      verify: (payload, requirements) => circle.verify(payload, requirements),
      async settle(payload, requirements) {
        const result = await circle.settle(payload, requirements);
        if (harness.#loseFirstSettle && harness.lostSettles === 0) {
          harness.lostSettles += 1;
          throw new Error("FIXTURE: settle response lost in transit");
        }
        return result;
      },
      transferByNonce: (lookup) => circle.transferByNonce(lookup),
      transferById: (id) => circle.transferById(id),
    };
    this.merchant = new MerchantService({
      config: DEMO_MERCHANT_CONFIG,
      signer: DEMO_MERCHANT_SIGNER,
      settlement: this.chain,
      now,
      sessions: { [SESSION]: "session-acceptance" },
      dbPath: join(this.dir, "merchant.sqlite"),
      gateway,
    });
    this.buyer = new BuyerService({
      store: this.store,
      catalog: catalogById(),
      owner: DEMO_OWNER.address,
      signer: this.signer,
      tokenDomain: ARC_TESTNET.usdcDomain,
      missionId: "mission-acceptance",
      saltSource: () => keccak256(toBytes(`verity-acceptance-salt|${this.dir}|${this.#salt++}`)),
    });
    const handler = createQuickNodeWebhookHandler({
      securityToken: QUICKNODE_TOKEN,
      ledger: this.ledger,
      finalizedBlock: async () => FIXTURE_FINALIZED_BLOCK,
      now,
      source: "fixture-signed-locally",
      maxTimestampSkewSeconds: 300,
    });
    const server = createServer((req, res) => void handler(req, res));
    const port = await new Promise<number>((done) => server.listen(0, "127.0.0.1", () => done((server.address() as AddressInfo).port)));
    this.#webhook = { server, port };
    return this;
  }

  async #shut() {
    await new Promise<void>((done) => this.#webhook.server.close(() => done()));
    this.merchant.close();
    this.store.close();
  }

  /** Closes every service and reopens it from the same files. */
  async restart() {
    await this.#shut();
    await this.open();
  }

  async close() {
    await this.#shut();
    rmSync(this.dir, { recursive: true, force: true });
  }

  async quote(accepted: AcceptedProposal, purchaseId: string): Promise<VerityQuote> {
    const response = await handleMerchantHttp(
      this.merchant,
      "POST",
      "/quotes",
      { authorization: `Bearer ${SESSION}`, "content-type": "application/json" },
      new TextEncoder().encode(JSON.stringify({ catalogItemId: accepted.selection.catalogItemId, purchaseId, parameters: accepted.selection.parameters, catalogParameters: accepted.catalogParameters })),
      DEMO_MERCHANT_CONFIG.origin,
    );
    const body = response.body as { quote?: unknown; reason?: string };
    assert.equal(response.status, 402, `quote refused: ${body.reason}`);
    return parseQuote(body.quote);
  }

  async pay(result: PurchaseResult): Promise<PaidResponse> {
    assert.equal(result.status, "authorized");
    if (result.status !== "authorized") throw new Error("not authorized");
    const { request, payment } = result;
    const response = await handleMerchantHttp(
      this.merchant,
      "POST",
      new URL(request.resourceUrl).pathname,
      {
        authorization: `Bearer ${SESSION}`,
        "content-type": "application/json",
        [BINDING_HEADER.toLowerCase()]: payment.bindingHeader,
        [PAYMENT_HEADER.toLowerCase()]: encodePaymentHeader({ chainId: request.chainId, token: request.token, authorization: payment.authorization }),
      },
      new TextEncoder().encode(JSON.stringify(request.parameters)),
      DEMO_MERCHANT_CONFIG.origin,
    );
    const headers = Object.fromEntries(Object.entries(response.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
    const bytes = response.body instanceof Uint8Array ? new Uint8Array(response.body) : new Uint8Array();
    const reason = response.body instanceof Uint8Array ? null : ((response.body as { reason?: string }).reason ?? null);
    return { status: response.status, bytes, receiptHeader: headers[RECEIPT_HEADER.toLowerCase()], reason };
  }

  /** Buyer verification, then the durable ledger. Returns the ledger outcome kind, or the rejection code. */
  async verify(purchaseId: string, response: PaidResponse): Promise<string> {
    const stored = this.store.get(purchaseId)!;
    if (this.rail === "circle-gateway-batched") {
      const verdict = await verifyGatewayDelivery({ receiptHeader: response.receiptHeader, body: response.bytes, trusted: TRUSTED, request: stored.request, authorizationNonce: stored.nonce });
      if (!verdict.ok) return `rejected:${verdict.code}`;
      const recorded = this.gatewayLedger.recordVerifiedDelivery({ receipt: verdict.receipt, digest: verdict.digest, now: this.clock });
      return recorded.kind;
    }
    const result = await acceptDelivery({ response: { body: response.bytes, receiptHeader: response.receiptHeader }, trusted: TRUSTED, request: stored.request, store: this.ledger, now: this.clock });
    return result.accepted ? result.outcome.kind : `rejected:${result.code}`;
  }

  /** The buyer asks Circle for the transfer behind its own authorization and applies it. */
  async circlePoll(purchaseId: string): Promise<GatewayTransfer | undefined> {
    const stored = this.store.get(purchaseId)!;
    const transfer = await this.circle.transferByNonce({ nonce: stored.nonce, from: stored.request.payer, to: stored.request.payTo });
    if (transfer) {
      const applied = this.gatewayLedger.recordBatch(purchaseId, transfer, this.clock);
      assert.ok(!("error" in applied), JSON.stringify(applied));
    }
    return transfer;
  }

  async quicknode(delivery: SignedDelivery) {
    const response = await fetch(`http://127.0.0.1:${this.#webhook.port}${QUICKNODE_WEBHOOK_PATH}`, { method: "POST", headers: delivery.headers, body: delivery.payload });
    return { status: response.status, body: (await response.json()) as { duplicateEvent: boolean; outcomes: { kind: string }[] } };
  }

  directDelivery(): SignedDelivery {
    return signedFixtureDelivery({ settled: this.chain.settled[0]!, blockTimestamp: this.clock, txFrom: DEMO_MERCHANT_SIGNER.address, securityToken: QUICKNODE_TOKEN, timestamp: this.clock, streamId: "acceptance" });
  }

  batchDelivery(txHash: string): SignedDelivery {
    return signedGatewayBatchDelivery({ batchTxHash: txHash as Hex, blockTimestamp: this.clock, securityToken: QUICKNODE_TOKEN, timestamp: this.clock, streamId: "acceptance" });
  }

  settleCalls() {
    return this.rail === "circle-gateway-batched" ? this.circle.settleCalls : this.chain.settleCalls;
  }

  count(table: string, purchaseId: string) {
    return (this.store.database.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE purchase_id = ?`).get(purchaseId) as { n: number }).n;
  }
}

describe("acceptance: one payment and one verified delivery, in any order, across replays and restarts", { skip }, () => {
  const analyses = new Map<PaymentRail, AnalyzeOutput>();
  const harnesses: Harness[] = [];
  let purchaseSeq = 0;

  before(async () => {
    const analyst = new Analyst(python!, analysisDir);
    for (const rail of ["arc-eip3009", "circle-gateway-batched"] as const) analyses.set(rail, await analyst.analyze(NYC, "observed-2026-11-18", rail));
  });
  after(async () => {
    for (const h of harnesses) await h.close().catch(() => {});
  });

  async function start(rail: PaymentRail, options?: ConstructorParameters<typeof Harness>[1]) {
    const h = await new Harness(rail, options).open();
    harnesses.push(h);
    const proposal = analyses.get(rail)!.purchase_proposal;
    assert.ok(proposal, "fixture analysis proposes the settlement-version evidence");
    const accepted = acceptPurchaseProposal(proposal as never, catalogById(), { expectedContractId: NYC });
    const purchaseId = `purchase-acceptance-${(purchaseSeq++).toString().padStart(4, "0")}`;
    const quote = await h.quote(accepted, purchaseId);
    return { h, accepted, purchaseId, quote };
  }

  it("Gateway, receipt first: replays of the paid request, the receipt, Circle and QuickNode change nothing", async () => {
    const { h, accepted, purchaseId, quote } = await start("circle-gateway-batched");
    const authorized = await h.buyer.purchase({ accepted, purchaseId, quote, now: h.clock });
    assert.equal(authorized.status, "authorized");
    assert.equal(h.signer.calls, 1);
    const first = await h.pay(authorized);
    assert.equal(first.status, 200);
    assert.equal(await h.verify(purchaseId, first), "accepted");
    assert.equal(h.gatewayLedger.status(purchaseId)?.acceptance, "accepted_by_gateway");
    assert.equal(h.store.reservation(purchaseId)?.status, "held", "Gateway acceptance alone does not spend the reservation");

    // Replays: the buyer resends the stored authorization; the merchant replays its stored receipt.
    const again = await h.buyer.purchase({ accepted, purchaseId, quote, now: h.clock });
    assert.equal(again.status === "authorized" && again.payment.reused, true);
    const replay = await h.pay(again);
    assert.equal(replay.status, 200);
    assert.equal(replay.receiptHeader, first.receiptHeader, "byte-identical receipt");
    assert.equal(await h.verify(purchaseId, replay), "already_recorded");

    // Circle: received -> batched (batch tx) -> completed, each polled twice.
    assert.equal((await h.circlePoll(purchaseId))?.status, "received");
    h.circle.advanceBatch();
    const batched = await h.circlePoll(purchaseId);
    await h.circlePoll(purchaseId);
    assert.equal(batched?.status, "batched");
    assert.ok(batched?.txHash);
    const qn = await h.quicknode(h.batchDelivery(batched!.txHash!));
    assert.equal(qn.status, 200);
    assert.deepEqual(qn.body.outcomes.map((o) => o.kind), ["gateway_batch_confirmed"]);
    const qnReplay = await h.quicknode(h.batchDelivery(batched!.txHash!));
    assert.equal(qnReplay.body.duplicateEvent, true);
    assert.deepEqual(qnReplay.body.outcomes.map((o) => o.kind), ["gateway_batch_already_confirmed"]);
    h.circle.advanceBatch();
    assert.equal((await h.circlePoll(purchaseId))?.status, "completed");
    await h.circlePoll(purchaseId);

    assert.equal(h.settleCalls(), 1);
    assert.equal(h.signer.calls, 1);
    assert.equal(h.count("gateway_payments", purchaseId), 1);
    assert.equal(h.count("gateway_transfer_observations", purchaseId), 0);
    assert.equal(h.store.reservation(purchaseId)?.status, "spent");
    assert.equal(h.store.committedSpend("mission-acceptance"), 1000n);
    const status = h.gatewayLedger.status(purchaseId)!;
    assert.equal(status.settlement, "batch_settled");
    assert.equal(status.quicknode.status, "not_claimed", "QuickNode never claims the individual transfer");
    assert.equal(h.ledger.gatewayBatch(batched!.txHash!)?.status, "success_final");
  });

  it("Gateway, Circle first: the completed transfer is kept, and the later receipt must name the same transfer", async () => {
    const { h, accepted, purchaseId, quote } = await start("circle-gateway-batched");
    const response = await h.pay(await h.buyer.purchase({ accepted, purchaseId, quote, now: h.clock }));
    assert.equal(response.status, 200);
    // The receipt is held back; Circle's status arrives first.
    assert.equal((await h.circlePoll(purchaseId))?.status, "received");
    assert.equal(h.gatewayLedger.status(purchaseId)?.acceptance, "awaiting_verified_delivery");
    h.circle.advanceBatch();
    h.circle.advanceBatch();
    const completed = await h.circlePoll(purchaseId);
    assert.equal(completed?.status, "completed");
    await h.circlePoll(purchaseId);
    assert.equal(h.store.reservation(purchaseId)?.status, "spent");
    await h.restart();
    assert.equal(h.gatewayLedger.status(purchaseId)?.batch.status, "completed", "the observation survives a restart");

    assert.equal(await h.verify(purchaseId, response), "accepted");
    assert.equal(await h.verify(purchaseId, response), "already_recorded");
    const status = h.gatewayLedger.status(purchaseId)!;
    assert.equal(status.acceptance, "accepted_by_gateway");
    assert.equal(status.batch.status, "completed");
    assert.equal(status.paymentRef, completed!.id);
    assert.equal(h.count("gateway_payments", purchaseId), 1);
    assert.equal(h.store.committedSpend("mission-acceptance"), 1000n);
    assert.equal(h.settleCalls(), 1);
    assert.equal(h.signer.calls, 1);
  });

  it("Gateway: a lost settle response and restarts recover the delivery without a second settlement or signature", async () => {
    const { h, accepted, purchaseId, quote } = await start("circle-gateway-batched", { loseFirstSettle: true });
    const authorized = await h.buyer.purchase({ accepted, purchaseId, quote, now: h.clock });
    const lost = await h.pay(authorized);
    assert.notEqual(lost.status, 200);
    assert.equal(lost.receiptHeader, undefined);
    assert.equal(h.lostSettles, 1);
    assert.equal(h.circle.settleCalls, 1, "Circle did settle; only the answer was lost");

    await h.restart();
    h.clock += 30;
    const resumed = await h.buyer.purchase({ accepted, purchaseId, quote, now: h.clock });
    assert.equal(resumed.status === "authorized" && resumed.payment.reused, true, "the stored authorization is reused after the restart");
    const recovered = await h.pay(resumed);
    assert.equal(recovered.status, 200, recovered.reason ?? "");
    assert.equal(h.circle.settleCalls, 1, "recovered by nonce, no second settle");

    await h.restart();
    assert.equal(await h.verify(purchaseId, recovered), "accepted");
    const transfer = await h.circle.transferByNonce({ nonce: h.store.get(purchaseId)!.nonce, from: DEMO_PAYER.address, to: h.store.get(purchaseId)!.request.payTo });
    assert.equal(h.gatewayLedger.status(purchaseId)?.paymentRef, transfer?.id, "the receipt names the transfer Circle holds for this nonce");
    h.circle.advanceBatch();
    h.circle.advanceBatch();
    await h.circlePoll(purchaseId);

    await h.restart();
    const replay = await h.pay(await h.buyer.purchase({ accepted, purchaseId, quote, now: h.clock }));
    assert.equal(replay.status, 200);
    assert.equal(replay.receiptHeader, recovered.receiptHeader);
    assert.equal(await h.verify(purchaseId, replay), "already_recorded");
    assert.equal(h.gatewayLedger.status(purchaseId)?.settlement, "batch_settled");
    assert.equal(h.circle.settleCalls, 1);
    assert.equal(h.signer.calls, 1);
    assert.equal(h.store.committedSpend("mission-acceptance"), 1000n);
  });

  it("Gateway: stale Circle responses cannot regress a settled purchase, in either order or after a restart", async () => {
    for (const receiptFirst of [true, false]) {
      const { h, accepted, purchaseId, quote } = await start("circle-gateway-batched");
      const response = await h.pay(await h.buyer.purchase({ accepted, purchaseId, quote, now: h.clock }));
      if (receiptFirst) assert.equal(await h.verify(purchaseId, response), "accepted");
      const seen: GatewayTransfer[] = [];
      for (let step = 0; step < 3; step++) {
        seen.push((await h.circle.transferByNonce({ nonce: h.store.get(purchaseId)!.nonce, from: DEMO_PAYER.address, to: h.store.get(purchaseId)!.request.payTo }))!);
        h.circle.advanceBatch();
      }
      assert.deepEqual(seen.map((t) => t.status), ["received", "batched", "completed"]);
      assert.ok(!("error" in h.gatewayLedger.recordBatch(purchaseId, seen[2]!, h.clock)));
      await h.restart();
      for (const stale of [seen[0]!, seen[1]!, { ...seen[1]!, status: "failed" as const }, { ...seen[2]!, status: "confirmed" as const }]) {
        const applied = h.gatewayLedger.recordBatch(purchaseId, stale, h.clock + 1);
        assert.ok(!("error" in applied));
        if ("error" in applied) continue;
        assert.equal(applied.batch.status, "completed", `${stale.status} after completed is ignored`);
        assert.equal(applied.settlement, "batch_settled");
      }
      if (!receiptFirst) assert.equal(await h.verify(purchaseId, response), "accepted");
      assert.equal(h.gatewayLedger.status(purchaseId)?.batch.status, "completed");
      assert.equal(h.store.reservation(purchaseId)?.status, "spent");
      assert.equal(h.store.committedSpend("mission-acceptance"), 1000n);
      assert.equal(h.settleCalls(), 1);
    }
  });

  it("Arc direct: delivery first or settlement first, with replays and a restart between them", async () => {
    for (const deliveryFirst of [true, false]) {
      const { h, accepted, purchaseId, quote } = await start("arc-eip3009");
      const authorized = await h.buyer.purchase({ accepted, purchaseId, quote, now: h.clock });
      assert.equal(authorized.status, "authorized");
      const response = await h.pay(authorized);
      assert.equal(response.status, 200);
      if (deliveryFirst) assert.equal(await h.verify(purchaseId, response), "delivered_payment_unconfirmed");
      else assert.deepEqual((await h.quicknode(h.directDelivery())).body.outcomes.map((o) => o.kind), ["settlement_recorded"]);
      await h.restart();
      if (deliveryFirst) {
        const observed = await h.quicknode(h.directDelivery());
        assert.deepEqual(observed.body.outcomes.map((o) => o.kind), ["settlement_recorded"]);
      } else {
        assert.equal(await h.verify(purchaseId, response), "reconciled");
      }
      // Replays after the restart.
      const replayed = await h.quicknode(h.directDelivery());
      assert.equal(replayed.body.duplicateEvent, true);
      const retry = await h.pay(await h.buyer.purchase({ accepted, purchaseId, quote, now: h.clock }));
      assert.equal(retry.status, 200);
      assert.equal(retry.receiptHeader, response.receiptHeader);
      assert.equal(await h.verify(purchaseId, retry), "delivery_already_recorded");
      assert.equal(h.ledger.settlement(purchaseId)?.ledgerOutcome, "reconciled");
      assert.equal(h.ledger.counts().settlements, 1);
      assert.equal(h.settleCalls(), 1);
      assert.equal(h.signer.calls, 1);
      assert.equal(h.store.reservation(purchaseId)?.status, "spent");
    }
  });

  it("evidence delivered for another purchase never verifies for this one", async () => {
    const a = await start("circle-gateway-batched");
    const b = await start("circle-gateway-batched");
    const paidA = await a.h.pay(await a.h.buyer.purchase({ accepted: a.accepted, purchaseId: a.purchaseId, quote: a.quote, now: a.h.clock }));
    await b.h.buyer.purchase({ accepted: b.accepted, purchaseId: b.purchaseId, quote: b.quote, now: b.h.clock });
    assert.equal(paidA.status, 200);
    assert.match(await b.h.verify(b.purchaseId, paidA), /^rejected:/);
    assert.equal(b.h.gatewayLedger.status(b.purchaseId), undefined);
  });

  it("expired or over-budget quotes and a missing owner approval make zero signing calls", async () => {
    // Expired quote, both rails.
    for (const rail of ["arc-eip3009", "circle-gateway-batched"] as const) {
      const { h, accepted, purchaseId, quote } = await start(rail);
      h.clock = quote.expiresAt;
      const result = await h.buyer.purchase({ accepted, purchaseId, quote, now: h.clock });
      assert.equal(result.status === "rejected" && result.reason, "quote expired");
      assert.equal(h.signer.calls, 0);
      assert.equal(h.store.get(purchaseId), undefined);
    }
    // Over budget, both rails.
    for (const [rail, missionBudget] of [["arc-eip3009", 40_000n], ["circle-gateway-batched", 500n]] as const) {
      const { h, accepted, purchaseId, quote } = await start(rail, { policy: { missionBudget } });
      const result = await h.buyer.purchase({ accepted, purchaseId, quote, now: h.clock });
      assert.equal(result.status === "rejected" && result.reason, "mission budget exceeded");
      assert.equal(h.signer.calls, 0);
      assert.equal(h.store.get(purchaseId), undefined);
      assert.equal(h.circle.verifyCalls + h.circle.settleCalls + h.chain.settleCalls, 0);
    }
    // Owner approval required (0.05 USDC above a 0.01 USDC automatic tier).
    const { h, accepted, purchaseId, quote } = await start("arc-eip3009", { policy: { autoApproveMax: 10_000n, gapMax: 10_000n } });
    const held = await h.buyer.purchase({ accepted, purchaseId, quote, now: h.clock });
    assert.equal(held.status, "awaiting_approval");
    assert.equal((await h.buyer.purchase({ accepted, purchaseId, quote, now: h.clock })).status, "awaiting_approval");
    if (held.status !== "awaiting_approval") return;
    const wrongSigner = await DEMO_PAYER.signTypedData(approvalTypedData(held.request, held.requestHash));
    assert.notEqual((await h.buyer.purchase({ accepted, purchaseId, quote, now: h.clock, ownerSignature: wrongSigner })).status, "authorized");
    await h.restart();
    assert.equal((await h.buyer.purchase({ accepted, purchaseId, quote, now: h.clock })).status, "awaiting_approval", "still held after a restart");
    assert.equal(h.signer.calls, 0, "no approval, no signature");
    assert.equal(h.store.get(purchaseId)?.signature, null);
    assert.equal(h.chain.settleCalls, 0);
    // Control: the enrolled owner's approval leads to exactly one signature.
    const owner = await DEMO_OWNER.signTypedData(approvalTypedData(held.request, held.requestHash));
    assert.equal((await h.buyer.purchase({ accepted, purchaseId, quote, now: h.clock, ownerSignature: owner })).status, "authorized");
    assert.equal(h.signer.calls, 1);
  });
});

describe("acceptance: market run to results and audit through the app engine", { skip }, () => {
  let engine: RunEngine;
  before(() => {
    engine = new RunEngine({ analyst: new Analyst(python!, analysisDir), markets: loadFixtureMarkets(analysisDir) });
  });
  after(async () => engine.close());

  async function step(id: string, action: string, body: Record<string, unknown> = {}) {
    try {
      return { status: 200, view: engine.operatorView(await engine.step(id, action, body)) };
    } catch (error) {
      return { status: (error as { status?: number }).status ?? 500, error: (error as Error).message };
    }
  }

  it("Gateway run: results show the analysis, prices and sources; the audit links run, purchase, receipt, Circle transfer and batch", async () => {
    const run = await engine.createRun({ marketId: NYC, scenario: "standard", rail: "circle-gateway-batched" }, "operator");
    const view = engine.publicView(run);
    assert.equal(view.rail.id, "circle-gateway-batched");
    assert.equal(view.decision.action, "buy");
    assert.equal(view.decision.proposal?.maxUsdc, "0.001");
    assert.ok(view.citations.length > 0);
    assert.ok(view.rating.final);
    assert.equal(view.pricing.marketImplied.kind, "market-implied");
    assert.equal(view.pricing.modelEstimate.value, null);
    assert.equal(view.pricing.modelEstimate.state, "unavailable");
    assert.equal((await step(run.id, "reassess")).status, 409);

    for (const action of ["quote", "decide", "pay"]) assert.equal((await step(run.id, action)).status, 200, action);
    // Circle reports the transfer before the buyer verifies the receipt.
    assert.equal((await step(run.id, "circle")).status, 200);
    assert.equal((await step(run.id, "batch")).status, 200);
    assert.equal((await step(run.id, "circle")).status, 200);
    assert.equal((await step(run.id, "reassess")).status, 409, "a settled Circle transfer is not verified evidence");
    assert.equal((await step(run.id, "webhook")).status, 200);
    assert.equal((await step(run.id, "webhook-replay")).status, 200);
    assert.equal((await step(run.id, "verify")).status, 200);
    assert.equal((await step(run.id, "batch")).status, 200);
    assert.equal((await step(run.id, "circle")).status, 200);
    assert.equal((await step(run.id, "circle-stale")).status, 200);
    assert.equal((await step(run.id, "retry")).status, 200);
    const done = await step(run.id, "reassess");
    assert.equal(done.status, 200);

    const audit = engine.audit(run) as Record<string, any>;
    assert.equal(audit.runId, run.id);
    assert.equal(audit.purchaseId, run.purchaseId);
    assert.equal(audit.receipt.state, "verified");
    assert.match(audit.receipt.digest, /^0x[0-9a-f]{64}$/);
    assert.equal(audit.payment.circleTransfer.receiptNamesSameTransfer, true);
    assert.equal(audit.payment.circleTransfer.status, "completed", "the stale replay did not regress the transfer");
    assert.match(audit.payment.arcBatch.txHash, /^0x[0-9a-f]{64}$/);
    assert.equal(audit.payment.quicknode.batch.state, "confirmed");
    assert.equal(audit.payment.quicknode.perTransfer.status, "not_claimed");
    assert.equal(audit.portal.paymentRef, audit.payment.circleTransfer.id);
    assert.equal(audit.reassessment.state, run.reassessment!.status);
    assert.equal(audit.quote.freshness, "fresh");
    const operator = done.view!.operator as Record<string, any>;
    assert.equal(operator.gateway.settleCalls, 1);
    assert.equal(engine.auditLog()[0]?.runId, run.id);
  });

  it("Gateway run with a lost settle response: the retry delivers with one settlement", async () => {
    const run = await engine.createRun({ marketId: NYC, scenario: "lost_response", rail: "circle-gateway-batched" }, "operator");
    for (const action of ["quote", "decide"]) assert.equal((await step(run.id, action)).status, 200);
    const lost = await step(run.id, "pay");
    assert.equal(lost.status, 200);
    assert.notEqual(run.attempts[0]?.status, 200);
    const retry = await step(run.id, "retry");
    assert.equal(run.attempts[1]?.status, 200, JSON.stringify(run.attempts));
    assert.equal(run.attempts[1]?.authorizationReused, true);
    assert.equal((retry.view!.operator as Record<string, any>).gateway.settleCalls, 1);
    assert.equal((await step(run.id, "verify")).status, 200);
    assert.equal(run.delivery?.state, "verified");
  });

  it("Gateway run with altered bytes: the receipt is rejected and reassessment never runs", async () => {
    const run = await engine.createRun({ marketId: NYC, scenario: "tampered", rail: "circle-gateway-batched" }, "operator");
    for (const action of ["quote", "decide", "pay", "verify"]) assert.equal((await step(run.id, action)).status, 200, action);
    assert.equal(run.delivery?.state, "rejected");
    assert.equal((await step(run.id, "reassess")).status, 409);
    assert.equal((engine.audit(run) as Record<string, any>).receipt.state, "rejected");
  });

  it("refuses scenarios that do not apply to a rail", async () => {
    await assert.rejects(engine.createRun({ marketId: NYC, scenario: "approval", rail: "circle-gateway-batched" }, "operator"), /does not apply/);
    await assert.rejects(engine.createRun({ marketId: NYC, scenario: "lost_response", rail: "arc-eip3009" }, "operator"), /does not apply/);
  });
});

describe("acceptance: a live market run is read-only and never proposes a purchase", () => {
  it("builds the run from a live analysis, labels it LIVE, and keeps unavailable values explicit", async () => {
    const sample = JSON.parse(readFileSync(join(root, "samples", "live", "analyze-live-WXHIGH-NYC-2611210459.json"), "utf8")) as LiveAnalyzeOutput;
    const calls: string[] = [];
    const stub = {
      analyze: async () => {
        throw new Error("fixture analysis is not used for a live run");
      },
      analyzeLive: async (event: string, outcome: string) => {
        calls.push(`${event}|${outcome}`);
        return withResearch(sample);
      },
      reassess: async () => {
        throw new Error("no reassessment without a purchase");
      },
    } as unknown as Analyst;
    const engine = new RunEngine({ analyst: stub, markets: loadFixtureMarkets(analysisDir) });
    try {
      const run = await engine.createRun({ live: { event: "WXHIGH-NYC-2611210459", outcome: "66°F to 67°F" } }, "visitor");
      assert.deepEqual(calls, ["WXHIGH-NYC-2611210459|66°F to 67°F"]);
      const view = engine.publicView(run);
      assert.match(view.label, /^LIVE/);
      assert.equal(view.market.label, "LIVE");
      assert.equal(view.market.contractId, "GEMI-WXHIGH-NYC-2611210459-66TO67");
      assert.equal(view.pricing.marketImplied.observedAtUtc, "2026-11-19T21:29:38Z");
      assert.equal(view.pricing.modelEstimate.state, "unavailable");
      assert.equal(view.decision.action, "abstain");
      assert.ok(view.market.unavailable.some((u: string) => u.startsWith("settlement_source")));
      assert.ok(view.rule.citations.some((c: { id: string }) => c.id === "C-CONTRACT"));
      await assert.rejects(engine.step(run.id, "quote", {}), /nothing to quote/);
      await assert.rejects(engine.createRun({ live: { event: "bad ticker!", outcome: "x" } }, "visitor"), /invalid event ticker/);
      await assert.rejects(engine.createRun({ live: { event: "WXHIGH-NYC-2611210459", outcome: "x" }, scenario: "tampered" }, "visitor"), /standard scenario only/);
    } finally {
      await engine.close();
    }
  });
});
