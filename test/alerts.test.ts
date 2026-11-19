import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Hex } from "viem";
import { feedTokenDigest, handleLedgerFeed, purchaseRecord, type FeedOptions } from "../src/alerts/ledgerFeed.ts";
import { overdueEvents, overdueEventSchema } from "../src/alerts/overdue.ts";
import { buildResearchRequest } from "../src/payments/buyer.ts";
import { parseQuote } from "../src/payments/quote.ts";
import { PaymentStore } from "../src/payments/store.ts";
import { ReconciliationLedger } from "../src/reconciliation/ledger.ts";
import { DEMO_CATALOG, DEMO_CATALOG_ITEM, DEMO_NOW, DEMO_PARAMETERS, DEMO_PAYER, demoQuote } from "./fixtures/scenario.ts";

const TX: Hex = `0x${"cd".repeat(32)}`;
const OPTIONS: FeedOptions = { deliveryWindowSeconds: 300, merchantLabel: (_p, m) => m };
const TOKEN = "feed-token-for-tests-0001";

function world() {
  const store = new PaymentStore();
  new ReconciliationLedger(store); // creates the settlement tables
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
  const db = store.database;
  const id = request.purchaseId;
  const settle = (deliveryStatus: string) => {
    db.prepare(`INSERT OR IGNORE INTO webhook_events (event_id, stream_id, payload, received_at) VALUES ('e1', 's', '{}', ?)`).run(DEMO_NOW);
    db.prepare(
      `INSERT OR REPLACE INTO settlements (purchase_id, chain_id, token, payer, pay_to, amount, nonce, tx_hash, block_number, block_hash,
         block_timestamp, authorization_log_index, transfer_log_index, settlement_status, delivery_status, ledger_outcome, source, first_event_id, recorded_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, '0x01', ?, 1, 2, 'confirmed', ?, 'x', 'test', 'e1', ?)`,
    ).run(id, request.chainId, request.token, request.payer, request.payTo, request.amount, store.get(id)!.nonce, TX, DEMO_NOW, deliveryStatus, DEMO_NOW);
  };
  const deliver = () =>
    db.prepare(`INSERT INTO deliveries (purchase_id, receipt_digest, tx_hash, content_hash, receipt_json, verified_at) VALUES (?, '0x01', ?, '0x02', '{}', ?)`).run(id, TX, DEMO_NOW);
  return { store, db, id, settle, deliver, request };
}

describe("ledger record for the incident feed", () => {
  it("maps each ledger state to the contract's status strings", () => {
    const w = world();
    assert.equal(purchaseRecord(w.db, w.id, OPTIONS)?.ledgerStatus, "Payment pending");
    w.deliver();
    assert.equal(purchaseRecord(w.db, w.id, OPTIONS)?.ledgerStatus, "Delivered, payment unconfirmed");
    w.settle("pending");
    const missing = purchaseRecord(w.db, w.id, OPTIONS)!;
    assert.equal(missing.ledgerStatus, "Paid, delivery missing");
    assert.equal(missing.settlementConfirmed, true);
    assert.equal(missing.deliveryDeadlineUtc, new Date((DEMO_NOW + 300) * 1000).toISOString().replace(".000Z", "Z"));
    w.settle("verified");
    assert.equal(purchaseRecord(w.db, w.id, OPTIONS)?.ledgerStatus, "Reconciled");
    w.settle("mismatch");
    assert.equal(purchaseRecord(w.db, w.id, OPTIONS)?.ledgerStatus, "Mismatch");
  });

  it("emits an overdue event only after the deadline and only for a missing delivery", () => {
    const w = world();
    w.settle("pending");
    assert.equal(overdueEvents(w.db, { now: DEMO_NOW + 300, environment: "fixture", options: OPTIONS }).length, 0);
    const [event] = overdueEvents(w.db, { now: DEMO_NOW + 301, environment: "fixture", options: OPTIONS });
    assert.ok(event);
    assert.equal(event.purchaseId, w.id);
    assert.equal(event.amountBaseUnits, w.request.amount);
    w.settle("verified");
    assert.equal(overdueEvents(w.db, { now: DEMO_NOW + 301, environment: "fixture", options: OPTIONS }).length, 0);
  });

  it("validates the event strictly: no JSON number amounts, no extra fields, Z timestamps only", () => {
    const w = world();
    w.settle("pending");
    const [event] = overdueEvents(w.db, { now: DEMO_NOW + 301, environment: "fixture", options: OPTIONS });
    assert.equal(overdueEventSchema.safeParse({ ...event, amountBaseUnits: 50000 }).success, false);
    assert.equal(overdueEventSchema.safeParse({ ...event, extra: true }).success, false);
    assert.equal(overdueEventSchema.safeParse({ ...event, emittedAtUtc: "2026-11-18T01:00:00+00:00" }).success, false);
    assert.equal(overdueEventSchema.safeParse({ ...event, settlementConfirmed: "true" }).success, false);
  });

  it("serves GET /purchases/{id} read-only behind its bearer token", () => {
    const w = world();
    const deps = { tokenDigest: feedTokenDigest(TOKEN), db: w.db, options: OPTIONS };
    const url = `/purchases/${encodeURIComponent(w.id)}`;
    assert.equal(handleLedgerFeed({ method: "GET", url, authorization: `Bearer ${TOKEN}` }, deps).status, 200);
    assert.equal(handleLedgerFeed({ method: "GET", url, authorization: "Bearer wrong-token-0000000" }, deps).status, 401);
    assert.equal(handleLedgerFeed({ method: "GET", url, authorization: undefined }, deps).status, 401);
    assert.equal(handleLedgerFeed({ method: "POST", url, authorization: `Bearer ${TOKEN}` }, deps).status, 405);
    assert.equal(handleLedgerFeed({ method: "GET", url: "/purchases/nope", authorization: `Bearer ${TOKEN}` }, deps).status, 404);
  });
});
