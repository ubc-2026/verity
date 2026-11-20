import type { DatabaseSync } from "node:sqlite";
import type { Hex } from "viem";
import type { GatewayTransfer } from "./circleGateway.ts";
import type { SignedGatewayReceipt } from "./gatewayReceipt.ts";
import type { PaymentStore, StoredAuthorization } from "./store.ts";

/**
 * Buyer-side record of Gateway purchases. Three facts are kept apart:
 *   accepted   Circle Gateway accepted the payment and the merchant's V2 receipt
 *              (bound to Circle's transfer ID and Verity's purchase ID) was verified
 *   batch      Circle's per-payment status moves only forward
 *              (received -> batched -> confirmed -> completed). `failed` is terminal
 *              and is recorded only before the transfer is confirmed. The batch row
 *              and the reservation spend commit in one transaction.
 *   quicknode  never claimed per payment: a Gateway batch settles many payments in one
 *              transaction, and Circle does not document how to attribute a transfer
 *              inside it, so a QuickNode log cannot prove this purchase's match
 *
 * Circle's transfer record and the verified receipt may arrive in either order. A
 * transfer seen first is checked against the stored authorization and kept as an
 * observation; the receipt must later name that same transfer.
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
CREATE TABLE IF NOT EXISTS gateway_transfer_observations (
  purchase_id  TEXT PRIMARY KEY REFERENCES purchases(purchase_id),
  transfer_id  TEXT NOT NULL UNIQUE,
  status       TEXT NOT NULL,
  tx_hash      TEXT,
  updated_at   INTEGER NOT NULL
) STRICT;
`;

export type GatewayAcceptOutcome =
  | { kind: "accepted"; purchaseId: string; paymentRef: string }
  | { kind: "already_recorded"; purchaseId: string; paymentRef: string }
  | { kind: "mismatch"; purchaseId: string; detail: string };

export interface GatewayPaymentStatus {
  purchaseId: string;
  paymentRef: string;
  /** awaiting_verified_delivery: Circle reported the transfer, but no verified receipt is recorded yet. */
  acceptance: "accepted_by_gateway" | "awaiting_verified_delivery";
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

  #transaction<T>(work: () => T): T {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const result = work();
      this.#db.exec("COMMIT");
      return result;
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  /**
   * Records a verified V2 receipt. The nonce must be the one the buyer stored and signed for this purchase.
   * If Circle's transfer was observed first, the receipt must name that same transfer, and the batch
   * status already observed is kept.
   */
  recordVerifiedDelivery(args: { receipt: SignedGatewayReceipt; digest: Hex; now: number }): GatewayAcceptOutcome {
    const { receipt } = args;
    const stored = this.#store.get(receipt.purchaseId);
    if (!stored) return { kind: "mismatch", purchaseId: receipt.purchaseId, detail: "receipt names an unknown purchase" };
    if (stored.rail !== "circle-gateway-batched") return { kind: "mismatch", purchaseId: receipt.purchaseId, detail: "purchase is not on the Gateway rail" };
    if (stored.nonce !== receipt.authorizationNonce) return { kind: "mismatch", purchaseId: receipt.purchaseId, detail: "receipt nonce differs from the stored authorization" };
    return this.#transaction((): GatewayAcceptOutcome => {
      const existing = this.#db.prepare(`SELECT payment_ref, receipt_digest FROM gateway_payments WHERE purchase_id = ?`).get(receipt.purchaseId) as
        | { payment_ref: string; receipt_digest: string }
        | undefined;
      if (existing) {
        if (existing.receipt_digest === args.digest) return { kind: "already_recorded", purchaseId: receipt.purchaseId, paymentRef: existing.payment_ref };
        return { kind: "mismatch", purchaseId: receipt.purchaseId, detail: "a different receipt is already recorded for this purchase" };
      }
      const observed = this.#observation(receipt.purchaseId);
      if (observed && observed.transfer_id !== receipt.paymentRef) {
        return { kind: "mismatch", purchaseId: receipt.purchaseId, detail: `receipt names transfer ${receipt.paymentRef}, but Circle reported ${observed.transfer_id} for this purchase` };
      }
      const taken = this.#db.prepare(`SELECT purchase_id FROM gateway_payments WHERE payment_ref = ? OR nonce = ?`).get(receipt.paymentRef, receipt.authorizationNonce);
      if (taken) return { kind: "mismatch", purchaseId: receipt.purchaseId, detail: "Gateway transfer ID is already tied to another purchase" };
      this.#db
        .prepare(
          `INSERT INTO gateway_payments (purchase_id, payment_ref, nonce, receipt_digest, receipt_json, accepted_at, batch_status, batch_tx_hash, batch_updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          receipt.purchaseId,
          receipt.paymentRef,
          receipt.authorizationNonce,
          args.digest,
          JSON.stringify(receipt),
          args.now,
          observed?.status ?? null,
          observed?.tx_hash ?? null,
          observed?.updated_at ?? null,
        );
      return { kind: "accepted", purchaseId: receipt.purchaseId, paymentRef: receipt.paymentRef };
    });
  }

  /**
   * Applies Circle's per-payment record, before or after the verified receipt. It must describe this
   * purchase's stored authorization (nonce, payer, payee, amount) and, once a receipt is recorded, be
   * the transfer the receipt named. Status only moves forward, and the status row and the reservation
   * spend commit together, so a delayed pending response cannot overwrite a completed batch and a
   * repeated completed response spends the reservation once.
   */
  recordBatch(purchaseId: string, transfer: GatewayTransfer, now: number): GatewayPaymentStatus | { error: string } {
    const stored = this.#store.get(purchaseId);
    if (!stored || stored.rail !== "circle-gateway-batched") return { error: "no Gateway purchase with this ID" };
    const refused = this.#transaction((): { error: string } | null => {
      const row = this.#db.prepare(`SELECT payment_ref, batch_status FROM gateway_payments WHERE purchase_id = ?`).get(purchaseId) as
        | { payment_ref: string; batch_status: string | null }
        | undefined;
      if (row && row.payment_ref !== transfer.id) return { error: `transfer ${transfer.id} is not the one on the receipt (${row.payment_ref})` };
      // No receipt row yet, so the transfer id is not bound to this purchase. A missing nonce cannot be checked.
      if (!row && !transfer.nonce) return { error: `transfer ${transfer.id} does not match the stored authorization (nonce)` };
      const problem = transferMismatch(transfer, stored);
      if (problem) return { error: `transfer ${transfer.id} does not match the stored authorization (${problem})` };
      if (row) {
        if (!allowsBatchTransition(row.batch_status, transfer.status)) return null;
        this.#db
          .prepare(`UPDATE gateway_payments SET batch_status = ?, batch_tx_hash = COALESCE(?, batch_tx_hash), batch_updated_at = ? WHERE purchase_id = ?`)
          .run(transfer.status, transfer.txHash, now, purchaseId);
      } else {
        const observed = this.#observation(purchaseId);
        if (observed && observed.transfer_id !== transfer.id) return { error: `transfer ${transfer.id} differs from the one already observed (${observed.transfer_id})` };
        if (!observed && this.#db.prepare(`SELECT 1 FROM gateway_transfer_observations WHERE transfer_id = ?`).get(transfer.id)) {
          return { error: `transfer ${transfer.id} is already tied to another purchase` };
        }
        if (!allowsBatchTransition(observed?.status ?? null, transfer.status)) return null;
        this.#db
          .prepare(
            `INSERT INTO gateway_transfer_observations (purchase_id, transfer_id, status, tx_hash, updated_at) VALUES (?, ?, ?, ?, ?)
             ON CONFLICT (purchase_id) DO UPDATE SET status = excluded.status, tx_hash = COALESCE(excluded.tx_hash, tx_hash), updated_at = excluded.updated_at`,
          )
          .run(purchaseId, transfer.id, transfer.status, transfer.txHash, now);
      }
      if (transfer.status === "confirmed" || transfer.status === "completed") {
        // Circle: wait for `confirmed` before crediting; only then does the reservation become spend.
        this.#db.prepare(`UPDATE reservations SET status = 'spent', updated_at = ? WHERE purchase_id = ? AND status = 'held'`).run(now, purchaseId);
      }
      return null;
    });
    return refused ?? this.status(purchaseId)!;
  }

  status(purchaseId: string): GatewayPaymentStatus | undefined {
    const row = this.#db.prepare(`SELECT * FROM gateway_payments WHERE purchase_id = ?`).get(purchaseId) as
      | Record<string, string | number | null>
      | undefined;
    const observed = row ? undefined : this.#observation(purchaseId);
    if (!row && !observed) return undefined;
    const batchStatus = ((row ? row.batch_status : observed!.status) as GatewayTransfer["status"] | null) ?? "unknown";
    return {
      purchaseId,
      paymentRef: row ? (row.payment_ref as string) : observed!.transfer_id,
      acceptance: row ? "accepted_by_gateway" : "awaiting_verified_delivery",
      batch: { status: batchStatus, txHash: ((row ? row.batch_tx_hash : observed!.tx_hash) as string | null) ?? null },
      settlement: batchStatus === "failed" ? "failed" : batchStatus === "confirmed" || batchStatus === "completed" ? "batch_settled" : "pending_batch",
      quicknode: { status: "not_claimed", reason: QUICKNODE_REASON },
    };
  }

  /** The verified receipt recorded for this purchase, if any. */
  receipt(purchaseId: string): { receipt: SignedGatewayReceipt; digest: Hex; acceptedAt: number } | undefined {
    const row = this.#db.prepare(`SELECT receipt_json, receipt_digest, accepted_at FROM gateway_payments WHERE purchase_id = ?`).get(purchaseId) as
      | { receipt_json: string; receipt_digest: string; accepted_at: number }
      | undefined;
    return row ? { receipt: JSON.parse(row.receipt_json) as SignedGatewayReceipt, digest: row.receipt_digest as Hex, acceptedAt: row.accepted_at } : undefined;
  }

  #observation(purchaseId: string) {
    return this.#db.prepare(`SELECT transfer_id, status, tx_hash, updated_at FROM gateway_transfer_observations WHERE purchase_id = ?`).get(purchaseId) as
      | { transfer_id: string; status: string; tx_hash: string | null; updated_at: number }
      | undefined;
  }
}

/** Circle's transfer must be the one this purchase authorized. Returns the first field that differs, or null. */
function transferMismatch(transfer: GatewayTransfer, stored: StoredAuthorization): string | null {
  if (transfer.nonce && transfer.nonce.toLowerCase() !== stored.nonce.toLowerCase()) return "nonce";
  if (transfer.fromAddress.toLowerCase() !== stored.request.payer.toLowerCase()) return "payer";
  if (transfer.toAddress.toLowerCase() !== stored.request.payTo.toLowerCase()) return "payee";
  // Circle reports base units ("1000" in the archived live transfer), as the merchant's nonce check assumes.
  if (!/^\d+$/.test(transfer.amount) || BigInt(transfer.amount) !== BigInt(stored.request.amount)) return "amount";
  return null;
}

/**
 * Circle transfer order is received -> batched -> confirmed -> completed.
 * `failed` can replace an unconfirmed transfer and is then terminal.
 * A later response at the same or an earlier rank is ignored.
 */
function allowsBatchTransition(current: string | null, next: GatewayTransfer["status"]): boolean {
  if (current === null) return true;
  if (current === "completed" || current === "failed") return false;
  if (next === "failed") return current === "received" || current === "batched";
  const rank: Record<string, number> = { received: 1, batched: 2, confirmed: 3, completed: 4 };
  const from = rank[current];
  const to = rank[next];
  return from !== undefined && to !== undefined && to > from;
}
