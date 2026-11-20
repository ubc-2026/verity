import { DatabaseSync } from "node:sqlite";
import type { Hex } from "viem";
import type { PaymentRail } from "./circleGateway.ts";
import { APPROVAL_MAX, AUTO_MAX, AUTO_MIN, GAP_MAX, MISSION_BUDGET, NANOPAYMENT_POLICY, verifyOwnerApproval } from "./policy.ts";
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

/** Demo policy from the README, in USDC base units (6 decimals). Same numbers as policy.ts. */
export const DEMO_POLICY = {
  missionBudget: MISSION_BUDGET,
  minAmount: AUTO_MIN, // 0.01 USDC
  /** Tier 1: approved automatically (0.01-0.10 USDC). */
  autoApproveMax: AUTO_MAX,
  /** Tier 2: only for a material unresolved gap with no free or cached evidence (to 0.50 USDC). */
  gapMax: GAP_MAX,
  /** Above gapMax needs an owner wallet signature; above purchaseCap is refused. */
  purchaseCap: APPROVAL_MAX,
} as const;

export type SpendingPolicy = { [K in keyof typeof DEMO_POLICY]: bigint };

export type AuthorizationStatus =
  | "awaiting_approval"
  /** Owner denied, or the approval timed out. Terminal: the reservation is released and nothing can sign it. */
  | "denied"
  | "prepared"
  | "signed"
  | "submitted"
  | "pending"
  | "settled"
  | "failed"
  /** The owner declined the approval request. The reservation is released. */
  | "rejected"
  /** The authorization window closed before it was approved or signed. The reservation is released. */
  | "expired";

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
  /** Rail recorded with the reservation; it fixes the signing domain for every retry. */
  rail: PaymentRail;
}

/**
 * Every owner-approval decision, in order. `verbal_yes` is only a record of what the owner said on the call:
 * it authorizes nothing. `approved` is written only when a valid wallet signature is stored.
 */
export type ApprovalOutcome = "verbal_yes" | "approved" | "denied" | "timed_out";
export type ApprovalChannel = "voice_call" | "wallet_signature" | "timeout";

export interface ApprovalDecision {
  purchaseId: string;
  outcome: ApprovalOutcome;
  channel: ApprovalChannel;
  /** Provider conversation ID for a voice call, otherwise null. */
  conversationId: string | null;
  detail: string | null;
  decidedAt: number;
}

export class PolicyError extends Error {
  override name = "PolicyError";
}

/** Tier 3 purchase: recorded and reserved, but not signable until a valid owner approval is stored. */
export class ApprovalRequiredError extends PolicyError {
  override name = "ApprovalRequiredError";
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
CREATE TABLE IF NOT EXISTS purchase_rails (
  purchase_id TEXT PRIMARY KEY REFERENCES purchases(purchase_id),
  rail        TEXT NOT NULL CHECK (rail IN ('arc-eip3009', 'circle-gateway-batched'))
) STRICT;
CREATE TABLE IF NOT EXISTS owner_approvals (
  purchase_id  TEXT PRIMARY KEY REFERENCES purchases(purchase_id),
  owner        TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  signature    TEXT NOT NULL,
  approved_at  INTEGER NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS approval_decisions (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  purchase_id     TEXT NOT NULL REFERENCES purchases(purchase_id),
  outcome         TEXT NOT NULL CHECK (outcome IN ('verbal_yes', 'approved', 'denied', 'timed_out')),
  channel         TEXT NOT NULL CHECK (channel IN ('voice_call', 'wallet_signature', 'timeout')),
  conversation_id TEXT,
  detail          TEXT,
  decided_at      INTEGER NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS payment_controls (
  id         INTEGER PRIMARY KEY CHECK (id = 1),
  paused     INTEGER NOT NULL CHECK (paused IN (0, 1)),
  reason     TEXT,
  updated_at INTEGER NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS owner_rejections (
  purchase_id TEXT PRIMARY KEY REFERENCES purchases(purchase_id),
  reason      TEXT NOT NULL,
  rejected_at INTEGER NOT NULL
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

  /** Spending limits this store enforces. */
  get policy(): SpendingPolicy {
    return this.#policy;
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
        `SELECT a.*, p.mission_id, COALESCE(r.rail, 'arc-eip3009') AS rail
         FROM authorizations a JOIN purchases p USING (purchase_id) LEFT JOIN purchase_rails r USING (purchase_id)
         WHERE purchase_id = ?`,
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

  /** Durable pause switch. While paused nothing is reserved, approved, or signed. */
  isPaused(): boolean {
    const row = this.#db.prepare(`SELECT paused FROM payment_controls WHERE id = 1`).get() as Row | undefined;
    return row?.paused === 1;
  }

  setPaused(paused: boolean, now: number, reason: string | null = null): void {
    this.#db
      .prepare(
        `INSERT INTO payment_controls (id, paused, reason, updated_at) VALUES (1, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET paused = excluded.paused, reason = excluded.reason, updated_at = excluded.updated_at`,
      )
      .run(paused ? 1 : 0, reason, now);
  }

  /** Mission budget split into held (reserved, not yet settled) and spent amounts. */
  budget(missionId: string): { budget: bigint; held: bigint; spent: bigint; released: bigint; available: bigint } {
    const rows = this.#db.prepare(`SELECT amount, status FROM reservations WHERE mission_id = ?`).all(missionId) as Row[];
    const sum = (status: string) =>
      rows.filter((row) => row.status === status).reduce((total, row) => total + BigInt(row.amount as string), 0n);
    const held = sum("held");
    const spent = sum("spent");
    return { budget: this.#policy.missionBudget, held, spent, released: sum("released"), available: this.#policy.missionBudget - held - spent };
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
    /** True only when the analyst left a material resolution gap with no free or cached evidence. */
    materialUnresolvedGap?: boolean;
    /** Defaults to the direct EIP-3009 rail. The Gateway rail uses the explicit nanopayment policy. */
    rail?: PaymentRail;
    saltSource?: () => Hex;
  }): { record: StoredAuthorization; reused: boolean } {
    const { missionId, request, now } = input;
    const requestHash = computeRequestHash(request);

    return this.#transaction(() => {
      if (this.isPaused()) throw new PolicyError("payments are paused");
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
      const rail: PaymentRail = input.rail ?? "arc-eip3009";
      if (rail === "circle-gateway-batched") {
        if (amount < NANOPAYMENT_POLICY.minAmount || amount > NANOPAYMENT_POLICY.maxAmount) {
          throw new PolicyError("nanopayments are limited to 0.001 USDC per purchase");
        }
        if (input.materialUnresolvedGap !== true) {
          throw new PolicyError("nanopayments require a material unresolved gap with no free or cached evidence");
        }
      } else if (amount < policy.minAmount) throw new PolicyError("amount below policy minimum");
      if (amount > policy.purchaseCap) throw new PolicyError("amount above purchase cap");
      if (rail === "arc-eip3009" && amount > policy.autoApproveMax && amount <= policy.gapMax && input.materialUnresolvedGap !== true) {
        throw new PolicyError("this tier requires a material unresolved gap with no free or cached evidence");
      }
      if (this.committedSpend(missionId) + amount > policy.missionBudget) {
        throw new PolicyError("mission budget exceeded (confirmed spend plus reservations)");
      }
      const duplicate = this.#db
        .prepare(`SELECT purchase_id FROM purchases WHERE mission_id = ? AND contract_id = ? AND evidence_type = ?`)
        .get(missionId, request.parameters.contractId, request.parameters.evidenceType) as Row | undefined;
      if (duplicate) {
        throw new PolicyError(
          `duplicate purchase: ${String(duplicate.purchase_id)} already covers ${request.parameters.contractId} / ${request.parameters.evidenceType}`,
        );
      }
      const initialStatus: AuthorizationStatus = amount > policy.gapMax ? "awaiting_approval" : "prepared";

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
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
          initialStatus,
          now,
        );
      this.#db.prepare(`INSERT INTO purchase_rails (purchase_id, rail) VALUES (?, ?)`).run(request.purchaseId, rail);
      return { record: this.get(request.purchaseId)!, reused: false };
    });
  }

  /**
   * Verifies the owner's EIP-712 approval for a tier 3 purchase and makes it
   * signable. The approval binds the purchase ID and the stored request hash,
   * so it cannot be reused for another purchase or a changed request.
   */
  async recordOwnerApproval(args: { purchaseId: string; signature: Hex; owner: Hex; now: number }): Promise<StoredAuthorization> {
    const record = this.get(args.purchaseId);
    if (!record) throw new PolicyError(`no purchase ${args.purchaseId} to approve`);
    if (record.status !== "awaiting_approval") throw new PolicyError(`purchase ${args.purchaseId} is not awaiting owner approval`);
    if (this.isPaused()) throw new PolicyError("payments are paused");
    if (args.now >= record.request.validBefore) {
      this.expire(args.purchaseId, args.now);
      throw new PolicyError("owner approval expired");
    }
    const verdict = await verifyOwnerApproval({
      request: record.request,
      requestHash: record.requestHash,
      signature: args.signature,
      owner: args.owner,
      now: args.now,
    });
    if (!verdict.ok) throw new PolicyError(verdict.reason);
    this.#transaction(() => {
      this.#db
        .prepare(`INSERT INTO owner_approvals (purchase_id, owner, request_hash, signature, approved_at) VALUES (?, ?, ?, ?, ?)`)
        .run(args.purchaseId, args.owner.toLowerCase(), record.requestHash, args.signature, args.now);
      this.#db
        .prepare(`UPDATE authorizations SET status = 'prepared', updated_at = ? WHERE purchase_id = ? AND status = 'awaiting_approval'`)
        .run(args.now, args.purchaseId);
      this.#logDecision({ purchaseId: args.purchaseId, outcome: "approved", channel: "wallet_signature", conversationId: null, detail: null, decidedAt: args.now });
    });
    return this.get(args.purchaseId)!;
  }

  #logDecision(d: ApprovalDecision) {
    this.#db
      .prepare(
        `INSERT INTO approval_decisions (purchase_id, outcome, channel, conversation_id, detail, decided_at) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(d.purchaseId, d.outcome, d.channel, d.conversationId, d.detail, d.decidedAt);
  }

  /** Decisions for a purchase, oldest first. */
  approvalDecisions(purchaseId: string): ApprovalDecision[] {
    const rows = this.#db
      .prepare(`SELECT * FROM approval_decisions WHERE purchase_id = ? ORDER BY id`)
      .all(purchaseId) as Row[];
    return rows.map((row) => ({
      purchaseId: row.purchase_id as string,
      outcome: row.outcome as ApprovalOutcome,
      channel: row.channel as ApprovalChannel,
      conversationId: (row.conversation_id as string | null) ?? null,
      detail: (row.detail as string | null) ?? null,
      decidedAt: row.decided_at as number,
    }));
  }

  /**
   * The owner said yes on the call. This is logged and nothing else changes: the purchase stays
   * `awaiting_approval` until `recordOwnerApproval` verifies a wallet signature.
   */
  recordVerbalConsent(args: { purchaseId: string; conversationId: string | null; now: number }): void {
    const record = this.get(args.purchaseId);
    if (record?.status !== "awaiting_approval") throw new PolicyError(`purchase ${args.purchaseId} is not awaiting owner approval`);
    this.#logDecision({
      purchaseId: args.purchaseId,
      outcome: "verbal_yes",
      channel: "voice_call",
      conversationId: args.conversationId,
      detail: "spoken consent only; a wallet signature is still required",
      decidedAt: args.now,
    });
  }

  /**
   * Owner said no, or nobody answered in time. Terminal: the reservation is released and the
   * purchase can never be signed. Timeout is deny.
   */
  denyAwaitingApproval(args: {
    purchaseId: string;
    outcome: "denied" | "timed_out";
    channel: ApprovalChannel;
    conversationId?: string | null;
    detail?: string | null;
    now: number;
  }): void {
    this.#transaction(() => {
      const record = this.get(args.purchaseId);
      if (record?.status !== "awaiting_approval") throw new PolicyError(`purchase ${args.purchaseId} is not awaiting owner approval`);
      this.#db
        .prepare(`UPDATE authorizations SET status = 'denied', updated_at = ? WHERE purchase_id = ? AND status = 'awaiting_approval'`)
        .run(args.now, args.purchaseId);
      this.#db
        .prepare(`UPDATE reservations SET status = 'released', updated_at = ? WHERE purchase_id = ? AND status = 'held'`)
        .run(args.now, args.purchaseId);
      this.#logDecision({
        purchaseId: args.purchaseId,
        outcome: args.outcome,
        channel: args.channel,
        conversationId: args.conversationId ?? null,
        detail: args.detail ?? null,
        decidedAt: args.now,
      });
    });
  }

  /** Default on timeout is deny: any purchase still awaiting approval after its request expired is denied. */
  denyExpiredApprovals(now: number): string[] {
    const rows = this.#db.prepare(`SELECT purchase_id FROM authorizations WHERE status = 'awaiting_approval'`).all() as Row[];
    const denied: string[] = [];
    for (const row of rows) {
      const record = this.get(row.purchase_id as string);
      if (record && now >= record.request.validBefore) {
        this.denyAwaitingApproval({
          purchaseId: record.purchaseId,
          outcome: "timed_out",
          channel: "timeout",
          detail: "no valid owner signature before the request expired",
          now,
        });
        denied.push(record.purchaseId);
      }
    }
    return denied;
  }

  /**
   * The owner declined a tier 3 purchase. Only a purchase still awaiting approval
   * can be declined; its reservation is released so the budget is free again.
   */
  recordOwnerRejection(args: { purchaseId: string; reason: string; now: number }): StoredAuthorization {
    const record = this.get(args.purchaseId);
    if (!record) throw new PolicyError(`no purchase ${args.purchaseId} to reject`);
    if (record.status !== "awaiting_approval") throw new PolicyError(`purchase ${args.purchaseId} is not awaiting owner approval`);
    this.#transaction(() => {
      this.#db
        .prepare(`INSERT INTO owner_rejections (purchase_id, reason, rejected_at) VALUES (?, ?, ?)`)
        .run(args.purchaseId, args.reason.slice(0, 500), args.now);
      this.#db
        .prepare(`UPDATE authorizations SET status = 'rejected', updated_at = ? WHERE purchase_id = ? AND status = 'awaiting_approval'`)
        .run(args.now, args.purchaseId);
      this.#db
        .prepare(`UPDATE reservations SET status = 'released', updated_at = ? WHERE purchase_id = ? AND status = 'held'`)
        .run(args.now, args.purchaseId);
    });
    return this.get(args.purchaseId)!;
  }

  /**
   * Closes one purchase whose authorization window passed before it was signed.
   * A signed or submitted authorization is never expired here: its outcome is
   * decided on chain and reconciled by nonce.
   */
  expire(purchaseId: string, now: number): boolean {
    return this.#transaction(() => {
      const changed = this.#db
        .prepare(
          `UPDATE authorizations SET status = 'expired', updated_at = ?
           WHERE purchase_id = ? AND signature IS NULL AND status IN ('awaiting_approval', 'prepared')`,
        )
        .run(now, purchaseId);
      if (Number(changed.changes) === 0) return false;
      this.#db
        .prepare(`UPDATE reservations SET status = 'released', updated_at = ? WHERE purchase_id = ? AND status = 'held'`)
        .run(now, purchaseId);
      return true;
    });
  }

  /** Expires every unsigned purchase whose window has closed. Returns their IDs. */
  expireStale(now: number): string[] {
    const rows = this.#db
      .prepare(`SELECT purchase_id, request_json FROM authorizations WHERE signature IS NULL AND status IN ('awaiting_approval', 'prepared')`)
      .all() as Row[];
    return rows
      .filter((row) => (JSON.parse(row.request_json as string) as { validBefore: number }).validBefore <= now)
      .map((row) => row.purchase_id as string)
      .filter((purchaseId) => this.expire(purchaseId, now));
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
    if (stored?.status === "awaiting_approval") throw new ApprovalRequiredError(`purchase ${purchaseId} needs owner approval before signing`);
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
    rail: row.rail as PaymentRail,
  };
}
