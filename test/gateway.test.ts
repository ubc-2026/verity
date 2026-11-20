import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";
import type { Hex } from "viem";
import { buildResearchRequest } from "../src/payments/buyer.ts";
import { catalogById } from "../src/payments/catalog.ts";
import { GATEWAY_AUTH_VALIDITY_SECONDS, gatewayAuthorizationDomain, type GatewayProvider, type GatewayTransfer } from "../src/payments/circleGateway.ts";
import { deliverGatewayPaidRequest, GatewayDeliveryStore, type GatewayDeliveryDeps } from "../src/payments/gatewayDelivery.ts";
import { GatewayLedger } from "../src/payments/gatewayLedger.ts";
import { verifyGatewayDelivery } from "../src/payments/gatewayReceipt.ts";
import type { PaidRequest } from "../src/payments/merchant.ts";
import { authorizeStoredPurchase, type PaymentSigner } from "../src/payments/paymentService.ts";
import { assessPolicy, MISSION_BUDGET } from "../src/payments/policy.ts";
import { parseQuote } from "../src/payments/quote.ts";
import { hashContent } from "../src/payments/researchRequest.ts";
import { BuyerService } from "../src/payments/purchase.ts";
import { DEMO_POLICY, PaymentStore, PolicyError } from "../src/payments/store.ts";
import { MockGatewayProvider } from "../scripts/e2e/mockGateway.ts";
import { DEMO_MERCHANT_CONFIG, DEMO_MERCHANT_SIGNER, DEMO_NOW, DEMO_PAYER } from "./fixtures/scenario.ts";
import { RESEARCH_RESOURCES } from "../src/payments/catalog.ts";

const NANO = "cat-nws-cli-settlement-version-nano-v1";
const catalog = catalogById();
const item = catalog.get(NANO)!;
const body = RESEARCH_RESOURCES.find((r) => r.item.catalogItemId === NANO)!.body;
const contentHash = hashContent(body);
const parameters = { contractId: "fx-nyc-high-20261118", evidenceType: "settlement_source_version" };
const catalogParameters = { station: "Central Park, NY (CLINYC)", date: "2026-11-18" };

function nanoQuote(purchaseId = "purchase-nano-1") {
  return {
    ...parseQuote({
      quoteId: `quote-${purchaseId}`,
      purchaseId,
      merchantId: item.merchantId,
      catalogItemId: NANO,
      method: "POST",
      resourceUrl: item.resourceUrl,
      parameters,
      contentType: item.contentType,
      expectedContentHash: contentHash,
      chainId: item.chainId,
      token: item.token,
      payTo: item.payTo,
      amount: "1000",
      expiresAt: DEMO_NOW + 600,
      catalogParameters,
    }),
    buyerSessionId: "session-nano",
  };
}

async function setup(gateway: GatewayProvider = new MockGatewayProvider({ now: () => DEMO_NOW, balances: { [DEMO_PAYER.address]: 10_000n } })) {
  const store = new PaymentStore();
  const saved = nanoQuote();
  const { buyerSessionId: _s, ...wire } = saved;
  const request = buildResearchRequest({
    catalog,
    proposal: { catalogItemId: NANO, parameters, maxAmount: 1000n },
    quote: parseQuote(wire),
    purchaseId: saved.purchaseId,
    catalogParameters,
    payer: DEMO_PAYER.address,
    now: DEMO_NOW,
    windowSeconds: GATEWAY_AUTH_VALIDITY_SECONDS,
    allowBeyondQuoteExpiry: true,
  });
  store.reserveAndRecord({ missionId: "m", request, now: DEMO_NOW, materialUnresolvedGap: true, rail: "circle-gateway-batched" });
  const paid = await authorizeStoredPurchase({ store, purchaseId: request.purchaseId, signer: DEMO_PAYER, tokenDomain: { name: "USDC", version: "2" }, now: DEMO_NOW });
  const input: PaidRequest = {
    method: "POST",
    target: new URL(item.resourceUrl).pathname,
    body: new TextEncoder().encode(JSON.stringify(parameters)),
    bindingHeader: paid.bindingHeader,
    buyerSessionId: "session-nano",
    chainId: request.chainId,
    token: request.token,
    authorization: paid.authorization,
  };
  const deliveries = new GatewayDeliveryStore(":memory:");
  const deps: GatewayDeliveryDeps = {
    config: { ...DEMO_MERCHANT_CONFIG, authorizationDomain: gatewayAuthorizationDomain(), authorizationMayOutliveQuote: true, maxAuthorizationWindowSeconds: GATEWAY_AUTH_VALIDITY_SECONDS + 60 },
    loadQuote: (id) => (id === saved.quoteId ? saved : undefined),
    hasArtifact: (h) => h === contentHash,
    loadArtifact: (h) => (h === contentHash ? body : undefined),
    now: () => DEMO_NOW,
    gateway,
    deliveries,
    receiptSigner: DEMO_MERCHANT_SIGNER,
  };
  return { store, request, input, deps, deliveries, paid };
}

describe("nanopayment policy", () => {
  const assess = (over: Partial<Parameters<typeof assessPolicy>[0]>) =>
    assessPolicy({
      amount: 1000n, now: DEMO_NOW, expiresAt: DEMO_NOW + 600, merchantId: "verity-demo-merchant", catalogItemId: NANO,
      groupKey: "g", materialUnresolvedGap: true, paused: false, allowlistedMerchants: ["verity-demo-merchant"],
      allowlistedItems: [...catalog.keys()], reservedKeys: [], spentKeys: [], committedBaseUnits: 0n, budget: MISSION_BUDGET,
      rail: "circle-gateway-batched", ...over,
    });
  it("allows exactly the 0.001 USDC allowlisted Gateway purchase for a material gap", () => {
    assert.deepEqual(assess({}), { decision: "allow", tier: "nanopayment" });
  });
  it("refuses 0.001 USDC on the direct rail, more than 0.001 on Gateway, other items, and no gap", () => {
    assert.equal(assess({ rail: "arc-eip3009" }).decision, "reject");
    assert.equal(assess({ amount: 1001n }).decision, "reject");
    assert.equal(assess({ catalogItemId: "cat-nws-cli-settlement-version-v1" }).decision, "reject");
    assert.equal(assess({ materialUnresolvedGap: false }).decision, "reject");
    assert.equal(assess({ committedBaseUnits: MISSION_BUDGET }).decision, "reject");
  });
  it("the durable store enforces the same limits and records the rail", async () => {
    const t = await setup();
    assert.equal(t.store.get(t.request.purchaseId)?.rail, "circle-gateway-batched");
    const store = new PaymentStore();
    assert.throws(() => store.reserveAndRecord({ missionId: "m", request: t.request, now: DEMO_NOW, rail: "circle-gateway-batched" }), PolicyError);
    assert.throws(() => store.reserveAndRecord({ missionId: "m", request: t.request, now: DEMO_NOW, materialUnresolvedGap: true }), /below policy minimum/);
  });
});

describe("Gateway merchant path", () => {
  it("signs under GatewayWalletBatched, settles once, and the V2 receipt names Circle's transfer and the nonce", async () => {
    const gateway = new MockGatewayProvider({ now: () => DEMO_NOW, balances: { [DEMO_PAYER.address]: 10_000n } });
    const t = await setup(gateway);
    const first = await deliverGatewayPaidRequest(t.input, t.deps);
    assert.equal(first.status, 200, JSON.stringify(first));
    if (first.status !== 200) return;
    const transfer = await gateway.transferByNonce({ nonce: t.paid.record.nonce, from: t.request.payer, to: t.request.payTo });
    assert.equal(first.receipt.paymentRef, transfer?.id);
    assert.equal(first.receipt.authorizationNonce, t.paid.record.nonce);
    const replay = await deliverGatewayPaidRequest(t.input, t.deps);
    assert.equal(replay.status === 200 && replay.replayed, true);
    assert.equal(gateway.settleCalls, 1);
  });

  it("releases the claim when Gateway deterministically rejects the payment", async () => {
    const poor = await setup(new MockGatewayProvider({ now: () => DEMO_NOW, balances: {} }));
    const rejected = await deliverGatewayPaidRequest(poor.input, poor.deps);
    assert.equal(rejected.status, 402);
    assert.match((rejected as { reason: string }).reason, /insufficient_balance/);
    assert.equal(poor.deliveries.get(poor.request.purchaseId), undefined);

    const settleRejected: GatewayProvider = {
      mode: "fixture",
      verify: async () => ({ isValid: true }),
      settle: async () => ({ success: false, errorReason: "insufficient_balance", transaction: "" }),
      transferByNonce: async () => undefined,
      transferById: async () => { throw new Error("none"); },
    };
    const t = await setup(settleRejected);
    const again = await deliverGatewayPaidRequest(t.input, t.deps);
    assert.equal(again.status, 402);
    assert.match((again as { reason: string }).reason, /insufficient_balance/);
    assert.equal(t.deliveries.get(t.request.purchaseId), undefined);
  });

  it("reconciles a lost settlement by the original nonce and delivers on retry with one settle call", async () => {
    const inner = new MockGatewayProvider({ now: () => DEMO_NOW, balances: { [DEMO_PAYER.address]: 10_000n } });
    const lookups: { nonce: string; from: string; to: string }[] = [];
    const gateway: GatewayProvider = {
      mode: "fixture",
      verify: (payload, requirements) => inner.verify(payload, requirements),
      settle: async (payload, requirements) => {
        await inner.settle(payload, requirements);
        throw new Error("socket hang up");
      },
      transferByNonce: async (lookup) => {
        lookups.push(lookup);
        return inner.transferByNonce(lookup);
      },
      transferById: (id) => inner.transferById(id),
    };
    const t = await setup(gateway);
    const lost = await deliverGatewayPaidRequest(t.input, t.deps);
    assert.equal(lost.status, 502);
    assert.match((lost as { reason: string }).reason, /outcome unknown/);
    assert.equal(t.deliveries.get(t.request.purchaseId)?.status, "claimed");
    assert.equal(t.deliveries.get(t.request.purchaseId)?.paymentRef, null);
    assert.equal(inner.settleCalls, 1);

    const retry = await deliverGatewayPaidRequest(t.input, t.deps);
    assert.equal(retry.status, 200, JSON.stringify(retry));
    if (retry.status !== 200) return;
    assert.equal(retry.replayed, false);
    assert.deepEqual(retry.body, body);
    assert.equal(inner.settleCalls, 1);
    const transfer = await inner.transferByNonce({ nonce: t.paid.record.nonce, from: t.request.payer, to: t.request.payTo });
    assert.equal(retry.receipt.paymentRef, transfer?.id);
    assert.equal(retry.receipt.authorizationNonce, t.paid.record.nonce);
    assert.ok(lookups.some((q) => q.nonce === t.paid.record.nonce && q.from === t.request.payer && q.to === t.request.payTo));

    const replay = await deliverGatewayPaidRequest(t.input, t.deps);
    assert.equal(replay.status === 200 && replay.replayed, true);
    assert.equal(inner.settleCalls, 1);
  });

  it("reconciles unexpected_error and nonce_already_used without a second settle, and does not release the claim when no transfer exists yet", async () => {
    const acceptedThen = async (errorReason: string) => {
      const inner = new MockGatewayProvider({ now: () => DEMO_NOW, balances: { [DEMO_PAYER.address]: 10_000n } });
      const gateway: GatewayProvider = {
        mode: "fixture",
        verify: (payload, requirements) => inner.verify(payload, requirements),
        settle: async (payload, requirements) => {
          await inner.settle(payload, requirements);
          return { success: false, errorReason, transaction: "" };
        },
        transferByNonce: (lookup) => inner.transferByNonce(lookup),
        transferById: (id) => inner.transferById(id),
      };
      const t = await setup(gateway);
      const first = await deliverGatewayPaidRequest(t.input, t.deps);
      assert.equal(first.status, 200, JSON.stringify(first));
      if (first.status !== 200) return;
      assert.deepEqual(first.body, body);
      assert.equal(inner.settleCalls, 1);
      assert.equal(t.deliveries.get(t.request.purchaseId)?.status, "delivered");
      const replay = await deliverGatewayPaidRequest(t.input, t.deps);
      assert.equal(replay.status === 200 && replay.replayed, true);
      assert.equal(inner.settleCalls, 1);
    };
    await acceptedThen("unexpected_error");
    await acceptedThen("nonce_already_used");

    let settles = 0;
    const unknown: GatewayProvider = {
      mode: "fixture",
      verify: async () => ({ isValid: true }),
      settle: async () => {
        settles += 1;
        return { success: false, errorReason: "unexpected_error", transaction: "" };
      },
      transferByNonce: async () => undefined,
      transferById: async () => { throw new Error("none"); },
    };
    const t = await setup(unknown);
    const first = await deliverGatewayPaidRequest(t.input, t.deps);
    assert.equal(first.status, 202);
    assert.equal(t.deliveries.get(t.request.purchaseId)?.status, "claimed");
    const retry = await deliverGatewayPaidRequest(t.input, t.deps);
    assert.equal(retry.status, 202);
    assert.equal(settles, 1);
    assert.equal(t.deliveries.get(t.request.purchaseId)?.status, "claimed");
  });

  it("does not deliver a failed transfer or one with a different nonce, and does not settle again", async () => {
    const cases: { name: string; alter: (transfer: GatewayTransfer) => GatewayTransfer }[] = [
      { name: "failed", alter: (transfer) => ({ ...transfer, status: "failed" }) },
      { name: "other nonce", alter: (transfer) => ({ ...transfer, nonce: `0x${"ab".repeat(32)}` }) },
    ];
    for (const scenario of cases) {
      const inner = new MockGatewayProvider({ now: () => DEMO_NOW, balances: { [DEMO_PAYER.address]: 10_000n } });
      const gateway: GatewayProvider = {
        mode: "fixture",
        verify: (payload, requirements) => inner.verify(payload, requirements),
        settle: async (payload, requirements) => {
          await inner.settle(payload, requirements);
          throw new Error("socket hang up");
        },
        transferByNonce: async (lookup) => {
          const transfer = await inner.transferByNonce(lookup);
          return transfer ? scenario.alter(transfer) : undefined;
        },
        transferById: (id) => inner.transferById(id),
      };
      const t = await setup(gateway);
      assert.equal((await deliverGatewayPaidRequest(t.input, t.deps)).status, 502);
      const retry = await deliverGatewayPaidRequest(t.input, t.deps);
      assert.equal(retry.status, 502, scenario.name);
      assert.equal(t.deliveries.get(t.request.purchaseId)?.status, "claimed");
      assert.equal(inner.settleCalls, 1);
      assert.equal((await deliverGatewayPaidRequest(t.input, t.deps)).status, 502);
      assert.equal(inner.settleCalls, 1);
    }
  });

  it("refuses a token-domain signature and an authorization window shorter than Circle's 7 days", async () => {
    const gateway = new MockGatewayProvider({ now: () => DEMO_NOW, balances: { [DEMO_PAYER.address]: 10_000n } });
    const t = await setup(gateway);
    const tokenDomainSig = await DEMO_PAYER.signTypedData({
      domain: { name: "USDC", version: "2", chainId: t.request.chainId, verifyingContract: t.request.token },
      types: { TransferWithAuthorization: [
        { name: "from", type: "address" }, { name: "to", type: "address" }, { name: "value", type: "uint256" },
        { name: "validAfter", type: "uint256" }, { name: "validBefore", type: "uint256" }, { name: "nonce", type: "bytes32" }] },
      primaryType: "TransferWithAuthorization",
      message: { from: DEMO_PAYER.address, to: t.request.payTo, value: 1000n, validAfter: BigInt(t.request.validAfter), validBefore: BigInt(t.request.validBefore), nonce: t.paid.record.nonce },
    });
    const wrongDomain = await deliverGatewayPaidRequest({ ...t.input, authorization: { ...t.input.authorization, signature: tokenDomainSig } }, t.deps);
    assert.equal(wrongDomain.status, 402);
    assert.equal(gateway.settleCalls, 0);
    const shortWindow = await gateway.verify(
      { x402Version: 2, resource: { url: "x", description: "x", mimeType: "x" }, accepted: {} as never,
        payload: { authorization: { ...t.input.authorization, validBefore: String(DEMO_NOW + 600) }, signature: t.input.authorization.signature } },
      { scheme: "exact", network: "eip155:5042002", asset: t.request.token, amount: "1000", payTo: t.request.payTo, maxTimeoutSeconds: 1, extra: { name: "GatewayWalletBatched", version: "1", verifyingContract: gatewayAuthorizationDomain().verifyingContract } },
    );
    assert.equal(shortWindow.invalidReason, "authorization_validity_too_short");
  });

  it("returns 503 for a Gateway item when the merchant has no Gateway rail", async () => {
    const { MerchantService } = await import("../src/payments/service.ts");
    const t = await setup();
    const merchant = new MerchantService({ config: DEMO_MERCHANT_CONFIG, signer: DEMO_MERCHANT_SIGNER, settlement: { settle: async () => ({ txHash: `0x${"00".repeat(32)}` as Hex }) }, now: () => DEMO_NOW, sessions: {} });
    assert.equal((await merchant.deliver(t.input)).status, 503);
    merchant.close();
  });
});

describe("Gateway buyer verification and ledger", () => {
  it("records acceptance, then batch settlement only for the transfer on the receipt; never a QuickNode match", async () => {
    const gateway = new MockGatewayProvider({ now: () => DEMO_NOW, balances: { [DEMO_PAYER.address]: 10_000n } });
    const t = await setup(gateway);
    const res = await deliverGatewayPaidRequest(t.input, t.deps);
    assert.equal(res.status, 200);
    if (res.status !== 200) return;
    const verdict = await verifyGatewayDelivery({
      receiptHeader: res.headers["X-Verity-Receipt"], body: res.body,
      trusted: { merchantId: DEMO_MERCHANT_CONFIG.merchantId, receiptSigner: DEMO_MERCHANT_SIGNER.address },
      request: t.request, authorizationNonce: t.paid.record.nonce,
    });
    assert.equal(verdict.ok, true);
    if (!verdict.ok) return;
    const ledger = new GatewayLedger(t.store);
    assert.equal(ledger.recordVerifiedDelivery({ receipt: verdict.receipt, digest: verdict.digest, now: DEMO_NOW }).kind, "accepted");
    assert.equal(ledger.recordVerifiedDelivery({ receipt: verdict.receipt, digest: verdict.digest, now: DEMO_NOW }).kind, "already_recorded");
    assert.equal(ledger.status(t.request.purchaseId)?.settlement, "pending_batch");
    gateway.advanceBatch();
    gateway.advanceBatch();
    const transfer = await gateway.transferById(verdict.receipt.paymentRef);
    const other = { ...transfer, id: "00000000-0000-4000-8000-000000000000" };
    assert.deepEqual(ledger.recordBatch(t.request.purchaseId, other, DEMO_NOW), { error: `transfer ${other.id} is not the one on the receipt (${transfer.id})` });
    assert.equal(ledger.status(t.request.purchaseId)?.settlement, "pending_batch");
    const settled = ledger.recordBatch(t.request.purchaseId, transfer, DEMO_NOW);
    assert.ok(!("error" in settled));
    if ("error" in settled) return;
    assert.equal(settled.settlement, "batch_settled");
    assert.equal(settled.quicknode.status, "not_claimed");
    assert.equal(t.store.reservation(t.request.purchaseId)?.status, "spent");
  });

  it("keeps the purchase settled when a delayed pending response follows a completed one", async () => {
    const gateway = new MockGatewayProvider({ now: () => DEMO_NOW, balances: { [DEMO_PAYER.address]: 10_000n } });
    const t = await setup(gateway);
    const res = await deliverGatewayPaidRequest(t.input, t.deps);
    assert.equal(res.status, 200);
    if (res.status !== 200) return;
    const verdict = await verifyGatewayDelivery({
      receiptHeader: res.headers["X-Verity-Receipt"], body: res.body,
      trusted: { merchantId: DEMO_MERCHANT_CONFIG.merchantId, receiptSigner: DEMO_MERCHANT_SIGNER.address },
      request: t.request, authorizationNonce: t.paid.record.nonce,
    });
    assert.equal(verdict.ok, true);
    if (!verdict.ok) return;
    const ledger = new GatewayLedger(t.store);
    assert.equal(ledger.recordVerifiedDelivery({ receipt: verdict.receipt, digest: verdict.digest, now: DEMO_NOW }).kind, "accepted");

    const received = await gateway.transferById(res.receipt.paymentRef);
    assert.equal(received.status, "received");
    const pending = ledger.recordBatch(t.request.purchaseId, received, DEMO_NOW);
    assert.ok(!("error" in pending));
    if ("error" in pending) return;
    assert.equal(pending.settlement, "pending_batch");
    assert.equal(t.store.reservation(t.request.purchaseId)?.status, "held");

    gateway.advanceBatch();
    gateway.advanceBatch();
    const completed = await gateway.transferById(res.receipt.paymentRef);
    assert.equal(completed.status, "completed");
    assert.ok(completed.txHash);
    const settled = ledger.recordBatch(t.request.purchaseId, completed, DEMO_NOW + 1);
    assert.ok(!("error" in settled));
    if ("error" in settled) return;
    assert.equal(settled.settlement, "batch_settled");
    assert.equal(settled.batch.status, "completed");
    assert.equal(settled.batch.txHash, completed.txHash);
    assert.equal(t.store.reservation(t.request.purchaseId)?.status, "spent");

    const stale = ledger.recordBatch(t.request.purchaseId, received, DEMO_NOW + 2);
    assert.ok(!("error" in stale));
    if ("error" in stale) return;
    assert.equal(stale.settlement, "batch_settled");
    assert.equal(stale.batch.status, "completed");
    assert.equal(stale.batch.txHash, completed.txHash);
    assert.equal(t.store.reservation(t.request.purchaseId)?.status, "spent");

    const failed = ledger.recordBatch(t.request.purchaseId, { ...completed, status: "failed" }, DEMO_NOW + 3);
    assert.ok(!("error" in failed));
    if ("error" in failed) return;
    assert.equal(failed.settlement, "batch_settled");
    assert.equal(failed.batch.status, "completed");
    assert.equal(t.store.reservation(t.request.purchaseId)?.status, "spent");
  });

  it("accepts Circle's transfer before the receipt only if it matches the authorization, and then requires the receipt to name it", async () => {
    const gateway = new MockGatewayProvider({ now: () => DEMO_NOW, balances: { [DEMO_PAYER.address]: 10_000n } });
    const t = await setup(gateway);
    const res = await deliverGatewayPaidRequest(t.input, t.deps);
    assert.equal(res.status, 200);
    if (res.status !== 200) return;
    const verdict = await verifyGatewayDelivery({
      receiptHeader: res.headers["X-Verity-Receipt"], body: res.body,
      trusted: { merchantId: DEMO_MERCHANT_CONFIG.merchantId, receiptSigner: DEMO_MERCHANT_SIGNER.address },
      request: t.request, authorizationNonce: t.paid.record.nonce,
    });
    assert.equal(verdict.ok, true);
    if (!verdict.ok) return;
    const ledger = new GatewayLedger(t.store);
    const id = t.request.purchaseId;
    const real = await gateway.transferById(res.receipt.paymentRef);
    for (const [field, wrong] of [
      ["nonce", { ...real, nonce: "0x" + "ab".repeat(32) }],
      ["payer", { ...real, fromAddress: "0x1111111111111111111111111111111111111111" }],
      ["payee", { ...real, toAddress: "0x3333333333333333333333333333333333333333" }],
      ["amount", { ...real, amount: "1001" }],
      ["amount", { ...real, amount: "0.001" }],
    ] as const) {
      assert.deepEqual(ledger.recordBatch(id, wrong, DEMO_NOW), { error: `transfer ${real.id} does not match the stored authorization (${field})` });
    }
    assert.equal(ledger.status(id), undefined, "a refused transfer records nothing");

    // Circle reports a transfer for this authorization under another ID; the merchant's receipt names the real one.
    const other = { ...real, id: "00000000-0000-4000-8000-000000000001" };
    const observed = ledger.recordBatch(id, other, DEMO_NOW);
    assert.ok(!("error" in observed));
    if ("error" in observed) return;
    assert.equal(observed.acceptance, "awaiting_verified_delivery");
    assert.equal(observed.paymentRef, other.id);
    assert.deepEqual(ledger.recordBatch(id, real, DEMO_NOW), { error: `transfer ${real.id} differs from the one already observed (${other.id})` });
    const refused = ledger.recordVerifiedDelivery({ receipt: verdict.receipt, digest: verdict.digest, now: DEMO_NOW });
    assert.equal(refused.kind, "mismatch");
    assert.match((refused as { detail: string }).detail, /but Circle reported/);
    assert.equal(ledger.receipt(id), undefined);
  });

  it("a failed Circle transfer releases the hold, and a later status cannot revive it", async () => {
    const gateway = new MockGatewayProvider({ now: () => DEMO_NOW, balances: { [DEMO_PAYER.address]: 10_000n } });
    const t = await setup(gateway);
    const res = await deliverGatewayPaidRequest(t.input, t.deps);
    assert.equal(res.status, 200);
    if (res.status !== 200) return;
    const ledger = new GatewayLedger(t.store);
    const id = t.request.purchaseId;
    const real = await gateway.transferById(res.receipt.paymentRef);
    assert.equal(t.store.reservation(id)?.status, "held");
    const failed = ledger.recordBatch(id, { ...real, status: "failed" }, DEMO_NOW + 1);
    assert.ok(!("error" in failed));
    assert.equal(t.store.reservation(id)?.status, "released", "no USDC moved, so the budget is free again");
    ledger.recordBatch(id, { ...real, status: "completed" }, DEMO_NOW + 2);
    assert.equal(ledger.status(id)?.batch.status, "failed");
    assert.equal(t.store.reservation(id)?.status, "released");
  });

  it("refuses a Circle transfer that arrives before the receipt when it has no nonce", async () => {
    const gateway = new MockGatewayProvider({ now: () => DEMO_NOW, balances: { [DEMO_PAYER.address]: 10_000n } });
    const t = await setup(gateway);
    const res = await deliverGatewayPaidRequest(t.input, t.deps);
    assert.equal(res.status, 200);
    if (res.status !== 200) return;
    const ledger = new GatewayLedger(t.store);
    const real = await gateway.transferById(res.receipt.paymentRef);
    assert.equal(ledger.receipt(t.request.purchaseId), undefined, "no receipt row yet");
    assert.deepEqual(ledger.recordBatch(t.request.purchaseId, { ...real, nonce: null }, DEMO_NOW), {
      error: `transfer ${real.id} does not match the stored authorization (nonce)`,
    });
    assert.equal(ledger.status(t.request.purchaseId), undefined, "a nonce-less transfer records nothing");
    const observed = ledger.recordBatch(t.request.purchaseId, real, DEMO_NOW);
    assert.ok(!("error" in observed));
  });

  it("rejects a V2 receipt whose nonce is not the buyer's, or whose bytes were altered", async () => {
    const t = await setup();
    const res = await deliverGatewayPaidRequest(t.input, t.deps);
    if (res.status !== 200) throw new Error(String(res.status));
    const base = {
      receiptHeader: res.headers["X-Verity-Receipt"],
      trusted: { merchantId: DEMO_MERCHANT_CONFIG.merchantId, receiptSigner: DEMO_MERCHANT_SIGNER.address },
      request: t.request,
    };
    const altered = new Uint8Array(res.body);
    altered[0] = altered[0]! ^ 1;
    assert.equal((await verifyGatewayDelivery({ ...base, body: altered, authorizationNonce: t.paid.record.nonce })).ok, false);
    const otherNonce = await verifyGatewayDelivery({ ...base, body: res.body, authorizationNonce: `0x${"ab".repeat(32)}` });
    assert.equal(!otherNonce.ok && otherNonce.code, "nonce_mismatch");
  });
});

describe("expired or declined quotes never submit payment", () => {
  it("merchant: an expired quote is refused before Gateway verify or settle, though the 7-day authorization is still valid", async () => {
    const gateway = new MockGatewayProvider({ now: () => DEMO_NOW, balances: { [DEMO_PAYER.address]: 10_000n } });
    const t = await setup(gateway);
    const expiresAt = nanoQuote().expiresAt;
    assert.ok(Number(t.input.authorization.validBefore) > expiresAt, "the Gateway authorization outlives the quote");
    const late = await deliverGatewayPaidRequest(t.input, { ...t.deps, now: () => expiresAt });
    assert.equal(late.status, 410, JSON.stringify(late));
    assert.equal(gateway.verifyCalls, 0);
    assert.equal(gateway.settleCalls, 0);
    assert.equal(t.deliveries.get(t.request.purchaseId), undefined);
  });

  it("buyer: an expired quote or a policy decline signs nothing and stores no authorization", async () => {
    const signTypedData = mock.fn<PaymentSigner["signTypedData"]>(async () => {
      throw new Error("A rejected purchase must never reach the signer");
    });
    const signer = { address: DEMO_PAYER.address, signTypedData };
    const buyer = (store: PaymentStore) =>
      new BuyerService({ store, catalog, owner: DEMO_PAYER.address, signer, tokenDomain: { name: "USDC", version: "2" }, missionId: "m-safeguard" });
    const accepted = {
      selection: { catalogItemId: NANO, parameters, maxAmount: 1000n },
      groupKey: "fx-nyc-high-20261118:GAP-NYC-SETTLE",
      catalogParameters,
      materialUnresolvedGap: true as const,
    };
    const { buyerSessionId: _s, ...wire } = nanoQuote("purchase-expired");
    const expiredStore = new PaymentStore();
    const expired = await buyer(expiredStore).purchase({ accepted, purchaseId: "purchase-expired", quote: parseQuote(wire), now: wire.expiresAt });
    assert.equal(expired.status, "rejected");
    assert.match(expired.status === "rejected" ? expired.reason : "", /quote expired/);
    assert.equal(expiredStore.get("purchase-expired"), undefined);
    assert.equal(signTypedData.mock.callCount(), 0);

    const { buyerSessionId: _s2, ...wire2 } = nanoQuote("purchase-over-budget");
    const declinedStore = new PaymentStore(":memory:", { ...DEMO_POLICY, missionBudget: 999n });
    const declined = await buyer(declinedStore).purchase({
      accepted,
      purchaseId: "purchase-over-budget",
      quote: parseQuote(wire2),
      now: DEMO_NOW,
    });
    assert.equal(declined.status, "rejected");
    assert.match(declined.status === "rejected" ? declined.reason : "", /mission budget exceeded/);
    assert.equal(declinedStore.get("purchase-over-budget"), undefined);
    assert.equal(signTypedData.mock.callCount(), 0);
  });
});
