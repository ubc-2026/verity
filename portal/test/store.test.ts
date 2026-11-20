import assert from "node:assert/strict";
import { test } from "node:test";
import { PortalStore, type PurchaseInput } from "../src/store.ts";

const nonce = "0x" + "ab".repeat(32);
const salt = "0x" + "11".repeat(32);
const requestHash = "0x" + "22".repeat(32);
const tx = "0x" + "33".repeat(32);
const blockHash = "0x" + "44".repeat(32);
const digest = "0x" + "55".repeat(32);

function purchase(overrides: Partial<PurchaseInput> = {}): PurchaseInput {
  return {
    purchaseId: "purchase-direct-1",
    missionId: "mission-1",
    quoteId: "quote-1",
    contractId: "contract-1",
    evidenceType: "resolution_source",
    merchantLabel: "Demo merchant",
    rail: "arc-eip3009",
    amountBaseUnits: "50000",
    chainId: 5042002,
    token: "0x3600000000000000000000000000000000000000",
    payer: "0x1111111111111111111111111111111111111111",
    payTo: "0x2222222222222222222222222222222222222222",
    nonce,
    salt,
    requestHash,
    deliveryDeadlineUtc: "2026-12-31T00:00:00Z",
    environment: "arc-testnet",
    ...overrides,
  };
}

test("a direct-rail purchase reconciles only after a final matching log and a delivery", () => {
  const store = new PortalStore();
  const registered = store.registerPurchase(purchase(), "2026-11-19T00:00:00Z");
  assert.equal(registered.created, true);
  assert.equal(registered.purchase.ledgerStatus, "Payment pending");
  assert.equal(registered.purchase.quicknode, "waiting");

  store.observe(10, [
    {
      txHash: tx,
      blockNumber: 10,
      blockHash,
      kind: "transfer",
      payer: purchase().payer,
      payTo: purchase().payTo,
      amountBaseUnits: "50000",
      nonce: null,
      logIndex: 0,
      source: "quicknode",
      seenAtUtc: "2026-11-19T00:01:00Z",
    },
    {
      txHash: tx,
      blockNumber: 10,
      blockHash,
      kind: "authorization",
      payer: purchase().payer,
      payTo: null,
      amountBaseUnits: "0",
      nonce,
      logIndex: 1,
      source: "quicknode",
      seenAtUtc: "2026-11-19T00:01:00Z",
    },
  ]);
  assert.equal(store.view("purchase-direct-1")?.ledgerStatus, "Payment pending");

  store.observe(11, []);
  assert.equal(store.view("purchase-direct-1")?.ledgerStatus, "Paid, delivery missing");
  assert.equal(store.view("purchase-direct-1")?.quicknode, "matched");
  assert.equal(store.view("purchase-direct-1")?.txHash, tx);

  const delivered = store.noteDelivery({
    purchaseId: "purchase-direct-1",
    ok: true,
    detail: "delivery verified",
    contentHash: digest,
    recordedAtUtc: "2026-11-19T00:02:00Z",
  });
  assert.equal(delivered.ledgerStatus, "Reconciled");
  store.close();
});

test("a nonce with different payment fields is a mismatch", () => {
  const store = new PortalStore();
  store.registerPurchase(purchase(), "2026-11-19T00:00:00Z");
  store.observe(12, [
    {
      txHash: tx,
      blockNumber: 10,
      blockHash,
      kind: "transfer",
      payer: purchase().payer,
      payTo: purchase().payTo,
      amountBaseUnits: "1",
      nonce: null,
      logIndex: 0,
      source: "quicknode",
      seenAtUtc: "2026-11-19T00:01:00Z",
    },
    {
      txHash: tx,
      blockNumber: 10,
      blockHash,
      kind: "authorization",
      payer: purchase().payer,
      payTo: null,
      amountBaseUnits: "0",
      nonce,
      logIndex: 1,
      source: "quicknode",
      seenAtUtc: "2026-11-19T00:01:00Z",
    },
  ]);
  const view = store.view("purchase-direct-1");
  assert.equal(view?.ledgerStatus, "Mismatch");
  assert.equal(view?.quicknode, "matched");
  store.close();
});

test("a Gateway nanopayment is never claimed from a chain log", () => {
  const store = new PortalStore();
  store.registerPurchase(
    purchase({
      purchaseId: "purchase-nano-1",
      quoteId: "quote-nano-1",
      rail: "circle-gateway-batched",
      amountBaseUnits: "1000",
    }),
    "2026-11-19T00:00:00Z",
  );
  store.observe(20, [
    {
      txHash: tx,
      blockNumber: 18,
      blockHash,
      kind: "authorization",
      payer: purchase().payer,
      payTo: null,
      amountBaseUnits: "0",
      nonce,
      logIndex: 1,
      source: "quicknode",
      seenAtUtc: "2026-11-19T00:01:00Z",
    },
  ]);
  const waiting = store.view("purchase-nano-1");
  assert.equal(waiting?.quicknode, "not_claimed");
  assert.equal(waiting?.txHash, null);
  assert.equal(waiting?.ledgerStatus, "Payment pending");

  const accepted = store.noteGateway({
    purchaseId: "purchase-nano-1",
    paymentRef: "gw-transfer-1",
    receiptDigest: digest,
    batchStatus: "confirmed",
    batchTxHash: tx,
    updatedAtUtc: "2026-11-19T00:03:00Z",
  });
  assert.equal(accepted.quicknode, "not_claimed");
  assert.equal(accepted.ledgerStatus, "Delivered, payment unconfirmed");
  assert.equal(accepted.gateway?.settlement, "batch_settled");
  assert.equal(store.unmatched().length, 0);
  store.close();
});

test("a chain ticket with no purchase stays unmatched", () => {
  const store = new PortalStore();
  store.observe(4, [
    {
      txHash: tx,
      blockNumber: 3,
      blockHash,
      kind: "transfer",
      payer: purchase().payer,
      payTo: purchase().payTo,
      amountBaseUnits: "1000",
      nonce: null,
      logIndex: 0,
      source: "quicknode",
      seenAtUtc: "2026-11-19T00:01:00Z",
    },
    {
      txHash: tx,
      blockNumber: 3,
      blockHash,
      kind: "authorization",
      payer: purchase().payer,
      payTo: null,
      amountBaseUnits: "0",
      nonce,
      logIndex: 1,
      source: "quicknode",
      seenAtUtc: "2026-11-19T00:01:00Z",
    },
  ]);
  assert.equal(store.activity().length, 2);
  assert.equal(store.unmatched()[0]?.ledgerStatus, "Unmatched payment");
  store.close();
});
