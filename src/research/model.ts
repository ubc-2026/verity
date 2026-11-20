/**
 * Validation and identities for research ingestion.
 *
 * Every input is untrusted until it passes these schemas: identifiers,
 * timestamps, prices (0 to 1, at most four decimals), document sizes and JSON
 * shapes are checked before any query runs. Derived fields (quote state,
 * implied probability, record identities, citation support) are computed by
 * the server, never taken from input.
 */
import { createHash } from "node:crypto";
import canonicalize from "canonicalize";
import { z } from "zod";
import { classifyQuote } from "../app/markets.ts";

const CONTROL = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/;
const text = (max: number) => z.string().min(1).max(max).refine((s) => !CONTROL.test(s), "control characters are not allowed");
const ident = z.string().regex(/^[A-Za-z0-9._:-]{1,120}$/, "identifier: letters, digits and . _ : - only");
const utc = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/, "UTC time like 2026-11-18T01:00:00Z")
  .refine((s) => Number.isFinite(Date.parse(s)), "not a real time");
const day = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "date like 2026-11-17")
  .refine((s) => Number.isFinite(Date.parse(`${s}T00:00:00Z`)), "not a real date");
const price = z.string().regex(/^(0(\.\d{1,4})?|1(\.0{1,4})?)$/, "price must be 0 to 1 with at most four decimals");
const sha256Id = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const hex32 = z.string().regex(/^0x[0-9a-f]{64}$/);
const jsonObject = z
  .record(z.string().max(80), z.unknown())
  .refine((o) => (canonicalize(o) ?? "").length <= 16_384, "JSON object is larger than 16 KiB");

export const DataLabelSchema = z.enum(["FIXTURE", "CAPTURED", "LIVE"]);
export type DataLabel = z.infer<typeof DataLabelSchema>;

export const InstrumentKeySchema = z.strictObject({
  exchange: z.string().regex(/^[a-z][a-z0-9_-]{1,31}$/),
  instrumentId: ident,
  outcomeId: ident,
});
export type InstrumentKey = z.infer<typeof InstrumentKeySchema>;

export const InstrumentInputSchema = z.strictObject({
  key: InstrumentKeySchema,
  question: text(500),
  outcomeLabel: text(200),
  category: z.enum(["weather", "sports", "economics", "other"]),
  expiryUtc: utc.nullable(),
  settlementSource: text(500).nullable(),
  termsUrl: z.string().regex(/^https:\/\/\S{1,500}$/).nullable(),
  dataLabel: DataLabelSchema,
  aliases: z.array(z.strictObject({ alias: ident, kind: z.enum(["verity_contract_id", "venue_contract_id", "other"]) })).max(10),
});
export type InstrumentInput = z.infer<typeof InstrumentInputSchema>;

export const QuoteInputSchema = z
  .strictObject({
    instrument: InstrumentKeySchema,
    provider: z.string().regex(/^[a-z0-9][a-z0-9._-]{1,63}$/),
    dataLabel: DataLabelSchema,
    venueTs: utc.nullable(),
    capturedAt: utc.nullable(),
    capturedDate: day.nullable(),
    bestBid: price.nullable(),
    bestAsk: price.nullable(),
    lastTrade: price.nullable(),
    marketState: z.enum(["open", "closed", "settled", "unknown"]),
    /** Set when the provider could not be read. The row then records the attempt, with no prices. */
    unavailableReason: text(300).nullable(),
    provenance: jsonObject,
  })
  .refine((q) => q.capturedAt !== null || q.capturedDate !== null, "a quote needs capturedAt or capturedDate")
  .refine((q) => !q.unavailableReason || (q.bestBid === null && q.bestAsk === null), "an unavailable quote has no prices")
  .refine(
    (q) => q.marketState !== "unknown" || q.unavailableReason !== null || (q.bestBid === null && q.bestAsk === null),
    "market state is unknown: record it as open, closed or settled before storing a price",
  );
export type QuoteInput = z.infer<typeof QuoteInputSchema>;

const SourceKey = z.string().regex(/^[a-z][a-z0-9-]*(:[A-Za-z0-9._-]{1,120}){1,6}$/);
export const SourceInputSchema = z
  .strictObject({
    instrument: InstrumentKeySchema,
    sourceKey: SourceKey,
    kind: z.enum(["rules", "venue_record", "official_data", "evidence", "free_check"]),
    dataLabel: DataLabelSchema,
    mediaType: z.enum(["text/plain", "application/json"]),
    content: z.string().min(1).max(200_000),
    retrievedAt: utc.nullable(),
    retrievedDate: day.nullable(),
    verificationStatus: z.enum(["not_required", "unverified", "verified", "rejected"]),
    verification: jsonObject,
    provenance: jsonObject,
  })
  .refine((s) => s.retrievedAt !== null || s.retrievedDate !== null, "a document needs retrievedAt or retrievedDate")
  .refine((s) => s.kind !== "evidence" || s.verificationStatus !== "not_required", "evidence must say whether it was verified")
  .refine((s) => {
    if (s.mediaType !== "application/json") return true;
    try {
      JSON.parse(s.content);
      return true;
    } catch {
      return false;
    }
  }, "application/json content does not parse");
export type SourceInput = z.infer<typeof SourceInputSchema>;

export const SourceRefSchema = z.strictObject({ sourceKey: SourceKey, contentSha256: hex32 });
export type SourceRef = z.infer<typeof SourceRefSchema>;

const ScoreSchema = z.strictObject({
  score: z.number().int().min(1).max(3).nullable(),
  rationale: text(2000),
  nullReason: text(500).nullable(),
  citationIds: z.array(ident).max(20),
});
const SOURCE_ROLES = ["rules", "venue_record", "official_data", "evidence", "free_check"] as const;

export const AssessmentInputSchema = z.strictObject({
  instrument: InstrumentKeySchema,
  /** assessment key of the version this one revises; null for the original. */
  parentKey: sha256Id.nullable(),
  schemaVersion: text(80),
  rubricVersion: text(80),
  analystId: text(80),
  dataLabel: DataLabelSchema,
  assessedAt: utc,
  /** source identity of the quote snapshot the assessment read. */
  quoteSourceIdentity: sha256Id.nullable(),
  rating: z.strictObject({
    final: z.enum(["Low", "Medium", "High"]).nullable(),
    total: z.number().int().min(4).max(12).nullable(),
    complete: z.boolean(),
    action: text(80),
  }),
  scores: z.strictObject({ ambiguity: ScoreSchema, source: ScoreSchema, liquidity: ScoreSchema, correlation: ScoreSchema }),
  citedClaims: z
    .array(z.strictObject({ category: z.string().regex(/^[a-z_]{1,40}$/), citationId: ident, quote: text(2000), source: SourceRefSchema }))
    .max(50),
  evidenceGap: z
    .strictObject({ id: ident, question: text(500), gapType: ident, material: z.boolean(), freeChecks: z.array(ident).max(10) })
    .nullable(),
  decision: z.enum(["buy", "abstain", "revised", "unchanged", "evidence_rejected"]),
  decisionReason: text(4000),
  trigger: SourceRefSchema.nullable(),
  changes: z
    .array(z.strictObject({ finding: text(80), before: text(200).nullable(), after: text(200).nullable(), changed: z.boolean(), reason: text(1000) }))
    .max(20),
  sources: z.array(SourceRefSchema.extend({ role: z.enum(SOURCE_ROLES) })).max(20),
});
export type AssessmentInput = z.infer<typeof AssessmentInputSchema>;

/** Validates or throws a ResearchInputError naming the first problem. */
export class ResearchInputError extends Error {}
export function parse<T>(schema: z.ZodType<T>, input: unknown, what: string): T {
  const out = schema.safeParse(input);
  if (!out.success) {
    const issue = out.error.issues[0]!;
    throw new ResearchInputError(`${what}: ${issue.path.join(".") || "(root)"}: ${issue.message}`);
  }
  return out.data;
}

export const sha256Hex = (data: string | Uint8Array) => createHash("sha256").update(data).digest("hex");
/** Identity of a record: the hash of its canonical JSON (RFC 8785). */
export const identityOf = (value: unknown) => "sha256:" + sha256Hex(canonicalize(value) ?? "");
/** Hash of a document's UTF-8 bytes, as the database checks it. */
export const contentSha256 = (content: string) => "0x" + sha256Hex(Buffer.from(content, "utf8"));

const units = (p: string) => {
  const [whole, frac = ""] = p.split(".");
  return Number(whole) * 10_000 + Number((frac + "0000").slice(0, 4));
};
/** Mid of two prices in exact decimal arithmetic, rounded half up to four places (as Postgres round()). */
export function exactMid(bid: string, ask: string): string {
  const sum = units(bid) + units(ask);
  return ((sum + (sum % 2)) / 2 / 10_000).toFixed(4);
}

export type StoredQuoteState = "two_sided" | "one_sided_bid" | "one_sided_ask" | "missing" | "crossed" | "closed" | "unavailable";

/**
 * Quote state and implied probability, worked out on the server. A missing,
 * one-sided, crossed, closed or unavailable book has no implied probability.
 */
export function deriveQuote(q: QuoteInput): { quoteState: StoredQuoteState; impliedProbability: string | null; note: string } {
  if (q.unavailableReason) return { quoteState: "unavailable", impliedProbability: null, note: q.unavailableReason };
  const view = classifyQuote({
    bestBid: q.bestBid,
    bestAsk: q.bestAsk,
    lastTradePrice: q.lastTrade,
    observedAtUtc: null,
    now: 0,
    staleAfterSeconds: Number.POSITIVE_INFINITY,
    open: q.marketState === "open" ? true : q.marketState === "unknown" ? undefined : false,
  });
  const state = view.state as StoredQuoteState;
  return { quoteState: state, impliedProbability: state === "two_sided" ? exactMid(q.bestBid!, q.bestAsk!) : null, note: view.note };
}
