/**
 * Turns captured and recorded inputs into research records: the trusted
 * server-side ingestion path. Nothing here reads a request from a visitor.
 *
 * - quoteFromCapture / quoteFromFixture: one quote snapshot per observation.
 * - assessmentFromRisk: one assessment version from a verity-risk-analysis-v1.
 * - ingestFixtureSlice: the NYC weather vertical slice (fixture run + captures).
 */
import canonicalize from "canonicalize";
import type { EventCapture } from "./capture.ts";
import { GEMINI_PROVIDER } from "./capture.ts";
import { matchOutcome } from "./instruments.ts";
import { contentSha256, type AssessmentInput, type InstrumentKey, type QuoteInput, type SourceRef } from "./model.ts";
import type { ResearchStore } from "./store.ts";

/** The workbook rubric the analysis applies (workbook-2026-11-17, Framework sheet, revision 5). */
export const RUBRIC_VERSION = "framework-sheet-rev5";
export const FIXTURE_PROVIDER = "verity-fixture-workbook";

export function categoryOf(ticker: string, venueCategory?: string | null): "weather" | "sports" | "economics" | "other" {
  const c = (venueCategory ?? "").toLowerCase();
  if (/^WX/.test(ticker) || c === "weather") return "weather";
  if (/^(NBA|NFL|NHL|MLB|NCAA|CFB|CBB|MLS|EPL|UFC)/.test(ticker) || c === "sports") return "sports";
  if (/^(FED|CPI|GDP|NFP)/.test(ticker) || c === "economics") return "economics";
  return "other";
}

const price = (v: string | null) => (v === null ? null : String(v));

/** One quote snapshot from a public API capture. A failed read becomes an unavailable row. */
export function quoteFromCapture(capture: EventCapture, key: InstrumentKey): QuoteInput {
  const base = {
    instrument: key,
    provider: GEMINI_PROVIDER,
    dataLabel: "CAPTURED" as const,
    venueTs: null, // the events API does not timestamp its quotes
    capturedAt: capture.fetchedAtUtc,
    capturedDate: null,
    lastTrade: null,
  };
  const contract = capture.event?.contracts.find((c) => c.instrumentSymbol === key.outcomeId);
  const provenance = {
    url: capture.url,
    http_status: capture.httpStatus,
    response_sha256: capture.responseSha256,
    venue_contract_id: contract?.id ?? null,
    venue_status: contract?.status ?? null,
    venue_market_state: contract?.marketState ?? null,
    resolution_side: contract?.resolutionSide ?? null,
  };
  if (capture.unavailableReason || !capture.event || !contract) {
    return {
      ...base,
      bestBid: null,
      bestAsk: null,
      marketState: "unknown",
      unavailableReason: capture.unavailableReason ?? "the outcome is not in the response",
      provenance,
    };
  }
  const status = contract.status ?? capture.event.status;
  const marketState =
    status === "settled" ? "settled" : status === "active" && (contract.marketState ?? "open") === "open" ? "open" : status ? "closed" : "unknown";
  return {
    ...base,
    bestBid: price(contract.prices.bestBid),
    bestAsk: price(contract.prices.bestAsk),
    lastTrade: price(contract.prices.lastTradePrice),
    marketState,
    unavailableReason: null,
    provenance,
  };
}

export interface SliceMarket {
  question: string;
  outcomeLabel: string;
  eventTicker: string;
  expiryUtc: string | null;
  settlementSource: string | null;
  termsUrl: string | null;
  workbookRow: number;
  source: { mode: string; label: string; url: string; snapshot_date: string; snapshot_time_utc: string | null };
  quote: { bestBid: string | null; bestAsk: string | null; volumeUsd: string | null; volumeBasis: string | null };
  rulesExcerpts: { id: string; field_or_rule: string; quote: string }[];
}

/** The workbook snapshot. It recorded a date, not a time. */
export function quoteFromFixture(market: SliceMarket, key: InstrumentKey, fixtureSet: string): QuoteInput {
  return {
    instrument: key,
    provider: FIXTURE_PROVIDER,
    dataLabel: "FIXTURE",
    venueTs: null,
    capturedAt: market.source.snapshot_time_utc,
    capturedDate: market.source.snapshot_time_utc ? null : market.source.snapshot_date,
    bestBid: market.quote.bestBid,
    bestAsk: market.quote.bestAsk,
    lastTrade: null,
    marketState: "open",
    unavailableReason: null,
    provenance: { fixture_set: fixtureSet, workbook_row: market.workbookRow, source_label: market.source.label, source_url: market.source.url },
  };
}

export function rulesText(excerpts: SliceMarket["rulesExcerpts"]): string {
  return excerpts.map((e) => `[${e.id}] ${e.field_or_rule}: ${e.quote}`).join("\n") + "\n";
}

interface RiskLike {
  version?: string;
  analyzed_at_utc: string;
  scores: Record<"ambiguity" | "source" | "liquidity" | "correlation", { score: number | null; rationale: string; null_reason: string | null; citation_ids: string[] }>;
  rating: { final_rating: string | null; raw_total: number | null; complete: boolean };
  research_action: string;
  citations: { id: string; quote: string }[];
  evidence_gaps: { id: string; question: string; gap_type: string; material: boolean; free_checks: string[] }[];
}

/** One assessment version from a risk analysis. Citations resolve to the rules document, or to the evidence for evidence IDs. */
export function assessmentFromRisk(
  ra: RiskLike,
  o: {
    key: InstrumentKey;
    analystId: string;
    dataLabel: AssessmentInput["dataLabel"];
    assessedAt: string;
    quoteSourceIdentity: string | null;
    rules: SourceRef;
    evidence?: { ref: SourceRef; citationIds: string[] } | null;
    parentKey: string | null;
    gapId: string | null;
    decision: AssessmentInput["decision"];
    decisionReason: string;
    changes?: AssessmentInput["changes"];
  },
): AssessmentInput {
  const cats = ["ambiguity", "source", "liquidity", "correlation"] as const;
  const byId = new Map(ra.citations.map((c) => [c.id, c]));
  const claims: AssessmentInput["citedClaims"] = [];
  for (const cat of cats) {
    for (const id of ra.scores[cat].citation_ids) {
      const c = byId.get(id);
      if (!c) continue;
      claims.push({ category: cat, citationId: id, quote: c.quote, source: o.evidence?.citationIds.includes(id) ? o.evidence.ref : o.rules });
    }
  }
  const gap = o.gapId ? ra.evidence_gaps.find((g) => g.id === o.gapId) ?? null : null;
  const score = (s: RiskLike["scores"]["source"]) => ({ score: s.score, rationale: s.rationale, nullReason: s.null_reason, citationIds: s.citation_ids });
  return {
    instrument: o.key,
    parentKey: o.parentKey,
    schemaVersion: ra.version ?? "verity-risk-analysis-v1",
    rubricVersion: RUBRIC_VERSION,
    analystId: o.analystId,
    dataLabel: o.dataLabel,
    assessedAt: o.assessedAt,
    quoteSourceIdentity: o.quoteSourceIdentity,
    rating: {
      final: (ra.rating.final_rating as "Low" | "Medium" | "High" | null) ?? null,
      total: ra.rating.raw_total,
      complete: ra.rating.complete,
      action: ra.research_action,
    },
    scores: { ambiguity: score(ra.scores.ambiguity), source: score(ra.scores.source), liquidity: score(ra.scores.liquidity), correlation: score(ra.scores.correlation) },
    citedClaims: claims,
    evidenceGap: gap ? { id: gap.id, question: gap.question, gapType: gap.gap_type, material: gap.material, freeChecks: gap.free_checks } : null,
    decision: o.decision,
    decisionReason: o.decisionReason,
    trigger: o.evidence?.ref ?? null,
    changes: o.changes ?? [],
    sources: [{ ...o.rules, role: "rules" as const }, ...(o.evidence ? [{ ...o.evidence.ref, role: "evidence" as const }] : [])],
  };
}

export interface FixtureSlice {
  label: "FIXTURE";
  fixtureSet: string;
  contractId: string;
  market: SliceMarket;
  analysis: { risk_analysis: RiskLike; purchase_proposal: { evidence_gap_id: string; rationale: string } | null; no_purchase_reason: string | null };
  delivery: {
    verifiedAtUtc: string;
    verifiedBy: string;
    purchaseId: string;
    merchantId: string;
    receiptSigner: string;
    requestHash: string;
    contentHashKeccak256: string;
    txHash: string;
    receiptDigest: string;
    contentSha256: string;
    bodyUtf8: string;
  };
  reassessment: {
    status: "revised" | "unchanged" | "evidence_rejected";
    reason: string;
    revised: RiskLike;
    changes: { finding: string; before: string | null; after: string | null; changed: boolean; reason: string }[];
    evidence_citation: { id: string } | null;
  };
  reassessedAtUtc: string;
}

export interface IngestSummary {
  key: InstrumentKey;
  instrument: boolean;
  quotes: { inserted: number; duplicate: number };
  sources: { inserted: number; duplicate: number };
  assessments: { inserted: number; duplicate: number };
}

/**
 * Ingests the NYC weather slice: the instrument (matched against a capture),
 * the workbook quote and each captured quote, the rules, venue record and
 * verified evidence documents, and the original and revised assessments.
 * Running it again with the same files adds nothing.
 */
export async function ingestFixtureSlice(store: ResearchStore, slice: FixtureSlice, captures: EventCapture[]): Promise<IngestSummary> {
  const withEvent = captures.find((c) => c.event);
  if (!withEvent?.event) throw new Error("the slice needs one capture of the event to match the instrument");
  const match = matchOutcome({ exchange: "gemini", eventTicker: slice.market.eventTicker, outcomeLabel: slice.market.outcomeLabel }, withEvent.event);
  if (!match.ok) throw new Error(`instrument match failed: ${match.reason}: ${match.detail}`);
  const key = match.key;
  const tally = { inserted: 0, duplicate: 0 };
  const count = (t: typeof tally, inserted: boolean) => (inserted ? t.inserted++ : t.duplicate++);
  const summary: IngestSummary = { key, instrument: false, quotes: { ...tally }, sources: { ...tally }, assessments: { ...tally } };

  summary.instrument = (
    await store.recordInstrument({
      key,
      question: slice.market.question,
      outcomeLabel: slice.market.outcomeLabel,
      category: categoryOf(slice.market.eventTicker, withEvent.event.category),
      expiryUtc: slice.market.expiryUtc,
      settlementSource: slice.market.settlementSource,
      termsUrl: slice.market.termsUrl,
      dataLabel: "FIXTURE",
      aliases: [
        { alias: slice.contractId, kind: "verity_contract_id" },
        ...(match.venueContractId ? [{ alias: match.venueContractId, kind: "venue_contract_id" as const }] : []),
      ],
    })
  ).inserted;

  const fixtureQuote = quoteFromFixture(slice.market, key, slice.fixtureSet);
  const fq = await store.recordQuote(fixtureQuote);
  count(summary.quotes, fq.inserted);
  for (const capture of captures) count(summary.quotes, (await store.recordQuote(quoteFromCapture(capture, key))).inserted);

  const rules = rulesText(slice.market.rulesExcerpts);
  const rulesRef = { sourceKey: `fixture:${slice.fixtureSet}:${slice.contractId}:rules`, contentSha256: contentSha256(rules) };
  count(
    summary.sources,
    (
      await store.recordSource({
        instrument: key,
        sourceKey: rulesRef.sourceKey,
        kind: "rules",
        dataLabel: "FIXTURE",
        mediaType: "text/plain",
        content: rules,
        retrievedAt: slice.market.source.snapshot_time_utc,
        retrievedDate: slice.market.source.snapshot_time_utc ? null : slice.market.source.snapshot_date,
        verificationStatus: "not_required",
        verification: {},
        provenance: { fixture_set: slice.fixtureSet, workbook_row: slice.market.workbookRow, note: "Rule text paraphrases the Gemini API description fields as captured in the workbook." },
      })
    ).inserted,
  );
  for (const capture of captures) {
    if (!capture.event) continue;
    count(
      summary.sources,
      (
        await store.recordSource({
          instrument: key,
          sourceKey: `gemini:event:${capture.event.ticker}:record`,
          kind: "venue_record",
          dataLabel: "CAPTURED",
          mediaType: "application/json",
          content: canonicalize(capture.event)!,
          retrievedAt: capture.fetchedAtUtc,
          retrievedDate: null,
          verificationStatus: "not_required",
          verification: {},
          provenance: { url: capture.url, http_status: capture.httpStatus, response_sha256: capture.responseSha256 },
        })
      ).inserted,
    );
  }

  const d = slice.delivery;
  if (contentSha256(d.bodyUtf8) !== d.contentSha256) throw new Error("the recorded evidence bytes do not match the verified hash");
  // One logical document per gap; each purchased copy with new bytes is a new version.
  // The purchase ID stays in the private verification record, not in the key.
  const gapId = slice.analysis.purchase_proposal?.evidence_gap_id ?? "unscoped";
  const evidenceRef = { sourceKey: `evidence:${slice.contractId}:${gapId}`, contentSha256: d.contentSha256 };
  count(
    summary.sources,
    (
      await store.recordSource({
        instrument: key,
        sourceKey: evidenceRef.sourceKey,
        kind: "evidence",
        dataLabel: "FIXTURE",
        mediaType: "application/json",
        content: d.bodyUtf8,
        retrievedAt: d.verifiedAtUtc,
        retrievedDate: null,
        verificationStatus: "verified",
        verification: {
          verified_by: d.verifiedBy,
          purchase_id: d.purchaseId,
          merchant_id: d.merchantId,
          receipt_signer: d.receiptSigner,
          receipt_digest: d.receiptDigest,
          request_hash: d.requestHash,
          content_hash_keccak256: d.contentHashKeccak256,
          tx_hash: d.txHash,
        },
        provenance: { label: "FIXTURE", note: "Fixture merchant delivery; nothing was paid or sent on chain." },
      })
    ).inserted,
  );

  const ra = slice.analysis.risk_analysis;
  const proposal = slice.analysis.purchase_proposal;
  const original = assessmentFromRisk(ra, {
    key,
    analystId: "verity-workbook-analyst",
    dataLabel: "FIXTURE",
    assessedAt: ra.analyzed_at_utc,
    quoteSourceIdentity: fq.sourceIdentity,
    rules: rulesRef,
    parentKey: null,
    gapId: proposal?.evidence_gap_id ?? null,
    decision: proposal ? "buy" : "abstain",
    decisionReason: proposal?.rationale ?? slice.analysis.no_purchase_reason ?? "no proposal",
  });
  const o = await store.recordAssessment(original);
  count(summary.assessments, o.inserted);

  const r = slice.reassessment;
  const revised = assessmentFromRisk(r.revised, {
    key,
    analystId: "verity-reassess",
    dataLabel: "FIXTURE",
    assessedAt: slice.reassessedAtUtc,
    quoteSourceIdentity: fq.sourceIdentity,
    rules: rulesRef,
    evidence: { ref: evidenceRef, citationIds: r.evidence_citation ? [r.evidence_citation.id] : [] },
    parentKey: o.assessmentKey,
    gapId: proposal?.evidence_gap_id ?? null,
    decision: r.status,
    decisionReason: r.reason,
    changes: r.changes,
  });
  // The revised analysis closed the gap, so take its description from the original.
  revised.evidenceGap = original.evidenceGap;
  count(summary.assessments, (await store.recordAssessment(revised)).inserted);
  return summary;
}

