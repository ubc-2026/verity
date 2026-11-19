import type { Hex } from "viem";

export type LedgerStatus =
  | "reconciled"
  | "paid_delivery_missing"
  | "delivered_payment_unconfirmed"
  | "mismatch"
  | "duplicate";

export interface LedgerEntry {
  purchaseId: string;
  status: LedgerStatus;
  detail: string;
  amount: string | null;
  requestHash: Hex | null;
  nonce: Hex | null;
}

interface PaymentNote {
  requestHash: Hex;
  nonce: Hex;
  amount: string;
}

interface DeliveryNote {
  ok: boolean;
  detail: string;
}

/**
 * Local audit log. A confirmed payment here means the merchant accepted the
 * authorization. It is not an Arc Testnet transaction.
 */
export class AuditLedger {
  readonly #payments = new Map<string, PaymentNote>();
  readonly #deliveries = new Map<string, DeliveryNote>();
  readonly #duplicates: Array<{ purchaseId: string; detail: string }> = [];
  readonly #mismatches: Array<{ purchaseId: string; detail: string }> = [];

  notePayment(purchaseId: string, note: PaymentNote): void {
    this.#payments.set(purchaseId, note);
  }

  noteDelivery(purchaseId: string, note: DeliveryNote): void {
    this.#deliveries.set(purchaseId, note);
  }

  noteDuplicate(purchaseId: string, detail: string): void {
    this.#duplicates.push({ purchaseId, detail });
  }

  noteMismatch(purchaseId: string, detail: string): void {
    this.#mismatches.push({ purchaseId, detail });
  }

  entries(): LedgerEntry[] {
    const rows: LedgerEntry[] = [];
    const seen = new Set<string>();

    for (const [purchaseId, payment] of this.#payments) {
      seen.add(purchaseId);
      const delivery = this.#deliveries.get(purchaseId);
      if (!delivery) {
        rows.push({
          purchaseId,
          status: "paid_delivery_missing",
          detail: "payment accepted, no verified delivery",
          amount: payment.amount,
          requestHash: payment.requestHash,
          nonce: payment.nonce,
        });
      } else if (!delivery.ok) {
        rows.push({
          purchaseId,
          status: "mismatch",
          detail: delivery.detail,
          amount: payment.amount,
          requestHash: payment.requestHash,
          nonce: payment.nonce,
        });
      } else {
        rows.push({
          purchaseId,
          status: "reconciled",
          detail: "payment accepted and the delivery receipt matches the quoted bytes",
          amount: payment.amount,
          requestHash: payment.requestHash,
          nonce: payment.nonce,
        });
      }
    }

    for (const [purchaseId, delivery] of this.#deliveries) {
      if (seen.has(purchaseId)) continue;
      rows.push({
        purchaseId,
        status: delivery.ok ? "delivered_payment_unconfirmed" : "mismatch",
        detail: delivery.detail,
        amount: null,
        requestHash: null,
        nonce: null,
      });
    }

    for (const mismatch of this.#mismatches) {
      if (rows.some((row) => row.purchaseId === mismatch.purchaseId && row.status === "mismatch")) continue;
      rows.push({
        purchaseId: mismatch.purchaseId,
        status: "mismatch",
        detail: mismatch.detail,
        amount: null,
        requestHash: null,
        nonce: null,
      });
    }

    for (const duplicate of this.#duplicates) {
      rows.push({
        purchaseId: duplicate.purchaseId,
        status: "duplicate",
        detail: duplicate.detail,
        amount: null,
        requestHash: null,
        nonce: null,
      });
    }

    return rows;
  }
}
