import type { DatabaseSync } from "node:sqlite";
import type { Hex } from "viem";
import type { GatewayTransfer } from "./circleGateway.ts";
import type { SignedGatewayReceipt } from "./gatewayReceipt.ts";
import type { PaymentStore } from "./store.ts";

/**
 * Buyer-side record of Gateway purchases. Three facts are kept apart:
 *   accepted   Circle Gateway accepted the payment and the merchant's V2 receipt
 *              (bound to Circle's transfer ID and Verity's purchase ID) was verified
 *   batch      Circle's per-payment status (received, batched, confirmed, completed,
 *              failed) and the batch transaction hash once Circle reports one
 *   quicknode  never claimed per payment: a Gateway batch settles many payments in one
 *              transaction, and Circle does not document how to attribute a transfer
 *              inside it, so a QuickNode log cannot prove this purchase's match
 */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS gateway_payments (
  purchase_id      TEXT PRIMARY KEY REFERENCES purchases(purchase_id),
  payment_ref      TEXT NOT NULL UNIQUE,
  nonce            TEXT NOT NULL UNIQUE,
  receipt_digest   TEXT NOT NULL,
  receipt_json     TEXT NOT NULL,
  accepted_at      INTEGER NOT NULL,
  batch_status     TEXT,
  batch_tx_hash    TEXT,
  batch_updated_at INTEGER
) STRICT;
`;

export type GatewayAcceptOutcome =
  | { kind: "accepted"; purchaseId: string; paymentRef: string }
  | { kind: "already_recorded"; purchaseId: string; paymentRef: string }
  | { kind: "mismatch"; purchaseId: string; detail: string };

export interface GatewayPaymentStatus {
  purchaseId: string;
  paymentRef: string;
  acceptance: "accepted_by_gateway";
  batch: { status: GatewayTransfer["status"] | "unknown"; txHash: string | null };
  settlement: "pending_batch" | "batch_settled" | "failed";
  quicknode: { status: "not_claimed"; reason: string };
}

const QUICKNODE_REASON =
  "Gateway settles many payments in one batch transaction and Circle does not document a per-payment link inside it, so no QuickNode match is claimed for this purchase";

export class GatewayLedger {
  readonly #db: DatabaseSync;
  readonly #store: PaymentStore;
  constructor(store: PaymentStore) {
    this.#store = store;
    this.#db = store.database;
    this.#db.exec(SCHEMA);
  }

  /** Records a verified V2 receipt. The nonce must be the one the buyer stored and signed for this purchase. */
  recordVerifiedDelivery(args: { receipt: SignedGatewayReceipt; digest: Hex; now: number }): GatewayAcceptOutcome {
    const { receipt } = args;
    const stored = this.#store.get(receipt.purchaseId);
    if (!stored) return { kind: "mismatch", purchaseId: receipt.purchaseId, detail: "receipt names an unknown purchase" };
    if (stored.rail !== "circle-gateway-batched") return { kind: "mismatch", purchaseId: receipt.purchaseId, detail: "purchase is not on the Gateway rail" };
    if (stored.nonce !== receipt.authorizationNonce) return { kind: "mismatch", purchaseId: receipt.purchaseId, detail: "receipt nonce differs from the stored authorization" };
    const existing = this.#db.prepare(`SELECT payment_ref, receipt_digest FROM gateway_payments WHERE purchase_id = ?`).get(receipt.purchaseId) as
      | { payment_ref: string; receipt_digest: string }
      | undefined;
    if (existing) {
      if (existing.receipt_digest === args.digest) return { kind: "already_recorded", purchaseId: receipt.purchaseId, paymentRef: existing.payment_ref };
      return { kind: "mismatch", purchaseId: receipt.purchaseId, detail: "a different receipt is already recorded for this purchase" };
    }
    try {
      this.#db
        .prepare(`INSERT INTO gateway_payments (purchase_id, payment_ref, nonce, receipt_digest, receipt_json, accepted_at) VALUES (?, ?, ?, ?, ?, ?)`)
        .run(receipt.purchaseId, receipt.paymentRef, receipt.authorizationNonce, args.digest, JSON.stringify(receipt), args.now);
    } catch (error) {
      if (/UNIQUE/.test((error as Error).message)) {
        return { kind: "mismatch", purchaseId: receipt.purchaseId, detail: "Gateway transfer ID is already tied to another purchase" };
      }
      throw error;
    }
    return { kind: "accepted", purchaseId: receipt.purchaseId, paymentRef: receipt.paymentRef };
  }

  /** Applies Circle's per-payment record. It must be the transfer the receipt named. */
  recordBatch(purchaseId: string, transfer: GatewayTransfer, now: number): GatewayPaymentStatus | { error: string } {
    const row = this.#db.prepare(`SELECT payment_ref FROM gateway_payments WHERE purchase_id = ?`).get(purchaseId) as { payment_ref: string } | undefined;
    if (!row) return { error: "no accepted Gateway payment for this purchase" };
    if (row.payment_ref !== transfer.id) return { error: `transfer ${transfer.id} is not the one on the receipt (${row.payment_ref})` };
    this.#db
      .prepare(`UPDATE gateway_payments SET batch_status = ?, batch_tx_hash = COALESCE(?, batch_tx_hash), batch_updated_at = ? WHERE purchase_id = ?`)
      .run(transfer.status, transfer.txHash, now, purchaseId);
    if (transfer.status === "confirmed" || transfer.status === "completed") {
      // Circle: wait for `confirmed` before crediting; only then does the reservation become spend.
      this.#db.prepare(`UPDATE reservations SET status = 'spent', updated_at = ? WHERE purchase_id = ? AND status = 'held'`).run(now, purchaseId);
    }
    return this.status(purchaseId)!;
  }

  status(purchaseId: string): GatewayPaymentStatus | undefined {
    const row = this.#db.prepare(`SELECT * FROM gateway_payments WHERE purchase_id = ?`).get(purchaseId) as
      | Record<string, string | number | null>
      | undefined;
    if (!row) return undefined;
    const batchStatus = (row.batch_status as GatewayTransfer["status"] | null) ?? "unknown";
    return {
      purchaseId,
      paymentRef: row.payment_ref as string,
      acceptance: "accepted_by_gateway",
      batch: { status: batchStatus, txHash: (row.batch_tx_hash as string | null) ?? null },
      settlement: batchStatus === "failed" ? "failed" : batchStatus === "confirmed" || batchStatus === "completed" ? "batch_settled" : "pending_batch",
      quicknode: { status: "not_claimed", reason: QUICKNODE_REASON },
    };
  }
}
