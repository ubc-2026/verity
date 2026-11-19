import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { pad, toHex, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { ARC_TESTNET } from "../src/payments/arc.ts";
import { SettlementError } from "../src/payments/arcFacilitator.ts";
import { encodeBindingHeader } from "../src/payments/binding.ts";
import { buildResearchRequest } from "../src/payments/buyer.ts";
import {
  acceptDelivery,
  DELIVERY_RECEIPT_VERSION,
  encodeReceiptHeader,
  parseReceiptHeader,
  RECEIPT_HEADER,
  signDeliveryReceipt,
  verifyDelivery,
  type TrustedMerchant,
} from "../src/payments/deliveryReceipt.ts";
import type { PaidRequest } from "../src/payments/merchant.ts";
import { deliverPaidRequest, MerchantDeliveryStore, type DeliverySettlementAdapter, type MerchantDeliveryDeps } from "../src/payments/merchantDelivery.ts";
import { authorizeStoredPurchase } from "../src/payments/paymentService.ts";
import { parseQuote } from "../src/payments/quote.ts";
import { commitResearchRequest, computeRequestHash, hashContent, type ResearchRequestV1 } from "../src/payments/researchRequest.ts";
import { PaymentStore } from "../src/payments/store.ts";
import { AUTHORIZATION_USED_TOPIC, ReconciliationLedger, TRANSFER_TOPIC } from "../src/reconciliation/ledger.ts";
import { DEMO_RESPONSE_TEXT } from "./fixtures/demoVector.ts";
import {
  DEMO_CATALOG,
  DEMO_CATALOG_ITEM,
  DEMO_CONTENT_HASH,
  DEMO_MERCHANT_CONFIG,
  DEMO_NOW,
  DEMO_OTHER_SIGNER,
  DEMO_PARAMETERS,
  DEMO_PAYER,
  demoQuote,
  signTransferWithAuthorization,
} from "./fixtures/scenario.ts";

/** DEMO FIXTURE: public Anvil/Hardhat test key #2 as the merchant receipt key. Never fund it. */
const MERCHANT_RECEIPT_KEY = privateKeyToAccount("0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a");
const TRUSTED: TrustedMerchant = { merchantId: DEMO_MERCHANT_CONFIG.merchantId, receiptSigner: MERCHANT_RECEIPT_KEY.address };
const TX: Hex = `0x${"e3".repeat(32)}`;
const ARTIFACT = new TextEncoder().encode(DEMO_RESPONSE_TEXT);

/** Buyer: reserve, persist, sign. Returns the stored request and the paid HTTP request it sends. */
async function buyer() {
  const store = new PaymentStore();
  const { buyerSessionId: _s, ...wire } = demoQuote();
  const request = buildResearchRequest({
    catalog: DEMO_CATALOG,
    proposal: { catalogItemId: DEMO_CATALOG_ITEM.catalogItemId, parameters: DEMO_PARAMETERS, maxAmount: 100_000n },
    quote: parseQuote(wire),
    purchaseId: wire.purchaseId,
    payer: DEMO_PAYER.address,
    now: DEMO_NOW,
  });
  store.reserveAndRecord({ missionId: "m", request, now: DEMO_NOW });
  const paid = await authorizeStoredPurchase({ store, purchaseId: request.purchaseId, signer: DEMO_PAYER, tokenDomain: ARC_TESTNET.usdcDomain, now: DEMO_NOW });
  const input: PaidRequest = {
    method: "POST",
    target: "/evidence/resolution-source",
    body: new TextEncoder().encode(JSON.stringify(DEMO_PARAMETERS)),
    bindingHeader: paid.bindingHeader,
    buyerSessionId: "session-demo-001",
    chainId: request.chainId,
    token: request.token,
    authorization: paid.authorization,
  };
  return { store, request, input, ledger: new ReconciliationLedger(store), nonce: paid.record.nonce };
}

/** Merchant with a fake settlement that counts calls. */
function merchant(overrides: Partial<MerchantDeliveryDeps> & { settle?: DeliverySettlementAdapter["settle"]; resume?: DeliverySettlementAdapter["resume"] } = {}) {
  const calls = { settle: 0, resume: 0 };
  let clock = DEMO_NOW;
  const quote = demoQuote();
  const deliveries = new MerchantDeliveryStore(":memory:");
  const settlement: DeliverySettlementAdapter = {
    settle: async (verified, auth) => {
      calls.settle++;
      return overrides.settle ? overrides.settle(verified, auth) : { txHash: TX };
    },
  };
  if (overrides.resume) {
    settlement.resume = async (verified, auth, txHash) => {
      calls.resume++;
      return overrides.resume!(verified, auth, txHash);
    };
  }
  const deps: MerchantDeliveryDeps = {
    config: DEMO_MERCHANT_CONFIG,
    loadQuote: (id) => (id === quote.quoteId ? quote : undefined),
    hasArtifact: (hash) => hash === DEMO_CONTENT_HASH,
    loadArtifact: (hash) => (hash === DEMO_CONTENT_HASH ? ARTIFACT : undefined),
    receiptSigner: MERCHANT_RECEIPT_KEY,
    deliveries,
    now: () => clock,
    ...overrides,
    settlement,
  };
  return { deps, calls, deliveries, advance: (seconds: number) => (clock += seconds) };
}

function ok<T extends { status: number }>(response: T): Extract<T, { status: 200 }> {
  assert.equal(response.status, 200, JSON.stringify(response));
  return response as Extract<T, { status: 200 }>;
}

/** A QuickNode-shaped settlement for the buyer's purchase. */
function settlementMatch(request: ResearchRequestV1, nonce: Hex, txHash: Hex = TX) {
  const topic = (a: string) => pad(a.toLowerCase() as Hex, { size: 32 });
  return {
    blockNumber: toHex(72781628),
    blockHash: `0x${"74".repeat(32)}` as Hex,
    blockTimestamp: toHex(DEMO_NOW + 5),
    transactionHash: txHash,
    status: "0x1" as Hex,
    logs: [
      { address: ARC_TESTNET.usdc, topics: [AUTHORIZATION_USED_TOPIC, topic(request.payer), nonce], data: "0x" as Hex, logIndex: "0x10" as Hex },
      { address: ARC_TESTNET.usdc, topics: [TRANSFER_TOPIC, topic(request.payer), topic(request.payTo)], data: toHex(BigInt(request.amount), { size: 32 }), logIndex: "0x12" as Hex },
    ],
  };
}

function ingestSettlement(ledger: ReconciliationLedger, request: ResearchRequestV1, nonce: Hex, txHash: Hex = TX) {
  return ledger.ingest({
    eventId: `event-${txHash}`,
    streamId: "s",
    batchStart: 72781628,
    batchEnd: 72781628,
    payload: "{}",
    matches: [settlementMatch(request, nonce, txHash)],
    finalizedBlock: 72781700n,
    now: DEMO_NOW + 60,
  });
}

describe("DeliveryReceiptV1 merchant signing", () => {
  it("signs a receipt binding merchant, purchase, quote, request hash, content hash, and tx after settlement", async () => {
    const b = await buyer();
    const m = merchant();
    const response = ok(await deliverPaidRequest(b.input, m.deps));
    assert.equal(m.calls.settle, 1);
    assert.equal(response.replayed, false);
    assert.deepEqual(response.body, ARTIFACT);
    const receipt = parseReceiptHeader(response.headers[RECEIPT_HEADER]);
    assert.deepEqual(
      { ...receipt, signature: undefined },
      {
        version: DELIVERY_RECEIPT_VERSION,
        merchantId: DEMO_MERCHANT_CONFIG.merchantId,
        merchant: MERCHANT_RECEIPT_KEY.address.toLowerCase(),
        purchaseId: b.request.purchaseId,
        quoteId: b.request.quoteId,
        requestHash: computeRequestHash(b.request),
        contentHash: DEMO_CONTENT_HASH,
        chainId: ARC_TESTNET.chainId,
        txHash: TX,
        issuedAt: DEMO_NOW,
        signature: undefined,
      },
    );
    assert.equal(m.deliveries.get(b.request.purchaseId)?.status, "delivered");
  });

  it("does not sign or settle when verification fails", async () => {
    const b = await buyer();
    const m = merchant();
    const response = await deliverPaidRequest({ ...b.input, body: new TextEncoder().encode('{"contractId":"demo-contract-002","evidenceType":"resolution_source"}') }, m.deps);
    assert.equal(response.status, 402);
    assert.equal(m.calls.settle, 0);
    assert.equal(m.deliveries.get(b.request.purchaseId), undefined);
  });

  it("refuses to sign for bytes that are not the quoted artifact, then delivers on retry", async () => {
    const b = await buyer();
    let artifact: Uint8Array = new TextEncoder().encode(`${DEMO_RESPONSE_TEXT} `);
    const m = merchant({ loadArtifact: () => artifact });
    const first = await deliverPaidRequest(b.input, m.deps);
    assert.equal(first.status, 503);
    assert.equal(m.deliveries.get(b.request.purchaseId)?.status, "settled");
    artifact = ARTIFACT;
    const second = ok(await deliverPaidRequest(b.input, m.deps));
    assert.equal(second.receipt.txHash, TX);
    assert.equal(m.calls.settle, 1);
  });
});

describe("buyer verification before accepting delivery", () => {
  it("accepts a valid delivery and records it; the ledger reconciles once the settlement is observed", async () => {
    const b = await buyer();
    const response = ok(await deliverPaidRequest(b.input, merchant().deps));
    const accepted = await acceptDelivery({
      response: { body: response.body, receiptHeader: response.headers[RECEIPT_HEADER] },
      trusted: TRUSTED,
      request: b.request,
      store: b.ledger,
      now: DEMO_NOW + 10,
    });
    assert.equal(accepted.accepted, true);
    assert.deepEqual(accepted.accepted && accepted.outcome, { kind: "delivered_payment_unconfirmed", purchaseId: b.request.purchaseId });

    ingestSettlement(b.ledger, b.request, b.nonce);
    const settlement = b.ledger.settlement(b.request.purchaseId)!;
    assert.equal(settlement.deliveryStatus, "verified");
    assert.equal(settlement.ledgerOutcome, "reconciled");
  });

  it("reconciles immediately when the settlement was observed first", async () => {
    const b = await buyer();
    ingestSettlement(b.ledger, b.request, b.nonce);
    assert.equal(b.ledger.settlement(b.request.purchaseId)!.ledgerOutcome, "settlement_confirmed_delivery_pending");
    const response = ok(await deliverPaidRequest(b.input, merchant().deps));
    const accepted = await acceptDelivery({
      response: { body: response.body, receiptHeader: response.headers[RECEIPT_HEADER] },
      trusted: TRUSTED,
      request: b.request,
      expectedTxHash: TX,
      store: b.ledger,
      now: DEMO_NOW + 10,
    });
    assert.deepEqual(accepted.accepted && accepted.outcome, { kind: "reconciled", purchaseId: b.request.purchaseId });
  });

  it("rejects altered content: one changed byte fails the digest and nothing is recorded", async () => {
    const b = await buyer();
    const response = ok(await deliverPaidRequest(b.input, merchant().deps));
    const altered = Uint8Array.from(response.body);
    altered[altered.length - 3]! ^= 0x01;
    const result = await acceptDelivery({ response: { body: altered, receiptHeader: response.headers[RECEIPT_HEADER] }, trusted: TRUSTED, request: b.request, store: b.ledger, now: DEMO_NOW });
    assert.equal(result.accepted, false);
    assert.equal(!result.accepted && result.code, "content_mismatch");
    assert.equal(b.ledger.counts().deliveries, 0);
  });

  it("rejects a receipt from the wrong signer", async () => {
    const b = await buyer();
    const response = ok(await deliverPaidRequest(b.input, merchant({ receiptSigner: DEMO_OTHER_SIGNER }).deps));
    const result = await verifyDelivery({ receiptHeader: response.headers[RECEIPT_HEADER], body: response.body, trusted: TRUSTED, request: b.request });
    assert.equal(!result.ok && result.code, "wrong_signer");
  });

  it("rejects a receipt whose signed fields were edited", async () => {
    const b = await buyer();
    const response = ok(await deliverPaidRequest(b.input, merchant().deps));
    const edited = { ...response.receipt, txHash: `0x${"aa".repeat(32)}` as Hex };
    const result = await verifyDelivery({ receiptHeader: encodeReceiptHeader(edited), body: response.body, trusted: TRUSTED, request: b.request });
    assert.equal(!result.ok && result.code, "wrong_signer");
  });

  it("rejects a valid receipt for a different request", async () => {
    const b = await buyer();
    const response = ok(await deliverPaidRequest(b.input, merchant().deps));
    const other = { ...b.request, amount: "60000" } as ResearchRequestV1;
    const result = await verifyDelivery({ receiptHeader: response.headers[RECEIPT_HEADER], body: response.body, trusted: TRUSTED, request: other });
    assert.equal(!result.ok && result.code, "binding_mismatch");
  });

  it("rejects a receipt whose tx differs from the known settlement", async () => {
    const b = await buyer();
    const response = ok(await deliverPaidRequest(b.input, merchant().deps));
    const result = await verifyDelivery({ receiptHeader: response.headers[RECEIPT_HEADER], body: response.body, trusted: TRUSTED, request: b.request, expectedTxHash: `0x${"aa".repeat(32)}` });
    assert.equal(!result.ok && result.code, "tx_mismatch");
  });

  const malformed: Array<[string, string | undefined]> = [
    ["missing header", undefined],
    ["not base64url", "!!!"],
    ["duplicate JSON key", Buffer.from('{"version":"x","version":"y"}').toString("base64url")],
    ["unknown field", Buffer.from('{"extra":1}').toString("base64url")],
  ];
  for (const [label, header] of malformed) {
    it(`rejects a malformed receipt: ${label}`, async () => {
      const b = await buyer();
      const result = await verifyDelivery({ receiptHeader: header, body: ARTIFACT, trusted: TRUSTED, request: b.request });
      assert.equal(!result.ok && result.code, "malformed_receipt");
    });
  }
});

describe("safe retry", () => {
  it("replays the stored receipt byte-for-byte without settling again, even after the window expires", async () => {
    const b = await buyer();
    const m = merchant();
    const first = ok(await deliverPaidRequest(b.input, m.deps));
    m.advance(3600);
    const second = ok(await deliverPaidRequest(b.input, m.deps));
    assert.equal(second.replayed, true);
    assert.equal(second.headers[RECEIPT_HEADER], first.headers[RECEIPT_HEADER]);
    assert.equal(m.calls.settle, 1);
  });

  it("still verifies a retry: a replay with a tampered body is rejected", async () => {
    const b = await buyer();
    const m = merchant();
    ok(await deliverPaidRequest(b.input, m.deps));
    const tampered = await deliverPaidRequest({ ...b.input, body: new TextEncoder().encode('{"contractId":"demo-contract-002","evidenceType":"resolution_source"}') }, m.deps);
    assert.equal(tampered.status, 402);
    assert.equal(m.calls.settle, 1);
  });

  it("refuses a second authorization for an already-claimed purchase", async () => {
    const b = await buyer();
    const m = merchant();
    ok(await deliverPaidRequest(b.input, m.deps));
    const salt: Hex = `0x${"77".repeat(32)}`;
    const { nonce } = commitResearchRequest(b.request, salt);
    const second: PaidRequest = {
      ...b.input,
      bindingHeader: encodeBindingHeader({ purchaseId: b.request.purchaseId, quoteId: b.request.quoteId, salt }),
      authorization: { ...b.input.authorization, nonce, signature: await signTransferWithAuthorization(b.request, nonce) },
    };
    const result = await deliverPaidRequest(second, m.deps);
    assert.equal(result.status, 409);
    assert.equal(m.calls.settle, 1);
  });

  it("concurrent identical requests settle once", async () => {
    const b = await buyer();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const m = merchant({ settle: async () => (await gate, { txHash: TX }) });
    const first = deliverPaidRequest(b.input, m.deps);
    await new Promise((r) => setImmediate(r));
    const second = await deliverPaidRequest(b.input, m.deps);
    assert.equal(second.status, 202);
    release();
    ok(await first);
    ok(await deliverPaidRequest(b.input, m.deps));
    assert.equal(m.calls.settle, 1);
  });

  it("same-tick copies both pass the pre-check; the atomic claim lets only one settle", async () => {
    const b = await buyer();
    const m = merchant();
    // Both calls read "no record" before either awaits verification, so only the INSERT OR IGNORE claim separates them.
    const [a, c] = await Promise.all([deliverPaidRequest(b.input, m.deps), deliverPaidRequest(b.input, m.deps)]);
    assert.deepEqual([a.status, c.status].sort(), [200, 202]);
    assert.equal(m.calls.settle, 1);
  });

  it("after a settlement timeout, a retry waits on the recorded tx hash instead of resubmitting", async () => {
    const b = await buyer();
    const m = merchant({
      settle: async () => Promise.reject(new SettlementError("submitted but outcome unknown: timeout", TX, true)),
      resume: async (_v, _a, txHash) => ({ txHash }),
    });
    const first = await deliverPaidRequest(b.input, m.deps);
    assert.deepEqual([first.status, "txHash" in first && first.txHash], [202, TX]);
    assert.equal(m.deliveries.get(b.request.purchaseId)?.status, "submitted");
    const second = ok(await deliverPaidRequest(b.input, m.deps));
    assert.equal(second.receipt.txHash, TX);
    assert.deepEqual(m.calls, { settle: 1, resume: 1 });
  });

  it("without a resume path, a submitted purchase reports the pending tx and never resubmits", async () => {
    const b = await buyer();
    const m = merchant({ settle: async () => Promise.reject(new SettlementError("submitted but outcome unknown: timeout", TX, true)) });
    await deliverPaidRequest(b.input, m.deps);
    const again = await deliverPaidRequest(b.input, m.deps);
    assert.deepEqual([again.status, "txHash" in again && again.txHash], [202, TX]);
    assert.equal(m.calls.settle, 1);
  });

  it("a failure before submission releases the claim so the retry can settle", async () => {
    const b = await buyer();
    let fail = true;
    const m = merchant({ settle: async () => (fail ? Promise.reject(new SettlementError("RPC is not Arc Testnet")) : { txHash: TX }) });
    assert.equal((await deliverPaidRequest(b.input, m.deps)).status, 502);
    assert.equal(m.deliveries.get(b.request.purchaseId), undefined);
    fail = false;
    ok(await deliverPaidRequest(b.input, m.deps));
    assert.equal(m.calls.settle, 2);
  });

  it("buyer re-acceptance of the same receipt is a no-op; a different receipt for the purchase is a mismatch", async () => {
    const b = await buyer();
    const response = ok(await deliverPaidRequest(b.input, merchant().deps));
    const accept = (receiptHeader: string) =>
      acceptDelivery({ response: { body: response.body, receiptHeader }, trusted: TRUSTED, request: b.request, store: b.ledger, now: DEMO_NOW + 10 });
    assert.equal((await accept(response.headers[RECEIPT_HEADER]!)).accepted, true);
    const again = await accept(response.headers[RECEIPT_HEADER]!);
    assert.equal(again.accepted && again.outcome.kind, "delivery_already_recorded");

    const reissued = await signDeliveryReceipt({ signer: MERCHANT_RECEIPT_KEY, merchantId: TRUSTED.merchantId, request: b.request, contentHash: hashContent(ARTIFACT), txHash: TX, issuedAt: DEMO_NOW + 99 });
    const conflict = await accept(encodeReceiptHeader(reissued));
    assert.equal(!conflict.accepted && conflict.code, "ledger_mismatch");
    assert.equal(b.ledger.counts().deliveries, 1);
  });

  it("the ledger flags a receipt whose tx differs from the observed settlement", async () => {
    const b = await buyer();
    const otherTx: Hex = `0x${"bb".repeat(32)}`;
    const response = ok(await deliverPaidRequest(b.input, merchant({ settle: async () => ({ txHash: otherTx }) }).deps));
    ingestSettlement(b.ledger, b.request, b.nonce, TX);
    const result = await acceptDelivery({ response: { body: response.body, receiptHeader: response.headers[RECEIPT_HEADER] }, trusted: TRUSTED, request: b.request, store: b.ledger, now: DEMO_NOW });
    assert.equal(!result.accepted && result.code, "ledger_mismatch");
    assert.equal(b.ledger.settlement(b.request.purchaseId)!.ledgerOutcome, "mismatch");
  });
});
