import type { DatabaseSync } from "node:sqlite";
import { hexToBigInt, type Hex } from "viem";
import { ARC_TESTNET } from "../payments/arc.ts";
import type { PaymentStore } from "../payments/store.ts";

export const AUTHORIZATION_USED_TOPIC: Hex = "0x98de503528ee59b575ef0c0a2576a82497bfc029a5685b209e9ec333479b10a5";
export const TRANSFER_TOPIC: Hex = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

/** One filtered receipt, as emitted by quicknode/verity-usdc-filter.js. */
export interface StreamMatch {
  blockNumber: Hex;
  blockHash: Hex;
  blockTimestamp: Hex;
  transactionHash: Hex;
  status: Hex;
  logs: Array<{ address: Hex; topics: Hex[]; data: Hex; logIndex: Hex }>;
}

export type ReconcileOutcome =
  | { kind: "settlement_recorded"; purchaseId: string; nonce: Hex }
  | { kind: "settlement_already_recorded"; purchaseId: string; nonce: Hex }
  | { kind: "not_final"; purchaseId: string; nonce: Hex }
  | { kind: "unmatched_payment" | "mismatch" | "failed_receipt"; nonce: Hex | null; detail: string };

export interface IngestResult {
  eventId: string;
  duplicateEvent: boolean;
  outcomes: ReconcileOutcome[];
}

export interface SettlementRecord {
  purchaseId: string;
  chainId: number;
  token: string;
  payer: string;
  payTo: string;
  amount: string;
  nonce: string;
  txHash: string;
  blockNumber: number;
  blockHash: string;
  blockTimestamp: number;
  authorizationLogIndex: number;
  transferLogIndex: number;
  settlementStatus: "confirmed";
  deliveryStatus: "pending";
  ledgerOutcome: "settlement_confirmed_delivery_pending";
  source: string;
  firstEventId: string;
  recordedAt: number;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS webhook_events (
  event_id     TEXT PRIMARY KEY,
  stream_id    TEXT NOT NULL,
  batch_start  INTEGER,
  batch_end    INTEGER,
  payload      TEXT NOT NULL,
  received_at  INTEGER NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS settlements (
  purchase_id             TEXT PRIMARY KEY REFERENCES purchases(purchase_id),
  chain_id                INTEGER NOT NULL,
  token                   TEXT NOT NULL,
  payer                   TEXT NOT NULL,
  pay_to                  TEXT NOT NULL,
  amount                  TEXT NOT NULL,
  nonce                   TEXT NOT NULL,
  tx_hash                 TEXT NOT NULL,
  block_number            INTEGER NOT NULL,
  block_hash              TEXT NOT NULL,
  block_timestamp         INTEGER NOT NULL,
  authorization_log_index INTEGER NOT NULL,
  transfer_log_index      INTEGER NOT NULL,
  settlement_status       TEXT NOT NULL CHECK (settlement_status = 'confirmed'),
  delivery_status         TEXT NOT NULL CHECK (delivery_status IN ('pending', 'verified', 'missing', 'mismatch')),
  ledger_outcome          TEXT NOT NULL,
  source                  TEXT NOT NULL,
  first_event_id          TEXT NOT NULL REFERENCES webhook_events(event_id),
  recorded_at             INTEGER NOT NULL,
  UNIQUE (chain_id, token, payer, nonce),
  UNIQUE (chain_id, tx_hash, authorization_log_index)
) STRICT;
CREATE TABLE IF NOT EXISTS reconciliation_findings (
  tx_hash    TEXT NOT NULL,
  log_index  INTEGER NOT NULL,
  kind       TEXT NOT NULL,
  detail     TEXT NOT NULL,
  event_id   TEXT NOT NULL,
  found_at   INTEGER NOT NULL,
  PRIMARY KEY (tx_hash, log_index, kind)
) STRICT;
`;

const topicAddress = (topic: Hex | undefined) => (topic ? (`0x${topic.slice(-40)}`.toLowerCase() as Hex) : null);
const num = (hex: Hex) => Number(hexToBigInt(hex));

/**
 * Settlement ledger fed by QuickNode Streams. Matching is by the payment's
 * authorization identity (chain, token, payer, nonce) and is idempotent: a
 * replayed event or a re-delivered receipt never creates a second settlement.
 */
export class ReconciliationLedger {
  readonly #db: DatabaseSync;
  readonly #chainId: number;
  readonly #token: Hex;

  constructor(store: PaymentStore, chain: { chainId: number; token: Hex } = { chainId: ARC_TESTNET.chainId, token: ARC_TESTNET.usdc }) {
    this.#db = store.database;
    this.#db.exec(SCHEMA);
    this.#chainId = chain.chainId;
    this.#token = chain.token.toLowerCase() as Hex;
  }

  settlement(purchaseId: string): SettlementRecord | undefined {
    const row = this.#db.prepare(`SELECT * FROM settlements WHERE purchase_id = ?`).get(purchaseId) as Record<string, string | number> | undefined;
    if (!row) return undefined;
    return {
      purchaseId: row.purchase_id as string,
      chainId: row.chain_id as number,
      token: row.token as string,
      payer: row.payer as string,
      payTo: row.pay_to as string,
      amount: row.amount as string,
      nonce: row.nonce as string,
      txHash: row.tx_hash as string,
      blockNumber: row.block_number as number,
      blockHash: row.block_hash as string,
      blockTimestamp: row.block_timestamp as number,
      authorizationLogIndex: row.authorization_log_index as number,
      transferLogIndex: row.transfer_log_index as number,
      settlementStatus: row.settlement_status as "confirmed",
      deliveryStatus: row.delivery_status as "pending",
      ledgerOutcome: row.ledger_outcome as "settlement_confirmed_delivery_pending",
      source: row.source as string,
      firstEventId: row.first_event_id as string,
      recordedAt: row.recorded_at as number,
    };
  }

  counts(): { events: number; settlements: number; findings: number } {
    const one = (sql: string) => (this.#db.prepare(sql).get() as { n: number }).n;
    return {
      events: one(`SELECT COUNT(*) AS n FROM webhook_events`),
      settlements: one(`SELECT COUNT(*) AS n FROM settlements`),
      findings: one(`SELECT COUNT(*) AS n FROM reconciliation_findings`),
    };
  }

  /**
   * Persists the event and reconciles its matches in one transaction.
   * `finalizedBlock` is the chain's finalized height when the event was handled.
   */
  ingest(event: {
    eventId: string;
    streamId: string;
    batchStart: number | null;
    batchEnd: number | null;
    payload: string;
    matches: StreamMatch[];
    finalizedBlock: bigint;
    now: number;
    /** Where the event came from; "quicknode-streams" only for real QuickNode deliveries. */
    source?: string;
  }): IngestResult {
    const db = this.#db;
    db.exec("BEGIN IMMEDIATE");
    try {
      const inserted = db
        .prepare(`INSERT OR IGNORE INTO webhook_events (event_id, stream_id, batch_start, batch_end, payload, received_at) VALUES (?, ?, ?, ?, ?, ?)`)
        .run(event.eventId, event.streamId, event.batchStart, event.batchEnd, event.payload, event.now);
      const duplicateEvent = Number(inserted.changes) === 0;
      const outcomes = event.matches.flatMap((match) => this.#reconcile(match, event.eventId, event.finalizedBlock, event.now, event.source ?? "quicknode-streams"));
      db.exec("COMMIT");
      return { eventId: event.eventId, duplicateEvent, outcomes };
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  #finding(match: StreamMatch, logIndex: Hex | number, kind: string, detail: string, eventId: string, now: number) {
    this.#db
      .prepare(`INSERT OR IGNORE INTO reconciliation_findings (tx_hash, log_index, kind, detail, event_id, found_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(match.transactionHash.toLowerCase(), typeof logIndex === "number" ? logIndex : num(logIndex), kind, detail, eventId, now);
  }

  #reconcile(match: StreamMatch, eventId: string, finalizedBlock: bigint, now: number, source: string): ReconcileOutcome[] {
    const tokenLogs = match.logs.filter((log) => log.address.toLowerCase() === this.#token);
    const authorizations = tokenLogs.filter((log) => log.topics[0] === AUTHORIZATION_USED_TOPIC);
    const outcomes: ReconcileOutcome[] = [];

    for (const authLog of authorizations) {
      const payer = topicAddress(authLog.topics[1]);
      const nonce = (authLog.topics[2]?.toLowerCase() ?? null) as Hex | null;
      if (match.status !== "0x1") {
        this.#finding(match, authLog.logIndex, "failed_receipt", `receipt status ${match.status}`, eventId, now);
        outcomes.push({ kind: "failed_receipt", nonce, detail: `receipt status ${match.status}` });
        continue;
      }

      const row = this.#db
        .prepare(
          `SELECT a.purchase_id, a.payer, a.nonce, a.tx_hash, a.request_json, r.status AS reservation_status
           FROM authorizations a JOIN reservations r USING (purchase_id)
           WHERE a.chain_id = ? AND a.token = ? AND a.payer = ? AND a.nonce = ?`,
        )
        .get(this.#chainId, this.#token, payer, nonce) as Record<string, string> | undefined;
      if (!row || !nonce) {
        const detail = `no stored authorization for payer ${payer} nonce ${nonce}`;
        this.#finding(match, authLog.logIndex, "unmatched_payment", detail, eventId, now);
        outcomes.push({ kind: "unmatched_payment", nonce, detail });
        continue;
      }

      const request = JSON.parse(row.request_json as string) as { payTo: string; amount: string };
      const transfer = tokenLogs.find(
        (log) =>
          log.topics[0] === TRANSFER_TOPIC &&
          topicAddress(log.topics[1]) === payer &&
          topicAddress(log.topics[2]) === request.payTo &&
          hexToBigInt(log.data) === BigInt(request.amount),
      );
      const problems: string[] = [];
      if (!transfer) problems.push(`no USDC Transfer ${payer} -> ${request.payTo} of ${request.amount}`);
      if (row.tx_hash && row.tx_hash.toLowerCase() !== match.transactionHash.toLowerCase()) {
        problems.push(`stored tx ${row.tx_hash} differs from observed ${match.transactionHash}`);
      }
      if (row.reservation_status === "released") problems.push("reservation was released before settlement");
      if (problems.length > 0) {
        this.#finding(match, authLog.logIndex, "mismatch", problems.join("; "), eventId, now);
        outcomes.push({ kind: "mismatch", nonce, detail: problems.join("; ") });
        continue;
      }

      const purchaseId = row.purchase_id as string;
      if (hexToBigInt(match.blockNumber) > finalizedBlock) {
        outcomes.push({ kind: "not_final", purchaseId, nonce });
        continue;
      }

      const insert = this.#db
        .prepare(
          `INSERT OR IGNORE INTO settlements
             (purchase_id, chain_id, token, payer, pay_to, amount, nonce, tx_hash, block_number, block_hash, block_timestamp,
              authorization_log_index, transfer_log_index, settlement_status, delivery_status, ledger_outcome, source,
              first_event_id, recorded_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'confirmed', 'pending', 'settlement_confirmed_delivery_pending',
                   ?, ?, ?)`,
        )
        .run(
          purchaseId,
          this.#chainId,
          this.#token,
          payer,
          request.payTo,
          request.amount,
          nonce,
          match.transactionHash.toLowerCase(),
          num(match.blockNumber),
          match.blockHash.toLowerCase(),
          num(match.blockTimestamp),
          num(authLog.logIndex),
          num(transfer!.logIndex),
          source,
          eventId,
          now,
        );
      this.#db
        .prepare(`UPDATE authorizations SET status = 'settled', tx_hash = COALESCE(tx_hash, ?), updated_at = ? WHERE purchase_id = ?`)
        .run(match.transactionHash.toLowerCase(), now, purchaseId);
      this.#db
        .prepare(`UPDATE reservations SET status = 'spent', updated_at = ? WHERE purchase_id = ? AND status = 'held'`)
        .run(now, purchaseId);

      outcomes.push({
        kind: Number(insert.changes) === 1 ? "settlement_recorded" : "settlement_already_recorded",
        purchaseId,
        nonce,
      });
    }
    return outcomes;
  }
}
