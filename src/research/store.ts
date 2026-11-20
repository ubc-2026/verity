/**
 * The research store. It appends research records through the ingest role and
 * reads approved display fields through the reader role.
 *
 * Writes go only through the record* methods. Each validates its input,
 * derives the computed fields, and inserts on the record's identity with
 * ON CONFLICT DO NOTHING, so replayed input adds nothing. Reads select the
 * display views only: the reader role cannot see base tables, provenance,
 * verification details or the bytes of purchased evidence.
 *
 * This module has no path to payments. It imports nothing from src/payments,
 * holds no keys, and its database roles have no grant outside the research
 * schema.
 */
import {
  AssessmentInputSchema,
  InstrumentInputSchema,
  QuoteInputSchema,
  ResearchInputError,
  SourceInputSchema,
  contentSha256,
  deriveQuote,
  identityOf,
  parse,
  type InstrumentKey,
  type SourceRef,
} from "./model.ts";
import { INGEST_ROLE, READER_ROLE, asRole, type Queryable, type SqlDatabase } from "./sql.ts";

const UTC = (col: string) => `to_char(${col} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
const iso = (s: string | null) => (s ? s.replace(".000Z", "Z") : null);
const dec = (s: string | null) => (s === null ? null : s.replace(/0+$/, "").replace(/\.$/, ".0"));
const squash = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();

export const QUOTE_NOTES: Record<string, string> = {
  two_sided: "Mid of the best bid and best ask.",
  one_sided_bid: "Bid only. A one-sided book gives no market-implied price.",
  one_sided_ask: "Ask only. A one-sided book gives no market-implied price.",
  missing: "No bid and no ask. A last trade is not a current price.",
  crossed: "Bid above ask. The quote is inconsistent and is not used.",
  closed: "The contract is not open for trading.",
  unavailable: "The provider could not be read at this time.",
};

async function instrumentRef(tx: Queryable, key: InstrumentKey): Promise<number> {
  const r = await tx.query<{ id: number }>(
    "select id::int as id from research.instruments where exchange = $1 and instrument_id = $2 and outcome_id = $3",
    [key.exchange, key.instrumentId, key.outcomeId],
  );
  if (!r.rows[0]) throw new ResearchInputError(`unknown instrument ${key.exchange}/${key.instrumentId}/${key.outcomeId}`);
  return r.rows[0].id;
}

export interface StoreOptions {
  /** Database for reads (the reader role). */
  read: SqlDatabase;
  /** Database for writes (the ingest role). Leave out for a read-only server. */
  ingest?: SqlDatabase | null;
  /** A quote read longer ago than this is stale and gives no current price. */
  staleAfterSeconds?: number;
}

export class ResearchStore {
  readonly #read: SqlDatabase;
  readonly #ingest: SqlDatabase | null;
  readonly staleAfterSeconds: number;

  constructor(opts: StoreOptions) {
    this.#read = opts.read;
    this.#ingest = opts.ingest ?? null;
    this.staleAfterSeconds = opts.staleAfterSeconds ?? 120;
  }

  get canIngest() {
    return this.#ingest !== null;
  }

  #write<T>(fn: (tx: Queryable) => Promise<T>): Promise<T> {
    if (!this.#ingest) return Promise.reject(new Error("this research store is read-only"));
    return asRole(this.#ingest, INGEST_ROLE, fn);
  }

  // ------------------------------------------------------------------ ingest

  async recordInstrument(raw: unknown): Promise<{ inserted: boolean }> {
    const i = parse(InstrumentInputSchema, raw, "instrument");
    return this.#write(async (tx) => {
      const ins = await tx.query(
        `insert into research.instruments
           (exchange, instrument_id, outcome_id, question, outcome_label, category, expiry_utc, settlement_source, terms_url, data_label)
         values ($1, $2, $3, $4, $5, $6, $7::text::timestamptz, $8, $9, $10)
         on conflict (exchange, instrument_id, outcome_id) do nothing returning id`,
        [i.key.exchange, i.key.instrumentId, i.key.outcomeId, i.question, i.outcomeLabel, i.category, i.expiryUtc, i.settlementSource, i.termsUrl, i.dataLabel],
      );
      const ref = await instrumentRef(tx, i.key);
      for (const a of i.aliases) {
        await tx.query(
          "insert into research.instrument_aliases (alias, instrument_ref, alias_kind) values ($1, $2, $3) on conflict (alias) do nothing",
          [a.alias, ref, a.kind],
        );
        const owner = await tx.query<{ ref: number }>("select instrument_ref::int as ref from research.instrument_aliases where alias = $1", [a.alias]);
        if (owner.rows[0]?.ref !== ref) throw new ResearchInputError(`alias ${a.alias} already names another instrument`);
      }
      return { inserted: ins.rows.length === 1 };
    });
  }

  async recordQuote(raw: unknown) {
    const q = parse(QuoteInputSchema, raw, "quote");
    const derived = deriveQuote(q);
    const sourceIdentity = identityOf({ record: "quote", ...q });
    return this.#write(async (tx) => {
      const ref = await instrumentRef(tx, q.instrument);
      const ins = await tx.query(
        `insert into research.quote_snapshots
           (instrument_ref, source_identity, provider, data_label, venue_ts, captured_at, captured_date,
            best_bid, best_ask, last_trade, market_state, quote_state, implied_probability, provenance)
         values ($1, $2, $3, $4, $5::text::timestamptz, $6::text::timestamptz, $7::text::date,
                 $8::text::numeric, $9::text::numeric, $10::text::numeric, $11, $12, $13::text::numeric, $14::text::jsonb)
         on conflict (source_identity) do nothing returning id`,
        [
          ref, sourceIdentity, q.provider, q.dataLabel, q.venueTs, q.capturedAt, q.capturedDate,
          q.bestBid, q.bestAsk, q.lastTrade, q.marketState, derived.quoteState, derived.impliedProbability, JSON.stringify(q.provenance),
        ],
      );
      return { inserted: ins.rows.length === 1, sourceIdentity, ...derived };
    });
  }

  async recordSource(raw: unknown): Promise<{ inserted: boolean; version: number; contentSha256: string }> {
    const s = parse(SourceInputSchema, raw, "source document");
    const hash = contentSha256(s.content);
    return this.#write(async (tx) => {
      const ref = await instrumentRef(tx, s.instrument);
      const ins = await tx.query<{ version: number }>(
        `insert into research.source_documents
           (instrument_ref, source_key, kind, data_label, media_type, content, content_sha256,
            retrieved_at, retrieved_date, verification_status, verification, provenance)
         values ($1, $2, $3, $4, $5, $6, $7, $8::text::timestamptz, $9::text::date, $10, $11::text::jsonb, $12::text::jsonb)
         on conflict (source_key, content_sha256) do nothing returning version`,
        [
          ref, s.sourceKey, s.kind, s.dataLabel, s.mediaType, s.content, hash,
          s.retrievedAt, s.retrievedDate, s.verificationStatus, JSON.stringify(s.verification), JSON.stringify(s.provenance),
        ],
      );
      if (ins.rows[0]) return { inserted: true, version: ins.rows[0].version, contentSha256: hash };
      const e = (
        await tx.query<{ version: number; kind: string; verification_status: string }>(
          "select version, kind, verification_status from research.source_documents where source_key = $1 and content_sha256 = $2",
          [s.sourceKey, hash],
        )
      ).rows[0]!;
      if (e.kind !== s.kind || e.verification_status !== s.verificationStatus) {
        throw new ResearchInputError(`${s.sourceKey} v${e.version} is stored as ${e.kind}/${e.verification_status}; a replay cannot change that`);
      }
      return { inserted: false, version: e.version, contentSha256: hash };
    });
  }

  async recordAssessment(raw: unknown): Promise<{ inserted: boolean; seq: number; assessmentKey: string }> {
    const a = parse(AssessmentInputSchema, raw, "assessment");
    const assessmentKey = identityOf({ record: "assessment", ...a });
    return this.#write(async (tx) => {
      const ref = await instrumentRef(tx, a.instrument);
      const source = async (r: SourceRef) => {
        const x = await tx.query<{ id: number; version: number; content: string }>(
          "select id::int as id, version, content from research.source_documents where source_key = $1 and content_sha256 = $2 and instrument_ref = $3",
          [r.sourceKey, r.contentSha256, ref],
        );
        if (!x.rows[0]) throw new ResearchInputError(`unknown source ${r.sourceKey} ${r.contentSha256.slice(0, 12)}`);
        return x.rows[0];
      };
      let parentId: number | null = null;
      if (a.parentKey) {
        const p = await tx.query<{ id: number }>("select id::int as id from research.assessments where assessment_key = $1 and instrument_ref = $2", [a.parentKey, ref]);
        if (!p.rows[0]) throw new ResearchInputError("unknown parent assessment");
        parentId = p.rows[0].id;
      }
      let quoteId: number | null = null;
      if (a.quoteSourceIdentity) {
        const q = await tx.query<{ id: number }>("select id::int as id from research.quote_snapshots where source_identity = $1 and instrument_ref = $2", [a.quoteSourceIdentity, ref]);
        if (!q.rows[0]) throw new ResearchInputError("unknown quote snapshot");
        quoteId = q.rows[0].id;
      }
      // Citation support is checked here, against the stored source text.
      const claims = [];
      for (const c of a.citedClaims) {
        const doc = await source(c.source);
        claims.push({
          category: c.category,
          citationId: c.citationId,
          quote: c.quote,
          sourceKey: c.source.sourceKey,
          sourceVersion: doc.version,
          supported: squash(doc.content).includes(squash(c.quote)),
        });
      }
      const trigger = a.trigger ? await source(a.trigger) : null;
      const ins = await tx.query<{ id: number; seq: number }>(
        `insert into research.assessments
           (instrument_ref, assessment_key, parent_id, schema_version, rubric_version, analyst_id, data_label, assessed_at,
            quote_snapshot_id, rating, scores, cited_claims, evidence_gap, decision, decision_reason, trigger_source_id, changes)
         values ($1, $2, $3, $4, $5, $6, $7, $8::text::timestamptz, $9, $10::text::jsonb, $11::text::jsonb, $12::text::jsonb,
                 $13::text::jsonb, $14, $15, $16, $17::text::jsonb)
         on conflict (assessment_key) do nothing returning id::int as id, seq`,
        [
          ref, assessmentKey, parentId, a.schemaVersion, a.rubricVersion, a.analystId, a.dataLabel, a.assessedAt,
          quoteId, JSON.stringify(a.rating), JSON.stringify(a.scores), JSON.stringify(claims),
          a.evidenceGap === null ? null : JSON.stringify(a.evidenceGap), a.decision, a.decisionReason, trigger?.id ?? null, JSON.stringify(a.changes),
        ],
      );
      if (!ins.rows[0]) {
        const old = (await tx.query<{ seq: number }>("select seq from research.assessments where assessment_key = $1", [assessmentKey])).rows[0]!;
        return { inserted: false, seq: old.seq, assessmentKey };
      }
      for (const s of a.sources) {
        const doc = await source(s);
        await tx.query("insert into research.assessment_sources (assessment_id, source_document_id, role) values ($1, $2, $3) on conflict do nothing", [
          ins.rows[0].id,
          doc.id,
          s.role,
        ]);
      }
      return { inserted: true, seq: ins.rows[0].seq, assessmentKey };
    });
  }

  // -------------------------------------------------------------------- read

  async listInstruments() {
    return asRole(this.#read, READER_ROLE, async (tx) => {
      const r = await tx.query<Record<string, string | number>>(
        `select i.exchange, i.instrument_id, i.outcome_id, i.question, i.outcome_label, i.category, i.data_label,
                (select count(*)::int from research.quote_display q
                  where q.exchange = i.exchange and q.instrument_id = i.instrument_id and q.outcome_id = i.outcome_id) as quotes,
                (select count(*)::int from research.assessment_display a
                  where a.exchange = i.exchange and a.instrument_id = i.instrument_id and a.outcome_id = i.outcome_id) as assessments
           from research.instrument_display i
          order by i.category, i.instrument_id, i.outcome_id
          limit 200`,
      );
      return r.rows.map((x) => ({
        key: { exchange: x.exchange, instrumentId: x.instrument_id, outcomeId: x.outcome_id },
        question: x.question,
        outcomeLabel: x.outcome_label,
        category: x.category,
        dataLabel: x.data_label,
        quotes: x.quotes,
        assessments: x.assessments,
      }));
    });
  }

  async findAlias(alias: string): Promise<InstrumentKey | null> {
    if (!/^[A-Za-z0-9._:-]{1,120}$/.test(alias)) return null;
    return asRole(this.#read, READER_ROLE, async (tx) => {
      const r = await tx.query<{ exchange: string; instrument_id: string; outcome_id: string }>(
        "select exchange, instrument_id, outcome_id from research.alias_display where alias = $1",
        [alias],
      );
      const x = r.rows[0];
      return x ? { exchange: x.exchange, instrumentId: x.instrument_id, outcomeId: x.outcome_id } : null;
    });
  }

  /** History and assessment versions for one outcome, display fields only. */
  async instrumentDetail(key: InstrumentKey, nowMs = Date.now()) {
    return asRole(this.#read, READER_ROLE, async (tx) => {
      const k = [key.exchange, key.instrumentId, key.outcomeId];
      const where = "exchange = $1 and instrument_id = $2 and outcome_id = $3";
      const inst = (
        await tx.query<Record<string, string | null>>(
          `select question, outcome_label, category, ${UTC("expiry_utc")} as expiry_utc, settlement_source, terms_url, data_label
             from research.instrument_display where ${where}`,
          k,
        )
      ).rows[0];
      if (!inst) return null;
      const quotes = (
        await tx.query<Record<string, string | null>>(
          `select snapshot_id::int as snapshot_id, provider, data_label, ${UTC("venue_ts")} as venue_ts, ${UTC("captured_at")} as captured_at,
                  captured_date::text as captured_date, best_bid::text as best_bid, best_ask::text as best_ask, last_trade::text as last_trade,
                  market_state, quote_state, implied_probability::text as implied_probability
             from research.quote_display where ${where}
            order by coalesce(captured_at, captured_date::timestamp at time zone 'UTC'), snapshot_id`,
          k,
        )
      ).rows;
      const sources = (
        await tx.query<Record<string, string | number | null>>(
          `select source_id::int as source_id, source_key, version, kind, data_label, content_sha256, ${UTC("retrieved_at")} as retrieved_at,
                  retrieved_date::text as retrieved_date, verification_status, public_text
             from research.source_display where ${where} order by source_key, version`,
          k,
        )
      ).rows;
      const versions = (
        await tx.query<Record<string, any>>(
          `select seq, parent_seq, schema_version, rubric_version, analyst_id, data_label, ${UTC("assessed_at")} as assessed_at,
                  quote_snapshot_id::int as quote_snapshot_id, rating, scores, cited_claims, evidence_gap, decision, decision_reason, changes,
                  trigger_source_key, trigger_source_version, trigger_kind, trigger_verification, trigger_content_sha256, source_versions
             from research.assessment_display where ${where} order by seq`,
          k,
        )
      ).rows;

      const history = quotes.map((q) => {
        const capturedAt = iso(q.captured_at ?? null);
        const ageSeconds = capturedAt ? Math.max(0, Math.round((nowMs - Date.parse(capturedAt)) / 1000)) : null;
        const stale = ageSeconds !== null && ageSeconds > this.staleAfterSeconds;
        return {
          snapshotId: Number(q.snapshot_id),
          provider: q.provider,
          dataLabel: q.data_label,
          capturedAt,
          capturedDate: q.captured_date,
          venueTs: iso(q.venue_ts ?? null),
          bestBid: dec(q.best_bid ?? null),
          bestAsk: dec(q.best_ask ?? null),
          lastTrade: dec(q.last_trade ?? null),
          marketState: q.market_state,
          quoteState: q.quote_state,
          impliedProbability: dec(q.implied_probability ?? null),
          ageSeconds,
          stale,
          labels: [q.data_label, q.quote_state, ...(capturedAt ? [] : ["date_only"]), ...(stale ? ["stale"] : [])],
          note: QUOTE_NOTES[q.quote_state ?? ""] ?? "",
        };
      });
      const last = history.at(-1);
      let current;
      if (!last || last.quoteState === "unavailable") {
        current = { freshness: "unavailable", quoteState: last?.quoteState ?? null, impliedProbability: null, asOf: last?.capturedAt ?? null, note: last ? QUOTE_NOTES.unavailable : "No quote has been recorded." };
      } else if (!last.capturedAt || last.stale) {
        current = {
          freshness: last.capturedAt ? "stale" : "date_only",
          quoteState: last.quoteState,
          impliedProbability: null,
          asOf: last.capturedAt ?? last.capturedDate,
          note: `The latest reading is from ${last.capturedAt ?? last.capturedDate}. It is history, not a current price.`,
        };
      } else {
        current = { freshness: "current", quoteState: last.quoteState, impliedProbability: last.impliedProbability, asOf: last.capturedAt, note: last.note };
      }

      const shaped = versions.map((v) => ({
        seq: v.seq as number,
        parentSeq: (v.parent_seq as number | null) ?? null,
        assessedAt: iso(v.assessed_at),
        dataLabel: v.data_label,
        schemaVersion: v.schema_version,
        rubricVersion: v.rubric_version,
        analystId: v.analyst_id,
        quoteSnapshotId: v.quote_snapshot_id,
        rating: v.rating,
        scores: v.scores,
        citedClaims: v.cited_claims,
        evidenceGap: v.evidence_gap,
        decision: v.decision,
        decisionReason: v.decision_reason,
        changes: v.changes,
        trigger: v.trigger_source_key
          ? { sourceKey: v.trigger_source_key, version: v.trigger_source_version, kind: v.trigger_kind, verification: v.trigger_verification, contentSha256: v.trigger_content_sha256 }
          : null,
        sourceVersions: v.source_versions,
      }));
      const first = shaped[0];
      const latest = shaped.at(-1);
      const comparison =
        first && latest && latest !== first
          ? {
              before: { seq: first.seq, final: first.rating.final, total: first.rating.total },
              after: { seq: latest.seq, final: latest.rating.final, total: latest.rating.total },
              changedFindings: (latest.changes as { changed: boolean }[]).filter((c) => c.changed),
              evidence: latest.trigger,
              traceable: (latest.changes as { changed: boolean }[]).every((c) => !c.changed) || latest.trigger?.verification === "verified",
            }
          : null;

      return {
        instrument: {
          key,
          question: inst.question,
          outcomeLabel: inst.outcome_label,
          category: inst.category,
          expiryUtc: iso(inst.expiry_utc ?? null),
          settlementSource: inst.settlement_source,
          termsUrl: inst.terms_url,
          dataLabel: inst.data_label,
        },
        market: {
          kind: "exchange_implied_probability",
          note: "What the order book implied when it was read. It is not Verity's rating and does not change it.",
          staleAfterSeconds: this.staleAfterSeconds,
          current,
          history,
        },
        resolutionRisk: {
          kind: "settlement_risk_rating",
          note: "How the contract could settle in an unexpected way, from the rules and the evidence. It is not a price forecast.",
          latest: latest ?? null,
          versions: shaped,
          comparison,
        },
        sources: sources.map((s) => ({
          sourceKey: s.source_key,
          version: s.version,
          kind: s.kind,
          dataLabel: s.data_label,
          retrievedAt: iso((s.retrieved_at as string | null) ?? null),
          retrievedDate: s.retrieved_date,
          contentSha256: s.content_sha256,
          verification: s.verification_status,
          text: s.public_text,
          ...(s.kind === "evidence" ? { textNote: "Purchased evidence is not published. Its hash and verification state are." } : {}),
        })),
      };
    });
  }
}
