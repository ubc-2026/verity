import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Hex } from "viem";
import { buildResearchRequest } from "../src/payments/buyer.ts";
import { catalogById } from "../src/payments/catalog.ts";
import { GATEWAY_AUTH_VALIDITY_SECONDS, gatewayAuthorizationDomain, type GatewayProvider } from "../src/payments/circleGateway.ts";
import { deliverGatewayPaidRequest, GatewayDeliveryStore, type GatewayDeliveryDeps } from "../src/payments/gatewayDelivery.ts";
import { GatewayLedger } from "../src/payments/gatewayLedger.ts";
import { verifyGatewayDelivery } from "../src/payments/gatewayReceipt.ts";
import type { PaidRequest } from "../src/payments/merchant.ts";
import { authorizeStoredPurchase } from "../src/payments/paymentService.ts";
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
    const transfer = await gateway.transferByNonce(t.paid.record.nonce);
    assert.equal(first.receipt.paymentRef, transfer?.id);
    assert.equal(first.receipt.authorizationNonce, t.paid.record.nonce);
    const replay = await deliverGatewayPaidRequest(t.input, t.deps);
    assert.equal(replay.status === 200 && replay.replayed, true);
    assert.equal(gateway.settleCalls, 1);
  });

  it("releases the claim when Gateway rejects, keeps it when the outcome is unknown", async () => {
    const poor = await setup(new MockGatewayProvider({ now: () => DEMO_NOW, balances: {} }));
    const rejected = await deliverGatewayPaidRequest(poor.input, poor.deps);
    assert.equal(rejected.status, 402);
    assert.match((rejected as { reason: string }).reason, /insufficient_balance/);
    assert.equal(poor.deliveries.get(poor.request.purchaseId), undefined);

    let settles = 0;
    const flaky: GatewayProvider = {
      mode: "fixture",
      verify: async () => ({ isValid: true }),
      settle: async () => { settles += 1; throw new Error("socket hang up"); },
      transferByNonce: async () => undefined,
      transferById: async () => { throw new Error("none"); },
    };
    const t = await setup(flaky);
    assert.equal((await deliverGatewayPaidRequest(t.input, t.deps)).status, 502);
    assert.equal((await deliverGatewayPaidRequest(t.input, t.deps)).status, 202);
    assert.equal(settles, 1);
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
    const buyer = (store: PaymentStore) =>
      new BuyerService({ store, catalog, owner: DEMO_PAYER.address, signer: DEMO_PAYER, tokenDomain: { name: "USDC", version: "2" }, missionId: "m-safeguard" });
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
  });
});
