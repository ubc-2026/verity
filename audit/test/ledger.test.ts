import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ARC_USDC } from "../src/chain.ts";
import { Ledger } from "../src/ledger.ts";
import { openLedger } from "../src/store.ts";
import { authorizationLog, block, OTHER, payload, PAYER, PAY_TO, purchase, receipt, transferLog, word } from "./fixture.ts";

function settled(tx = word(100), amount = 50000n, nonce = word(1), from = PAYER, to = PAY_TO) {
  return receipt(tx, [authorizationLog(from, nonce), transferLog(from, to, amount)]);
}

test("a finalized matching transfer with a verified delivery is reconciled", () => {
  const ledger = new Ledger(undefined, { finalityDepth: 1, expectedNetwork: "arc-testnet" });
  ledger.registerPurchase(purchase());
  ledger.ingest(
    payload([
      block(10, word(10), word(9), [settled()]),
      block(11, word(11), word(10)),
    ]),
  );
  ledger.noteDelivery({
    purchaseId: "purchase-1",
    ok: true,
    detail: "receipt matched",
    contentHash: word(3),
    recordedAtUtc: "2026-11-18T00:00:00Z",
  });
  const view = ledger.view("purchase-1");
  assert.equal(view?.ledgerStatus, "Reconciled");
  assert.equal(view?.settlementConfirmed, true);
  assert.equal(view?.txHash, word(100));
  assert.equal(view?.amountBaseUnits, "50000");
});

test("finality holds the payment in pending until a later block arrives", () => {
  const ledger = new Ledger(undefined, { finalityDepth: 1 });
  ledger.registerPurchase(purchase());
  ledger.ingest(payload([block(10, word(10), word(9), [settled()])]));
  assert.equal(ledger.view("purchase-1")?.ledgerStatus, "Payment pending");
  assert.equal(ledger.view("purchase-1")?.settlementConfirmed, false);
  ledger.ingest(payload([block(11, word(11), word(10))]));
  assert.equal(ledger.view("purchase-1")?.ledgerStatus, "Paid, delivery missing");
});

test("a verified delivery without a transfer stays unconfirmed", () => {
  const ledger = new Ledger();
  ledger.registerPurchase(purchase());
  ledger.noteDelivery({
    purchaseId: "purchase-1",
    ok: true,
    detail: "receipt matched",
    contentHash: word(3),
    recordedAtUtc: "2026-11-18T00:00:00Z",
  });
  const view = ledger.view("purchase-1");
  assert.equal(view?.ledgerStatus, "Delivered, payment unconfirmed");
  assert.equal(view?.settlementConfirmed, false);
  assert.equal(view?.txHash, null);
});

test("a wrong amount or a rejected delivery is a mismatch", () => {
  const ledger = new Ledger(undefined, { finalityDepth: 0 });
  ledger.registerPurchase(purchase());
  ledger.ingest(payload([block(10, word(10), word(9), [settled(word(100), 1n)])]));
  assert.equal(ledger.view("purchase-1")?.ledgerStatus, "Mismatch");

  const delivered = new Ledger(undefined, { finalityDepth: 0 });
  delivered.registerPurchase(purchase());
  delivered.ingest(payload([block(10, word(10), word(9), [settled()])]));
  delivered.noteDelivery({
    purchaseId: "purchase-1",
    ok: false,
    detail: "response bytes do not match the quote",
    contentHash: null,
    recordedAtUtc: "2026-11-18T00:00:00Z",
  });
  assert.equal(delivered.view("purchase-1")?.ledgerStatus, "Mismatch");
});

test("a second settlement for the same nonce is a duplicate payment", () => {
  const ledger = new Ledger(undefined, { finalityDepth: 0 });
  ledger.registerPurchase(purchase());
  ledger.ingest(
    payload([
      block(10, word(10), word(9), [settled(word(100))]),
      block(11, word(11), word(10), [settled(word(101))]),
    ]),
  );
  const view = ledger.view("purchase-1");
  assert.equal(view?.ledgerStatus, "Duplicate payment");
  assert.equal(view?.duplicateTxHash, word(101));
});

test("a reorg drops the displaced settlement", () => {
  const ledger = new Ledger(undefined, { finalityDepth: 0 });
  ledger.registerPurchase(purchase());
  ledger.ingest(payload([block(10, word(10), word(9), [settled()])]));
  assert.equal(ledger.view("purchase-1")?.ledgerStatus, "Paid, delivery missing");
  ledger.ingest(
    payload([block(10, word(12), word(9))], {
      blocks_reorged: [10],
      reorgs: [{ blockNumber: 10, hash: word(10) }],
    }),
  );
  assert.equal(ledger.view("purchase-1")?.ledgerStatus, "Payment pending");
  assert.equal(ledger.view("purchase-1")?.txHash, null);
});

test("a transfer with no purchase nonce is unmatched", () => {
  const ledger = new Ledger();
  ledger.ingest(
    payload([
      block(10, word(10), word(9), [receipt(word(100), [transferLog(OTHER, PAY_TO, 50000n)])]),
    ]),
  );
  const [payment] = ledger.unmatched();
  assert.equal(payment?.ledgerStatus, "Unmatched payment");
  assert.equal(payment?.from, OTHER);
  assert.equal(payment?.amountBaseUnits, "50000");
});

test("an overdue confirmed payment is queued once", () => {
  const ledger = new Ledger(undefined, { finalityDepth: 0 });
  ledger.registerPurchase(purchase({ deliveryDeadlineUtc: "2026-11-16T17:00:00Z", environment: "fixture" }));
  ledger.ingest(payload([block(10, word(10), word(9), [settled()])]));
  const now = new Date("2026-11-16T17:00:01Z");
  const [event] = ledger.collectOverdue(now);
  assert.equal(event?.schema, "verity.overdue_delivery.v1");
  assert.equal(event?.exceptionType, "paid_delivery_missing");
  assert.equal(event?.environment, "fixture");
  assert.equal(event?.ledgerStatus, "Paid, delivery missing");
  assert.equal(event?.settlementConfirmed, true);
  assert.equal(event?.amountBaseUnits, "50000");
  assert.equal(ledger.collectOverdue(now).length, 1);
  ledger.acknowledge(event!.purchaseId, event!.eventId);
  assert.equal(ledger.collectOverdue(now).length, 0);
});

test("a deadline that has not passed does not queue an incident", () => {
  const ledger = new Ledger(undefined, { finalityDepth: 0 });
  ledger.registerPurchase(purchase({ deliveryDeadlineUtc: "2026-11-20T17:00:00Z" }));
  ledger.ingest(payload([block(10, word(10), word(9), [settled()])]));
  assert.deepEqual(ledger.collectOverdue(new Date("2026-11-20T17:00:00Z")), []);
});

test("the ledger rejects another chain and persists a purchase", () => {
  assert.throws(() => new Ledger().registerPurchase(purchase({ chainId: 1 })), /unexpected chain/);
  const directory = mkdtempSync(join(tmpdir(), "verity-ledger-"));
  const path = join(directory, "ledger.json");
  const ledger = openLedger(path, { finalityDepth: 0 });
  ledger.registerPurchase(purchase());
  ledger.ingest(payload([block(10, word(10), word(9), [settled()])]));
  const restored = openLedger(path, { finalityDepth: 0 });
  assert.equal(restored.view("purchase-1")?.ledgerStatus, "Paid, delivery missing");
  assert.equal(restored.token, ARC_USDC);
});
