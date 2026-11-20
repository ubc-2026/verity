import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { overduePurchaseIds, purchaseRecord, type FeedOptions } from "./ledgerFeed.ts";

export const OVERDUE_SCHEMA = "verity.overdue_delivery.v1";

const isoZ = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/);

/** Strict event contract from docs/grok-bot/overdue-delivery-incidents.md. */
export const overdueEventSchema = z.strictObject({
  schema: z.literal(OVERDUE_SCHEMA),
  eventId: z.string().min(1),
  environment: z.enum(["fixture", "arc-testnet"]),
  purchaseId: z.string().min(1),
  exceptionType: z.literal("paid_delivery_missing"),
  ledgerStatus: z.string().min(1),
  settlementConfirmed: z.boolean(),
  txHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
  amountBaseUnits: z.string().regex(/^(0|[1-9][0-9]*)$/),
  merchantLabel: z.string().min(1),
  deliveryDeadlineUtc: isoZ,
  emittedAtUtc: isoZ,
});
export type OverdueDeliveryEventV1 = z.output<typeof overdueEventSchema>;

const iso = (seconds: number) => new Date(seconds * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");

/**
 * One event per overdue purchase: a confirmed settlement with no verified
 * delivery past its deadline. A reconciled purchase never produces one.
 */
export function overdueEvents(
  db: DatabaseSync,
  args: { now: number; environment: "fixture" | "arc-testnet"; options: FeedOptions },
): OverdueDeliveryEventV1[] {
  return overduePurchaseIds(db, args.now, args.options.deliveryWindowSeconds).flatMap((purchaseId) => {
    const record = purchaseRecord(db, purchaseId, args.options);
    if (!record?.txHash || !record.settlementConfirmed) return [];
    const emittedAtUtc = iso(args.now);
    return [
      overdueEventSchema.parse({
        schema: OVERDUE_SCHEMA,
        eventId: `evt-${createHash("sha256").update(`${args.environment}|${purchaseId}|${emittedAtUtc}`).digest("hex").slice(0, 24)}`,
        environment: args.environment,
        purchaseId,
        exceptionType: "paid_delivery_missing",
        ledgerStatus: record.ledgerStatus,
        settlementConfirmed: record.settlementConfirmed,
        txHash: record.txHash,
        amountBaseUnits: record.amountBaseUnits,
        merchantLabel: record.merchantLabel,
        deliveryDeadlineUtc: record.deliveryDeadlineUtc,
        emittedAtUtc,
      }),
    ];
  });
}
