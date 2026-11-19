import { createHash, timingSafeEqual } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

/**
 * The purchase record the Grok Bot routine rechecks before it opens an
 * incident card (docs/grok-bot/overdue-delivery-incidents.md, "Latest record
 * fields"). It is derived from the payment store and the QuickNode
 * reconciliation ledger; nothing here writes.
 */
export const LEDGER_STATUS = {
  reconciled: "Reconciled",
  paidDeliveryMissing: "Paid, delivery missing",
  deliveredPaymentUnconfirmed: "Delivered, payment unconfirmed",
  paymentPending: "Payment pending",
  mismatch: "Mismatch",
} as const;
export type LedgerStatus = (typeof LEDGER_STATUS)[keyof typeof LEDGER_STATUS];

export interface PurchaseLedgerRecord {
  purchaseId: string;
  /** Settlement tx from QuickNode, else the receipt's or submission's tx; null before any submission. */
  txHash: string | null;
  amountBaseUnits: string;
  ledgerStatus: LedgerStatus;
  settlementConfirmed: boolean;
  deliveryDeadlineUtc: string;
  merchantLabel: string;
}

export interface FeedOptions {
  /** Seconds after the confirmed settlement block by which a verified delivery is due. */
  deliveryWindowSeconds: number;
  merchantLabel: (purchaseId: string, merchantId: string) => string;
}

const iso = (seconds: number) => new Date(seconds * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
type Row = Record<string, string | number | null>;

export function purchaseRecord(db: DatabaseSync, purchaseId: string, options: FeedOptions): PurchaseLedgerRecord | undefined {
  const auth = db
    .prepare(`SELECT a.status, a.tx_hash, a.request_json FROM authorizations a WHERE a.purchase_id = ?`)
    .get(purchaseId) as Row | undefined;
  if (!auth) return undefined;
  const request = JSON.parse(auth.request_json as string) as { amount: string; merchantId: string; validBefore: number };
  const settlement = db
    .prepare(`SELECT tx_hash, delivery_status, block_timestamp FROM settlements WHERE purchase_id = ?`)
    .get(purchaseId) as Row | undefined;
  const delivery = db.prepare(`SELECT tx_hash FROM deliveries WHERE purchase_id = ?`).get(purchaseId) as Row | undefined;

  let ledgerStatus: LedgerStatus;
  let txHash: string | null;
  let deadline: number;
  if (settlement) {
    txHash = settlement.tx_hash as string;
    deadline = (settlement.block_timestamp as number) + options.deliveryWindowSeconds;
    ledgerStatus =
      settlement.delivery_status === "verified"
        ? LEDGER_STATUS.reconciled
        : settlement.delivery_status === "mismatch"
          ? LEDGER_STATUS.mismatch
          : LEDGER_STATUS.paidDeliveryMissing;
  } else {
    txHash = (delivery?.tx_hash as string | undefined) ?? (auth.tx_hash as string | null) ?? null;
    deadline = request.validBefore + options.deliveryWindowSeconds;
    ledgerStatus = delivery ? LEDGER_STATUS.deliveredPaymentUnconfirmed : LEDGER_STATUS.paymentPending;
  }
  return {
    purchaseId,
    txHash,
    amountBaseUnits: request.amount,
    ledgerStatus,
    settlementConfirmed: settlement !== undefined,
    deliveryDeadlineUtc: iso(deadline),
    merchantLabel: options.merchantLabel(purchaseId, request.merchantId),
  };
}

/** Confirmed settlements with no verified delivery whose deadline is strictly before `now`. */
export function overduePurchaseIds(db: DatabaseSync, now: number, deliveryWindowSeconds: number): string[] {
  const rows = db
    .prepare(
      `SELECT purchase_id FROM settlements
       WHERE delivery_status = 'pending' AND block_timestamp + ? < ?
       ORDER BY purchase_id`,
    )
    .all(deliveryWindowSeconds, now) as Row[];
  return rows.map((row) => row.purchase_id as string);
}

const digest = (value: string) => createHash("sha256").update(value, "utf8").digest();

/**
 * Read-only incident feed: `GET /purchases/{purchaseId}` with a bearer token
 * scoped to the feed. Any other method or path is refused. The token is
 * compared by SHA-256 digest in constant time.
 */
export function handleLedgerFeed(
  request: { method: string; url: string; authorization: string | undefined },
  deps: { tokenDigest: Buffer; db: DatabaseSync; options: FeedOptions },
): { status: number; body: unknown } {
  if (request.method !== "GET") return { status: 405, body: { error: "read-only feed" } };
  const token = request.authorization?.match(/^Bearer (\S{16,512})$/)?.[1];
  if (!token || !timingSafeEqual(digest(token), deps.tokenDigest)) return { status: 401, body: { error: "unauthorized" } };
  const match = request.url.match(/^\/purchases\/([^/?#]+)$/);
  if (!match) return { status: 404, body: { error: "not found" } };
  let purchaseId: string;
  try {
    purchaseId = decodeURIComponent(match[1]!);
  } catch {
    return { status: 400, body: { error: "bad purchase id" } };
  }
  const record = purchaseRecord(deps.db, purchaseId, deps.options);
  return record ? { status: 200, body: record } : { status: 404, body: { error: "not found" } };
}

export function feedTokenDigest(token: string): Buffer {
  return digest(token);
}
