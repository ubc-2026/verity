import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AuditLedger } from "../src/payments/ledger.ts";

const hash = "0xecb8d0303298a3bff971405264cc3670f3297da1468bd6c39a3e32e5abd2dda9";

describe("audit ledger", () => {
  it("reconciles a payment that has a matching delivery", () => {
    const ledger = new AuditLedger();
    ledger.notePayment("purchase-1", { requestHash: hash, nonce: hash, amount: "50000" });
    ledger.noteDelivery("purchase-1", { ok: true, detail: "matched" });
    assert.equal(ledger.entries()[0]?.status, "reconciled");
  });

  it("keeps the four failure statuses apart", () => {
    const ledger = new AuditLedger();
    ledger.notePayment("paid-only", { requestHash: hash, nonce: hash, amount: "50000" });
    ledger.noteDelivery("delivered-only", { ok: true, detail: "receipt arrived before the payment" });
    ledger.noteMismatch("swapped", "delivered bytes do not match the quoted document");
    ledger.noteDuplicate("paid-only", "same authorization submitted again");
    const status = Object.fromEntries(ledger.entries().map((entry) => [entry.purchaseId + ":" + entry.status, entry.status]));
    assert.equal(status["paid-only:paid_delivery_missing"], "paid_delivery_missing");
    assert.equal(status["delivered-only:delivered_payment_unconfirmed"], "delivered_payment_unconfirmed");
    assert.equal(status["swapped:mismatch"], "mismatch");
    assert.equal(status["paid-only:duplicate"], "duplicate");
  });
});
