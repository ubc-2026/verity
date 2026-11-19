import { DatabaseSync } from "node:sqlite";
import type { Hex } from "viem";
import {
  commitResearchRequest,
  computeRequestHash,
  generateSalt,
  parseResearchRequestJson,
  ResearchRequestError,
  canonicalizeResearchRequest,
  type ResearchRequestV1,
} from "./researchRequest.ts";

/**
 * Durable payment records: purchase, reservation, and authorization identity.
 * All three are written in one IMMEDIATE transaction before anything is signed.
 *
 * Storage is SQLite through Node's built-in `node:sqlite` (provisional choice:
 * no native build step on Windows). Amounts are USDC base units stored as text.
 */

/** Demo policy from the README, in USDC base units (6 decimals). */
export const DEMO_POLICY = {
  missionBudget: 25_000_000n,
  minAmount: 10_000n, // 0.01 USDC
  /** Highest amount this slice approves automatically (tier 1, 0.01–0.10 USDC). */
  autoApproveMax: 100_000n,
  purchaseCap: 2_000_000n,
} as const;

export type SpendingPolicy = { [K in keyof typeof DEMO_POLICY]: bigint };

export type AuthorizationStatus = "prepared" | "signed" | "submitted" | "pending" | "settled" | "failed";

export interface StoredAuthorization {
  purchaseId: string;
  missionId: string;
  request: ResearchRequestV1;
  requestHash: Hex;
  salt: Hex;
  nonce: Hex;
  signature: Hex | null;
  status: AuthorizationStatus;
  txHash: Hex | null;
}

export class PolicyError extends Error {
  override name = "PolicyError";
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS purchases (
  purchase_id   TEXT PRIMARY KEY,
  mission_id    TEXT NOT NULL,
  quote_id      TEXT NOT NULL UNIQUE,
  contract_id   TEXT NOT NULL,
  evidence_type TEXT NOT NULL,
  amount        TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  UNIQUE (mission_id, contract_id, evidence_type)
) STRICT;
CREATE TABLE IF NOT EXISTS reservations (
  purchase_id TEXT PRIMARY KEY REFERENCES purchases(purchase_id),
  mission_id  TEXT NOT NULL,
  amount      TEXT NOT NULL,
  status      TEXT NOT NULL CHECK (status IN ('held', 'spent', 'released')),
  updated_at  INTEGER NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS authorizations (
  purchase_id  TEXT PRIMARY KEY REFERENCES purchases(purchase_id),
  chain_id     INTEGER NOT NULL,
  token        TEXT NOT NULL,
  payer        TEXT NOT NULL,
  nonce        TEXT NOT NULL,
  salt         TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  request_json TEXT NOT NULL,
  signature    TEXT,
  status       TEXT NOT NULL,
  tx_hash      TEXT,
  updated_at   INTEGER NOT NULL,
  UNIQUE (chain_id, token, payer, nonce)
) STRICT;
`;

type Row = Record<string, string | number | null>;

export class PaymentStore {
  readonly #db: DatabaseSync;
  readonly #policy: SpendingPolicy;

  constructor(path = ":memory:", policy: SpendingPolicy = DEMO_POLICY) {
    this.#db = new DatabaseSync(path);
    this.#db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
    this.#db.exec(SCHEMA);
    this.#policy = policy;
  }

  close() {
    this.#db.close();
  }

  /** Shared connection for modules that must update payment records in the same transaction. */
  get database(): DatabaseSync {
    return this.#db;
  }

  #transaction<T>(fn: () => T): T {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.#db.exec("COMMIT");
      return result;
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  get(purchaseId: string): StoredAuthorization | undefined {
    const row = this.#db
      .prepare(
        `SELECT a.*, p.mission_id FROM authorizations a JOIN purchases p USING (purchase_id) WHERE purchase_id = ?`,
      )
      .get(purchaseId) as Row | undefined;
    return row ? toStored(row) : undefined;
  }

  reservation(purchaseId: string): { amount: bigint; status: string } | undefined {
    const row = this.#db.prepare(`SELECT amount, status FROM reservations WHERE purchase_id = ?`).get(purchaseId) as
      | Row
      | undefined;
    return row ? { amount: BigInt(row.amount as string), status: row.status as string } : undefined;
  }

  /** Confirmed spend plus outstanding reservations for a mission. */
  committedSpend(missionId: string): bigint {
    const rows = this.#db
      .prepare(`SELECT amount FROM reservations WHERE mission_id = ? AND status IN ('held', 'spent')`)
      .all(missionId) as Row[];
    return rows.reduce((sum, row) => sum + BigInt(row.amount as string), 0n);
  }

  /**
   * Checks policy, reserves funds, and records the request, salt, and nonce in
   * one transaction. A repeat call for the same purchase returns the stored
   * record unchanged; a different request under the same purchase is refused.
   */
  reserveAndRecord(input: {
    missionId: string;
    request: ResearchRequestV1;
    now: number;
    saltSource?: () => Hex;
  }): { record: StoredAuthorization; reused: boolean } {
    const { missionId, request, now } = input;
    const requestHash = computeRequestHash(request);

    return this.#transaction(() => {
      const existing = this.get(request.purchaseId);
      if (existing) {
        if (existing.requestHash !== requestHash || existing.missionId !== missionId) {
          throw new ResearchRequestError(
            `purchase ${request.purchaseId} already has an authorization for a different request`,
          );
        }
        return { record: existing, reused: true };
      }

      const amount = BigInt(request.amount);
      const policy = this.#policy;
      if (amount < policy.minAmount) throw new PolicyError("amount below policy minimum");
      if (amount > policy.purchaseCap) throw new PolicyError("amount above purchase cap");
      if (amount > policy.autoApproveMax) {
        throw new PolicyError("amount requires a policy tier not implemented in this slice (material-gap or owner approval)");
      }
      if (this.committedSpend(missionId) + amount > policy.missionBudget) {
        throw new PolicyError("mission budget exceeded (confirmed spend plus reservations)");
      }

      const commitment = commitResearchRequest(request, (input.saltSource ?? generateSalt)());
      this.#db
        .prepare(
          `INSERT INTO purchases (purchase_id, mission_id, quote_id, contract_id, evidence_type, amount, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          request.purchaseId,
          missionId,
          request.quoteId,
          request.parameters.contractId,
          request.parameters.evidenceType,
          request.amount,
          now,
        );
      this.#db
        .prepare(`INSERT INTO reservations (purchase_id, mission_id, amount, status, updated_at) VALUES (?, ?, ?, 'held', ?)`)
        .run(request.purchaseId, missionId, request.amount, now);
      this.#db
        .prepare(
          `INSERT INTO authorizations
             (purchase_id, chain_id, token, payer, nonce, salt, request_hash, request_json, status, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'prepared', ?)`,
        )
        .run(
          request.purchaseId,
          request.chainId,
          request.token,
          request.payer,
          commitment.nonce,
          commitment.salt,
          commitment.requestHash,
          canonicalizeResearchRequest(request),
          now,
        );
      return { record: this.get(request.purchaseId)!, reused: false };
    });
  }

  /** Stores the signature once. Returns whichever signature is stored. */
  recordSignature(purchaseId: string, signature: Hex, now: number): StoredAuthorization {
    this.#db
      .prepare(
        `UPDATE authorizations SET signature = ?, status = 'signed', updated_at = ?
         WHERE purchase_id = ? AND signature IS NULL AND status = 'prepared'`,
      )
      .run(signature, now, purchaseId);
    const stored = this.get(purchaseId);
    if (!stored?.signature) throw new ResearchRequestError(`no authorization to sign for ${purchaseId}`);
    return stored;
  }

  /** Submission sent; outcome unknown until reconciled by nonce or transaction. */
  recordSubmission(purchaseId: string, txHash: Hex | null, now: number) {
    this.#db
      .prepare(
        `UPDATE authorizations SET status = 'pending', tx_hash = COALESCE(?, tx_hash), updated_at = ?
         WHERE purchase_id = ? AND status IN ('signed', 'pending')`,
      )
      .run(txHash, now, purchaseId);
  }

  /** Settlement confirmed on chain: the reservation becomes spend. */
  recordSettlement(purchaseId: string, txHash: Hex, now: number) {
    this.#transaction(() => {
      this.#db
        .prepare(`UPDATE authorizations SET status = 'settled', tx_hash = ?, updated_at = ? WHERE purchase_id = ?`)
        .run(txHash, now, purchaseId);
      this.#db
        .prepare(`UPDATE reservations SET status = 'spent', updated_at = ? WHERE purchase_id = ?`)
        .run(now, purchaseId);
    });
  }
}

function toStored(row: Row): StoredAuthorization {
  return {
    purchaseId: row.purchase_id as string,
    missionId: row.mission_id as string,
    request: parseResearchRequestJson(row.request_json as string),
    requestHash: row.request_hash as Hex,
    salt: row.salt as Hex,
    nonce: row.nonce as Hex,
    signature: (row.signature as Hex | null) ?? null,
    status: row.status as AuthorizationStatus,
    txHash: (row.tx_hash as Hex | null) ?? null,
  };
}
