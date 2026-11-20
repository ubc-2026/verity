import { DatabaseSync } from "node:sqlite";

/** Same two rails as feat/circle-nanopayments. */
export type PaymentRail = "arc-eip3009" | "circle-gateway-batched";

export const LEDGER_STATUSES = [
  "Reconciled",
  "Paid, delivery missing",
  "Delivered, payment unconfirmed",
  "Mismatch",
  "Duplicate payment",
  "Payment pending",
  "Unmatched payment",
] as const;

export type LedgerStatus = (typeof LEDGER_STATUSES)[number];

export interface PurchaseInput {
  purchaseId: string;
  missionId: string;
  quoteId: string;
  contractId: string;
  evidenceType: string;
  merchantLabel: string;
  rail: PaymentRail;
  amountBaseUnits: string;
  chainId: number;
  token: string;
  payer: string;
  payTo: string;
  nonce: string;
  salt: string;
  requestHash: string;
  deliveryDeadlineUtc: string;
  environment: "fixture" | "arc-testnet";
}

export interface DeliveryInput {
  purchaseId: string;
  ok: boolean;
  detail: string;
  contentHash: string | null;
  recordedAtUtc: string;
}

export interface GatewayInput {
  purchaseId: string;
  paymentRef: string;
  receiptDigest: string;
  batchStatus: string | null;
  batchTxHash: string | null;
  updatedAtUtc: string;
}

export interface ObservationInput {
  txHash: string;
  blockNumber: number;
  blockHash: string;
  kind: "transfer" | "authorization";
  payer: string;
  payTo: string | null;
  amountBaseUnits: string;
  nonce: string | null;
  logIndex: number;
  source: string;
  seenAtUtc: string;
}

export interface ChainLog {
  blockNumber: number;
  txHash: string;
  kind: "transfer" | "authorization";
  from: string;
  to: string | null;
  amountBaseUnits: string | null;
  nonce: string | null;
}

export interface PortalPurchase {
  purchaseId: string;
  rail: PaymentRail;
  merchantLabel: string;
  amountBaseUnits: string;
  payer: string;
  payTo: string;
  nonce: string;
  ledgerStatus: LedgerStatus;
  detail: string;
  txHash: string | null;
  quicknode: "matched" | "waiting" | "not_claimed";
  gateway: {
    paymentRef: string;
    batchStatus: string | null;
    batchTxHash: string | null;
    settlement: "pending_batch" | "batch_settled" | "failed";
  } | null;
}

export interface UnmatchedObservation {
  ledgerStatus: "Unmatched payment";
  txHash: string;
  payer: string;
  payTo: string;
  amountBaseUnits: string;
  nonce: string;
  blockNumber: number;
  detail: string;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS purchases (
  purchase_id    TEXT PRIMARY KEY,
  mission_id     TEXT NOT NULL,
  quote_id       TEXT NOT NULL UNIQUE,
  contract_id    TEXT NOT NULL,
  evidence_type  TEXT NOT NULL,
  merchant_label TEXT NOT NULL,
  amount         TEXT NOT NULL,
  rail           TEXT NOT NULL CHECK (rail IN ('arc-eip3009', 'circle-gateway-batched')),
  chain_id       INTEGER NOT NULL,
  token          TEXT NOT NULL,
  payer          TEXT NOT NULL,
  pay_to         TEXT NOT NULL,
  nonce          TEXT NOT NULL,
  salt           TEXT NOT NULL,
  request_hash   TEXT NOT NULL,
  deadline       TEXT NOT NULL,
  environment    TEXT NOT NULL CHECK (environment IN ('fixture', 'arc-testnet')),
  created_at     TEXT NOT NULL,
  UNIQUE (chain_id, token, payer, nonce)
) STRICT;
CREATE TABLE IF NOT EXISTS deliveries (
  purchase_id  TEXT PRIMARY KEY REFERENCES purchases(purchase_id),
  ok           INTEGER NOT NULL CHECK (ok IN (0, 1)),
  detail       TEXT NOT NULL,
  content_hash TEXT,
  recorded_at  TEXT NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS gateway_payments (
  purchase_id    TEXT PRIMARY KEY REFERENCES purchases(purchase_id),
  payment_ref    TEXT NOT NULL UNIQUE,
  receipt_digest TEXT NOT NULL,
  batch_status   TEXT,
  batch_tx_hash  TEXT,
  updated_at     TEXT NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS observations (
  tx_hash      TEXT NOT NULL,
  block_number INTEGER NOT NULL,
  block_hash   TEXT NOT NULL,
  kind         TEXT NOT NULL CHECK (kind IN ('transfer', 'authorization')),
  payer        TEXT NOT NULL,
  pay_to       TEXT NOT NULL,
  amount       TEXT NOT NULL,
  nonce        TEXT NOT NULL,
  log_index    INTEGER NOT NULL,
  source       TEXT NOT NULL,
  seen_at      TEXT NOT NULL,
  PRIMARY KEY (tx_hash, kind, log_index)
) STRICT;
CREATE TABLE IF NOT EXISTS chain_head (
  id           INTEGER PRIMARY KEY CHECK (id = 1),
  block_number INTEGER NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS observations_nonce ON observations(nonce);
`;

const GATEWAY_REASON =
  "Circle Gateway settles many nanopayments in one batch, and a single USDC log cannot prove which purchase it was. QuickNode is not claimed for this rail.";

type Row = Record<string, string | number | bigint | null>;

export class PortalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PortalError";
  }
}

export class PortalStore {
  readonly #db: DatabaseSync;
  readonly #finalityDepth: number;

  constructor(path = ":memory:", finalityDepth = 1) {
    this.#db = new DatabaseSync(path);
    this.#db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
    const columns = this.#db.prepare(`PRAGMA table_info(observations)`).all() as Array<{ name: string }>;
    if (columns.length > 0 && !columns.some((column) => column.name === "kind")) this.#db.exec(`DROP TABLE observations`);
    this.#db.exec(SCHEMA);
    this.#finalityDepth = finalityDepth;
  }

  close(): void {
    this.#db.close();
  }

  registerPurchase(input: PurchaseInput, createdAtUtc: string): { purchase: PortalPurchase; created: boolean } {
    const existing = this.#purchaseRow(input.purchaseId);
    if (existing) {
      if (!samePurchase(existing, input)) throw new PortalError("purchase already registered with different terms");
      return { purchase: this.#view(existing), created: false };
    }
    if (this.#db.prepare(`SELECT purchase_id FROM purchases WHERE nonce = ?`).get(input.nonce)) {
      throw new PortalError("nonce already belongs to another purchase");
    }
    this.#db
      .prepare(
        `INSERT INTO purchases (
          purchase_id, mission_id, quote_id, contract_id, evidence_type, merchant_label, amount, rail,
          chain_id, token, payer, pay_to, nonce, salt, request_hash, deadline, environment, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.purchaseId,
        input.missionId,
        input.quoteId,
        input.contractId,
        input.evidenceType,
        input.merchantLabel.trim(),
        input.amountBaseUnits,
        input.rail,
        input.chainId,
        input.token,
        input.payer,
        input.payTo,
        input.nonce,
        input.salt,
        input.requestHash,
        input.deliveryDeadlineUtc,
        input.environment,
        createdAtUtc,
      );
    return { purchase: this.#view(this.#purchaseRow(input.purchaseId)!), created: true };
  }

  noteDelivery(input: DeliveryInput): PortalPurchase {
    const purchase = this.#purchaseRow(input.purchaseId);
    if (!purchase) throw new PortalError("unknown purchase");
    if (input.ok && !input.contentHash) throw new PortalError("verified delivery requires a content hash");
    this.#db
      .prepare(
        `INSERT INTO deliveries (purchase_id, ok, detail, content_hash, recorded_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(purchase_id) DO UPDATE SET ok = excluded.ok, detail = excluded.detail, content_hash = excluded.content_hash, recorded_at = excluded.recorded_at`,
      )
      .run(input.purchaseId, input.ok ? 1 : 0, input.detail.slice(0, 240), input.contentHash, input.recordedAtUtc);
    return this.#view(purchase);
  }

  noteGateway(input: GatewayInput): PortalPurchase {
    const purchase = this.#purchaseRow(input.purchaseId);
    if (!purchase) throw new PortalError("unknown purchase");
    if (purchase.rail !== "circle-gateway-batched") throw new PortalError("purchase is not on the Gateway rail");
    const existing = this.#db.prepare(`SELECT payment_ref, receipt_digest FROM gateway_payments WHERE purchase_id = ?`).get(input.purchaseId) as
      | Row
      | undefined;
    if (existing && existing.payment_ref !== input.paymentRef) {
      throw new PortalError("a different Gateway transfer is already recorded for this purchase");
    }
    if (existing && existing.receipt_digest !== input.receiptDigest && input.batchStatus === null) {
      throw new PortalError("a different receipt is already recorded for this purchase");
    }
    this.#db
      .prepare(
        `INSERT INTO gateway_payments (purchase_id, payment_ref, receipt_digest, batch_status, batch_tx_hash, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(purchase_id) DO UPDATE SET
           batch_status = COALESCE(excluded.batch_status, gateway_payments.batch_status),
           batch_tx_hash = COALESCE(excluded.batch_tx_hash, gateway_payments.batch_tx_hash),
           updated_at = excluded.updated_at`,
      )
      .run(input.purchaseId, input.paymentRef, input.receiptDigest, input.batchStatus, input.batchTxHash, input.updatedAtUtc);
    return this.#view(purchase);
  }

  observe(head: number, observations: ObservationInput[]): { stored: number; head: number } {
    const current = this.head();
    const next = Math.max(current, head);
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      this.#db.prepare(`INSERT INTO chain_head (id, block_number) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET block_number = excluded.block_number`).run(next);
      const insert = this.#db.prepare(
        `INSERT OR IGNORE INTO observations (
          tx_hash, block_number, block_hash, kind, payer, pay_to, amount, nonce, log_index, source, seen_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      let stored = 0;
      for (const observation of observations) {
        const result = insert.run(
          observation.txHash,
          observation.blockNumber,
          observation.blockHash,
          observation.kind,
          observation.payer,
          observation.payTo ?? "",
          observation.amountBaseUnits,
          observation.nonce ?? "",
          observation.logIndex,
          observation.source,
          observation.seenAtUtc,
        );
        stored += Number(result.changes);
      }
      this.#db.exec("COMMIT");
      return { stored, head: next };
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  head(): number {
    const row = this.#db.prepare(`SELECT block_number FROM chain_head WHERE id = 1`).get() as Row | undefined;
    return row ? Number(row.block_number) : 0;
  }

  view(purchaseId: string): PortalPurchase | undefined {
    const row = this.#purchaseRow(purchaseId);
    return row ? this.#view(row) : undefined;
  }

  list(): PortalPurchase[] {
    const rows = this.#db.prepare(`SELECT * FROM purchases ORDER BY created_at`).all() as unknown as PurchaseRow[];
    return rows.map((row) => this.#view(row));
  }

  activity(limit = 100): ChainLog[] {
    const rows = this.#db
      .prepare(`SELECT * FROM observations ORDER BY block_number DESC, log_index DESC LIMIT ?`)
      .all(limit) as Row[];
    return rows.map((row) => ({
      blockNumber: Number(row.block_number),
      txHash: String(row.tx_hash),
      kind: row.kind === "authorization" ? "authorization" : "transfer",
      from: String(row.payer),
      to: row.kind === "transfer" ? String(row.pay_to) : null,
      amountBaseUnits: row.kind === "transfer" ? String(row.amount) : null,
      nonce: row.nonce ? String(row.nonce) : null,
    }));
  }

  unmatched(limit = 25): UnmatchedObservation[] {
    const rows = this.#db
      .prepare(
        `SELECT * FROM observations o
         WHERE o.kind = 'authorization' AND o.nonce != ''
           AND NOT EXISTS (SELECT 1 FROM purchases p WHERE p.nonce = o.nonce)
         ORDER BY block_number DESC
         LIMIT ?`,
      )
      .all(limit) as Row[];
    return rows.map((row) => ({
      ledgerStatus: "Unmatched payment",
      txHash: String(row.tx_hash),
      payer: String(row.payer),
      payTo: String(row.pay_to),
      amountBaseUnits: String(row.amount),
      nonce: String(row.nonce),
      blockNumber: Number(row.block_number),
      detail: "authorization nonce does not match a nanopayment purchase",
    }));
  }

  counts(): { purchases: number; observations: number; head: number } {
    const one = (sql: string) => Number((this.#db.prepare(sql).get() as Row).n);
    return {
      purchases: one(`SELECT COUNT(*) AS n FROM purchases`),
      observations: one(`SELECT COUNT(*) AS n FROM observations`),
      head: this.head(),
    };
  }

  #purchaseRow(purchaseId: string): PurchaseRow | undefined {
    return this.#db.prepare(`SELECT * FROM purchases WHERE purchase_id = ?`).get(purchaseId) as PurchaseRow | undefined;
  }

  #view(purchase: PurchaseRow): PortalPurchase {
    const gateway = this.#gateway(purchase.purchase_id);
    if (purchase.rail === "circle-gateway-batched") return this.#gatewayView(purchase, gateway);
    return this.#directView(purchase);
  }

  #directView(purchase: PurchaseRow): PortalPurchase {
    const delivery = this.#delivery(purchase.purchase_id);
    const rows = this.#db.prepare(`SELECT * FROM observations WHERE kind = 'authorization' AND nonce = ?`).all(purchase.nonce) as Row[];
    const good = rows.filter((row) => String(row.payer) === purchase.payer && this.#transferMatches(purchase, String(row.tx_hash)));
    const bad = rows.filter((row) => !good.includes(row));
    const confirmed = good.filter((row) => this.#final(Number(row.block_number)));
    const hashes = new Set(rows.map((row) => String(row.tx_hash)));
    let ledgerStatus: LedgerStatus = "Payment pending";
    let detail = "waiting for a matching Arc Testnet settlement";
    let quicknode: PortalPurchase["quicknode"] = "waiting";
    if (delivery && !delivery.ok) {
      ledgerStatus = "Mismatch";
      detail = delivery.detail || "delivery does not match the quoted bytes";
      quicknode = confirmed.length > 0 ? "matched" : "waiting";
    } else if (bad.length > 0 && good.length === 0) {
      ledgerStatus = "Mismatch";
      detail = "authorization nonce was seen, but the payer, recipient, or amount differs";
      quicknode = "matched";
    } else if (hashes.size > 1) {
      ledgerStatus = "Duplicate payment";
      detail = "more than one settlement used this purchase nonce";
      quicknode = "matched";
    } else if (good.length === 1 && this.#final(Number(good[0]!.block_number)) && delivery?.ok) {
      ledgerStatus = "Reconciled";
      detail = "confirmed transfer matches the purchase and the delivery receipt";
      quicknode = "matched";
    } else if (good.length === 1 && this.#final(Number(good[0]!.block_number))) {
      ledgerStatus = "Paid, delivery missing";
      detail = "confirmed transfer, no verified delivery";
      quicknode = "matched";
    } else if (good.length === 1) {
      ledgerStatus = "Payment pending";
      detail = "matching transfer seen, waiting for finality";
      quicknode = "waiting";
    } else if (delivery?.ok) {
      ledgerStatus = "Delivered, payment unconfirmed";
      detail = delivery.detail || "delivery verified, matching transfer not confirmed";
    }
    const primary = confirmed[0] ?? good[0] ?? rows[0] ?? null;
    return {
      purchaseId: purchase.purchase_id,
      rail: "arc-eip3009",
      merchantLabel: purchase.merchant_label,
      amountBaseUnits: purchase.amount,
      payer: purchase.payer,
      payTo: purchase.pay_to,
      nonce: purchase.nonce,
      ledgerStatus,
      detail,
      txHash: primary ? String(primary.tx_hash) : null,
      quicknode,
      gateway: null,
    };
  }

  #gatewayView(purchase: PurchaseRow, gateway: GatewayRow | undefined): PortalPurchase {
    const seen = this.#db.prepare(`SELECT tx_hash FROM observations WHERE nonce = ? LIMIT 1`).get(purchase.nonce) as Row | undefined;
    const base = {
      purchaseId: purchase.purchase_id,
      rail: "circle-gateway-batched" as const,
      merchantLabel: purchase.merchant_label,
      amountBaseUnits: purchase.amount,
      payer: purchase.payer,
      payTo: purchase.pay_to,
      nonce: purchase.nonce,
      txHash: null,
      quicknode: "not_claimed" as const,
      gateway: gateway
        ? {
            paymentRef: gateway.payment_ref,
            batchStatus: gateway.batch_status,
            batchTxHash: gateway.batch_tx_hash,
            settlement: gatewaySettlement(gateway.batch_status),
          }
        : null,
    };
    if (!gateway) {
      return {
        ...base,
        ledgerStatus: "Payment pending",
        detail: seen
          ? `A USDC log carries this nonce. ${GATEWAY_REASON}`
          : "waiting for Circle Gateway to accept this nanopayment",
      };
    }
    if (gateway.batch_status === "failed") {
      return { ...base, ledgerStatus: "Mismatch", detail: `Circle reported this nanopayment as failed. ${GATEWAY_REASON}` };
    }
    if (gateway.batch_status === "confirmed" || gateway.batch_status === "completed") {
      return {
        ...base,
        ledgerStatus: "Delivered, payment unconfirmed",
        detail: `Circle batch is ${gateway.batch_status}. ${GATEWAY_REASON}`,
      };
    }
    return {
      ...base,
      ledgerStatus: "Payment pending",
      detail: `Gateway accepted the nanopayment. Batch is ${gateway.batch_status ?? "not reported yet"}. ${GATEWAY_REASON}`,
    };
  }

  #delivery(purchaseId: string): { ok: boolean; detail: string } | undefined {
    const row = this.#db.prepare(`SELECT ok, detail FROM deliveries WHERE purchase_id = ?`).get(purchaseId) as Row | undefined;
    return row ? { ok: Number(row.ok) === 1, detail: String(row.detail) } : undefined;
  }

  #gateway(purchaseId: string): GatewayRow | undefined {
    return this.#db.prepare(`SELECT * FROM gateway_payments WHERE purchase_id = ?`).get(purchaseId) as GatewayRow | undefined;
  }

  #final(blockNumber: number): boolean {
    return this.head() - blockNumber >= this.#finalityDepth;
  }

  #transferMatches(purchase: PurchaseRow, txHash: string): boolean {
    const row = this.#db
      .prepare(`SELECT 1 AS ok FROM observations WHERE tx_hash = ? AND kind = 'transfer' AND payer = ? AND pay_to = ? AND amount = ? LIMIT 1`)
      .get(txHash, purchase.payer, purchase.pay_to, purchase.amount);
    return Boolean(row);
  }
}

interface PurchaseRow {
  purchase_id: string;
  merchant_label: string;
  amount: string;
  rail: PaymentRail;
  payer: string;
  pay_to: string;
  nonce: string;
  mission_id: string;
  quote_id: string;
  contract_id: string;
  evidence_type: string;
  chain_id: number;
  token: string;
  salt: string;
  request_hash: string;
  deadline: string;
  environment: string;
}

interface GatewayRow {
  payment_ref: string;
  receipt_digest: string;
  batch_status: string | null;
  batch_tx_hash: string | null;
}

function samePurchase(row: PurchaseRow, input: PurchaseInput): boolean {
  return (
    row.mission_id === input.missionId &&
    row.quote_id === input.quoteId &&
    row.contract_id === input.contractId &&
    row.evidence_type === input.evidenceType &&
    row.merchant_label === input.merchantLabel.trim() &&
    row.amount === input.amountBaseUnits &&
    row.rail === input.rail &&
    Number(row.chain_id) === input.chainId &&
    row.token === input.token &&
    row.payer === input.payer &&
    row.pay_to === input.payTo &&
    row.nonce === input.nonce &&
    row.salt === input.salt &&
    row.request_hash === input.requestHash &&
    row.deadline === input.deliveryDeadlineUtc &&
    row.environment === input.environment
  );
}

function gatewaySettlement(status: string | null): "pending_batch" | "batch_settled" | "failed" {
  if (status === "failed") return "failed";
  if (status === "confirmed" || status === "completed") return "batch_settled";
  return "pending_batch";
}
