import { createHash, timingSafeEqual } from "node:crypto";
import { overdueEventSchema, type OverdueDeliveryEventV1 } from "../../src/alerts/overdue.ts";
import type { PurchaseLedgerRecord } from "../../src/alerts/ledgerFeed.ts";

/**
 * FIXTURE MODEL of the Grok Bot overdue-delivery routine, written from the
 * contract in docs/grok-bot/overdue-delivery-incidents.md. The real routine
 * runs in the Grok Bot runtime, outside this repository, and is not called by
 * any test here. This model lets the fixture workflow check the Verity side of
 * the contract: the event it emits, the authenticated read-only recheck, and
 * one card per incident key across replays.
 */
export type RoutineOutcome =
  | "created"
  | "duplicate"
  | "unauthorized"
  | "skipped_invalid"
  | "skipped_ledger_unavailable"
  | "skipped_mismatch"
  | "skipped_delivery_verified"
  | "skipped_payment_pending"
  | "skipped_deadline_not_passed";

export interface IncidentCard {
  incidentKey: string;
  environment: string;
  purchaseId: string;
  amount: string;
  amountBaseUnits: string;
  merchantLabel: string;
  txHash: string;
  txUrl: string;
  deliveryDeadlineUtc: string;
  status: "Missing verified delivery";
  label: "FIXTURE" | null;
  replayCount: number;
  createdAtUtc: string;
  lastSeenUtc: string;
  source: "fixture-run" | "webhook";
}

const digest = (value: string) => createHash("sha256").update(value, "utf8").digest();

export class GrokRoutineModel {
  readonly cards = new Map<string, IncidentCard>();
  readonly #keyDigest: Buffer;
  readonly #recheck: (purchaseId: string) => { status: number; body: unknown };
  readonly #now: () => Date;

  constructor(options: {
    /** Routine webhook key (a `crsr_` bearer key in the real routine). */
    routineKey: string;
    /** Calls Verity's read-only feed with the feed token. */
    recheck: (purchaseId: string) => { status: number; body: unknown };
    now: () => Date;
  }) {
    this.#keyDigest = digest(options.routineKey);
    this.#recheck = options.recheck;
    this.#now = options.now;
  }

  receive(authorization: string | undefined, rawBody: string): { httpStatus: number; outcome: RoutineOutcome; incidentKey: string | null; cardCount: number } {
    const done = (httpStatus: number, outcome: RoutineOutcome, incidentKey: string | null = null) => ({
      httpStatus,
      outcome,
      incidentKey,
      cardCount: this.cards.size,
    });
    const key = authorization?.match(/^Bearer (\S+)$/)?.[1];
    if (!key || !timingSafeEqual(digest(key), this.#keyDigest)) return done(401, "unauthorized");

    let event: OverdueDeliveryEventV1;
    try {
      event = overdueEventSchema.parse(JSON.parse(rawBody));
    } catch {
      return done(200, "skipped_invalid");
    }
    const incidentKey = `${event.environment}:${event.purchaseId}:${event.exceptionType}`;

    const response = this.#recheck(event.purchaseId);
    if (response.status !== 200 || !response.body || typeof response.body !== "object") {
      return done(200, "skipped_ledger_unavailable", incidentKey);
    }
    const record = response.body as PurchaseLedgerRecord;
    if (
      record.purchaseId !== event.purchaseId ||
      !record.txHash ||
      record.txHash.toLowerCase() !== event.txHash.toLowerCase() ||
      BigInt(record.amountBaseUnits) !== BigInt(event.amountBaseUnits)
    ) {
      return done(200, "skipped_mismatch", incidentKey);
    }
    if (record.ledgerStatus === "Reconciled") return done(200, "skipped_delivery_verified", incidentKey);
    if (!record.settlementConfirmed || record.ledgerStatus === "Payment pending" || record.ledgerStatus === "Delivered, payment unconfirmed") {
      return done(200, "skipped_payment_pending", incidentKey);
    }
    if (record.ledgerStatus !== "Paid, delivery missing") return done(200, "skipped_mismatch", incidentKey);
    const now = this.#now();
    if (!(new Date(record.deliveryDeadlineUtc).getTime() < now.getTime())) {
      return done(200, "skipped_deadline_not_passed", incidentKey);
    }

    const nowIso = now.toISOString().replace(/\.\d{3}Z$/, "Z");
    const existing = this.cards.get(incidentKey);
    if (existing) {
      this.cards.set(incidentKey, { ...existing, replayCount: existing.replayCount + 1, lastSeenUtc: nowIso });
      return done(200, "duplicate", incidentKey);
    }
    const units = BigInt(record.amountBaseUnits);
    this.cards.set(incidentKey, {
      incidentKey,
      environment: event.environment,
      purchaseId: event.purchaseId,
      amount: `${units / 1_000_000n}.${(units % 1_000_000n).toString().padStart(6, "0").slice(0, 2)} testnet USDC`,
      amountBaseUnits: record.amountBaseUnits,
      merchantLabel: record.merchantLabel,
      txHash: record.txHash,
      txUrl: `https://explorer.testnet.arc.io/tx/${record.txHash}`,
      deliveryDeadlineUtc: record.deliveryDeadlineUtc,
      status: "Missing verified delivery",
      label: event.environment === "fixture" ? "FIXTURE" : null,
      replayCount: 0,
      createdAtUtc: nowIso,
      lastSeenUtc: nowIso,
      source: "webhook",
    });
    return done(200, "created", incidentKey);
  }
}
