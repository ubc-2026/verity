/**
 * The research store suite, run against embedded Postgres (research.test.ts)
 * and, when VERITY_RESEARCH_TEST_PG_URL is set, a real server
 * (research-pg.test.ts). The owner connection applies the migration and plays
 * each role with SET ROLE, so every grant is checked by the database itself.
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { ingestFixtureSlice, type IngestSummary } from "../src/research/ingest.ts";
import { researchRoute } from "../src/research/http.ts";
import { applyMigrations, loadMigrations, migrationStatus, rollbackMigration } from "../src/research/migrate.ts";
import { ResearchInputError, contentSha256 } from "../src/research/model.ts";
import { loadFixtureSlice } from "../src/research/runtime.ts";
import type { SqlDatabase } from "../src/research/sql.ts";
import { ResearchStore } from "../src/research/store.ts";

export const ROOT = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const NOW = Date.parse("2026-11-20T03:00:00Z");
const VISITORS = ["anon", "authenticated", "service_role", "verity_test_visitor"] as const;

type Outcome = { ok: true; rows: Record<string, unknown>[] } | { ok: false; error: string };
async function as(db: SqlDatabase, role: string, sql: string, params: unknown[] = []): Promise<Outcome> {
  try {
    const rows = await db.transaction(async (tx) => {
      await tx.query(`set local role ${role}`);
      return (await tx.query(sql, params)).rows;
    });
    return { ok: true, rows };
  } catch (error) {
    return { ok: false, error: (error as Error).message };
  }
}
const denied = (o: Outcome) => !o.ok && /permission denied|must be owner|append-only/.test(o.error);

export function researchSuite(label: string, open: () => Promise<{ owner: SqlDatabase; close: () => Promise<void> }>, skip: string | false = false) {
  describe(`research store (${label})`, { skip }, () => {
    let owner: SqlDatabase;
    let close: () => Promise<void>;
    let store: ResearchStore;
    let first: IngestSummary;
    const { slice, captures } = loadFixtureSlice(ROOT);
    const count = async (table: string) => Number((await owner.query<{ n: number }>(`select count(*)::int as n from research.${table}`)).rows[0]!.n);

    before(async () => {
      ({ owner, close } = await open());
      // Supabase's API roles and a role with no grants at all (what PUBLIC gets).
      await owner.exec(`do $$ declare r text; begin
        foreach r in array array['anon', 'authenticated', 'service_role', 'verity_test_visitor'] loop
          if not exists (select 1 from pg_roles where rolname = r) then execute format('create role %I nologin', r); end if;
        end loop; end $$;
        create schema if not exists payments;
        create table if not exists payments.ledger (id int primary key, amount numeric not null);`);
      assert.deepEqual(await applyMigrations(owner), ["0001"]);
      store = new ResearchStore({ read: owner, ingest: owner });
      first = await ingestFixtureSlice(store, slice, captures);
    });
    after(async () => close());

    it("applies once, re-runs as a no-op, and refuses drift", async () => {
      assert.deepEqual(await applyMigrations(owner), []);
      await owner.exec(loadMigrations()[0]!.up); // the SQL itself is repeatable
      assert.equal((await migrationStatus(owner))[0]!.state, "applied");
      const changed = loadMigrations().map((m) => ({ ...m, checksum: "sha256:" + "0".repeat(64) }));
      await assert.rejects(applyMigrations(owner, changed), /drift/);
    });

    it("matches the NYC outcome and keeps the workbook snapshot and two captured quotes", async () => {
      assert.deepEqual(first.key, { exchange: "gemini", instrumentId: "WXHIGH-NYC-2611190459", outcomeId: "GEMI-WXHIGH-NYC-2611190459-62TO63" });
      assert.deepEqual(first.quotes, { inserted: 3, duplicate: 0 });
      const d = (await store.instrumentDetail(first.key, NOW))!;
      const h = d.market.history;
      assert.equal(h.length, 3);
      assert.deepEqual(h[0]!.labels, ["FIXTURE", "two_sided", "date_only"]);
      assert.equal(h[0]!.impliedProbability, "0.56");
      for (const q of h.slice(1)) {
        assert.equal(q.dataLabel, "CAPTURED");
        assert.match(q.capturedAt!, /^2026-11-20T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/);
        assert.equal(q.quoteState, "closed");
        assert.equal(q.marketState, "settled");
        assert.equal(q.impliedProbability, null, "no midpoint from a closed book");
        assert.ok(q.labels.includes("stale"));
      }
      assert.notEqual(h[1]!.capturedAt, h[2]!.capturedAt);
      assert.equal(d.market.current.impliedProbability, null);
      assert.equal(d.market.current.freshness, "stale");
      assert.equal(d.market.kind, "exchange_implied_probability");
      assert.equal(d.resolutionRisk.kind, "settlement_risk_rating");
    });

    it("replaying the same input adds nothing", async () => {
      const before = await Promise.all(["quote_snapshots", "source_documents", "assessments", "assessment_sources", "instrument_aliases"].map(count));
      const again = await ingestFixtureSlice(store, slice, captures);
      assert.deepEqual(again.quotes, { inserted: 0, duplicate: 3 });
      assert.equal(again.sources.inserted, 0);
      assert.deepEqual(again.assessments, { inserted: 0, duplicate: 2 });
      assert.deepEqual(await Promise.all(["quote_snapshots", "source_documents", "assessments", "assessment_sources", "instrument_aliases"].map(count)), before);
      // Two captures with the same event record are one venue_record version.
      assert.equal(Number((await owner.query<{ n: number }>("select count(*)::int as n from research.source_documents where kind = 'venue_record'")).rows[0]!.n), 1);
    });

    it("shows the rules, the cited findings, and a before/after traced to verified evidence", async () => {
      const d = (await store.instrumentDetail(first.key, NOW))!;
      const [v1, v2] = d.resolutionRisk.versions;
      assert.equal(v1!.seq, 1);
      assert.equal(v1!.decision, "buy");
      assert.equal(v1!.rubricVersion, "framework-sheet-rev5");
      assert.equal(v2!.parentSeq, 1);
      assert.equal(v2!.decision, "revised");
      for (const v of [v1!, v2!]) for (const c of v.citedClaims as { supported: boolean }[]) assert.equal(c.supported, true);
      const cmp = d.resolutionRisk.comparison!;
      assert.deepEqual([cmp.before.total, cmp.after.total], [8, 7]);
      assert.ok(cmp.changedFindings.some((c: any) => c.finding === "scores.source" && c.before === "2" && c.after === "1"));
      assert.equal(cmp.evidence!.verification, "verified");
      assert.equal(cmp.traceable, true);
      const rules = d.sources.find((s) => s.kind === "rules")!;
      assert.match(String(rules.text), /\[C-NYC-4\]/);
      const evidence = d.sources.find((s) => s.kind === "evidence")!;
      assert.equal(evidence.text, null, "purchased bytes are not published");
      assert.equal(evidence.verification, "verified");
    });

    it("never stores a midpoint for a missing, one-sided, crossed or closed book", async () => {
      const key = first.key;
      const base = { instrument: key, provider: "verity-test", dataLabel: "FIXTURE", venueTs: null, capturedDate: null, lastTrade: null, unavailableReason: null, provenance: { test: true } };
      const cases = [
        [{ bestBid: "0.60", bestAsk: "0.55", marketState: "open" }, "crossed"],
        [{ bestBid: null, bestAsk: "0.03", marketState: "open" }, "one_sided_ask"],
        [{ bestBid: "0.40", bestAsk: null, marketState: "open" }, "one_sided_bid"],
        [{ bestBid: null, bestAsk: null, marketState: "open" }, "missing"],
        [{ bestBid: "0.50", bestAsk: "0.52", marketState: "closed" }, "closed"],
        [{ bestBid: "0.5555", bestAsk: "0.5556", marketState: "open" }, "two_sided"],
      ] as const;
      for (const [i, [book, state]] of cases.entries()) {
        const r = await store.recordQuote({ ...base, capturedAt: `2026-11-21T00:00:0${i}Z`, ...book });
        assert.equal(r.quoteState, state);
        assert.equal(r.impliedProbability, state === "two_sided" ? "0.5556" : null);
      }
      // The database refuses a midpoint the server should never have computed.
      const ref = (await owner.query<{ id: number }>("select id::int as id from research.instruments limit 1")).rows[0]!.id;
      const bad = (state: string, bid: string | null, ask: string | null, implied: string | null) =>
        owner.query(
          `insert into research.quote_snapshots (instrument_ref, source_identity, provider, data_label, captured_at, best_bid, best_ask, market_state, quote_state, implied_probability, provenance)
           values ($1, $2, 'verity-test', 'FIXTURE', now(), $3::text::numeric, $4::text::numeric, 'open', $5, $6::text::numeric, '{}'::jsonb)`,
          [ref, "sha256:" + contentSha256(state + implied).slice(2), bid, ask, state, implied],
        );
      await assert.rejects(bad("crossed", "0.60", "0.55", "0.575"), /check constraint/);
      await assert.rejects(bad("missing", null, null, "0.5"), /check constraint/);
      await assert.rejects(bad("one_sided_ask", null, "0.03", "0.015"), /check constraint/);
      await assert.rejects(bad("two_sided", "0.50", "0.60", "0.57"), /check constraint/);
    });

    it("validates untrusted input before any query", async () => {
      const key = first.key;
      const q = { instrument: key, provider: "verity-test", dataLabel: "FIXTURE", venueTs: null, capturedAt: "2026-11-21T01:00:00Z", capturedDate: null, lastTrade: null, marketState: "open", unavailableReason: null, provenance: {} };
      await assert.rejects(store.recordQuote({ ...q, bestBid: "1.5", bestAsk: "0.6" }), ResearchInputError);
      await assert.rejects(store.recordQuote({ ...q, bestBid: "0.5", bestAsk: "0.6", extra: 1 }), ResearchInputError);
      await assert.rejects(store.recordQuote({ ...q, bestBid: "0.5", bestAsk: "0.6", marketState: "unknown" }), ResearchInputError);
      await assert.rejects(store.recordQuote({ ...q, instrument: { ...key, outcomeId: "x'; drop table research.instruments; --" }, bestBid: "0.5", bestAsk: "0.6" }), ResearchInputError);
      await assert.rejects(store.recordSource({ instrument: key, sourceKey: "test:doc", kind: "evidence", dataLabel: "FIXTURE", mediaType: "text/plain", content: "x", retrievedAt: "2026-11-21T00:00:00Z", retrievedDate: null, verificationStatus: "not_required", verification: {}, provenance: {} }), ResearchInputError);
      assert.equal(await store.instrumentDetail({ exchange: "gemini", instrumentId: "x' or '1'='1", outcomeId: "y" }), null);
      assert.equal(await count("instruments"), 1);
    });

    it("is append-only for every role, the owner included", async () => {
      assert.match(String(await owner.query("update research.quote_snapshots set provider = 'x'").catch((e) => e.message)), /append-only/);
      assert.match(String(await owner.query("delete from research.assessments").catch((e) => e.message)), /append-only/);
      assert.match(String(await owner.query("truncate research.source_documents cascade").catch((e) => e.message)), /append-only/);
      assert.ok(denied(await as(owner, "verity_research_ingest", "update research.instruments set question = 'x'")));
      assert.ok(denied(await as(owner, "verity_research_ingest", "delete from research.quote_snapshots")));
    });

    it("keeps one lineage and refuses a changed finding without verified evidence", async () => {
      const key = { exchange: "gemini", instrumentId: "NBA-TEST-1", outcomeId: "GEMI-NBA-TEST-1-OKC" };
      await store.recordInstrument({ key, question: "Test game: will OKC win?", outcomeLabel: "Oklahoma City", category: "sports", expiryUtc: null, settlementSource: "League governing body", termsUrl: null, dataLabel: "FIXTURE", aliases: [] });
      const rulesText = "[T-1] rules: Pays Yes if the named team wins.\n";
      const rules = { sourceKey: "test:nba-test-1:rules", contentSha256: contentSha256(rulesText) };
      await store.recordSource({ instrument: key, sourceKey: rules.sourceKey, kind: "rules", dataLabel: "FIXTURE", mediaType: "text/plain", content: rulesText, retrievedAt: "2026-11-21T00:00:00Z", retrievedDate: null, verificationStatus: "not_required", verification: {}, provenance: {} });
      const evText = '{"claim":"unverified"}';
      const ev = { sourceKey: "evidence:nba-test-1:GAP-1", contentSha256: contentSha256(evText) };
      await store.recordSource({ instrument: key, sourceKey: ev.sourceKey, kind: "evidence", dataLabel: "FIXTURE", mediaType: "application/json", content: evText, retrievedAt: "2026-11-21T00:00:00Z", retrievedDate: null, verificationStatus: "unverified", verification: {}, provenance: {} });
      const score = (n: number) => ({ score: n, rationale: "test", nullReason: null, citationIds: ["T-1"] });
      const base = {
        instrument: key, schemaVersion: "verity-risk-analysis-v1", rubricVersion: "framework-sheet-rev5", analystId: "test", dataLabel: "FIXTURE",
        assessedAt: "2026-11-21T00:00:00Z", quoteSourceIdentity: null, rating: { final: "Low", total: 4, complete: true, action: "proceed" },
        scores: { ambiguity: score(1), source: score(1), liquidity: score(1), correlation: score(1) },
        citedClaims: [{ category: "ambiguity", citationId: "T-1", quote: "Pays Yes if the named team wins.", source: rules }, { category: "source", citationId: "T-1", quote: "Pays Yes if the league says so.", source: rules }],
        evidenceGap: null, changes: [], sources: [{ ...rules, role: "rules" }],
      };
      const v1 = await store.recordAssessment({ ...base, parentKey: null, decision: "abstain", decisionReason: "no material gap", trigger: null });
      assert.equal(v1.seq, 1);
      const d = (await store.instrumentDetail(key, NOW))!;
      assert.deepEqual((d.resolutionRisk.versions[0]!.citedClaims as { supported: boolean }[]).map((c) => c.supported), [true, false], "an unsupported citation is flagged");
      await assert.rejects(store.recordAssessment({ ...base, assessedAt: "2026-11-21T00:00:01Z", parentKey: null, decision: "abstain", decisionReason: "second original", trigger: null }), /already has an original/);
      const changed = { ...base, parentKey: v1.assessmentKey, trigger: ev, decision: "revised", decisionReason: "x", scores: { ...base.scores, source: score(2) }, rating: { ...base.rating, total: 5 }, changes: [{ finding: "scores.source", before: "1", after: "2", changed: true, reason: "x" }] };
      await assert.rejects(store.recordAssessment(changed), /needs verified evidence/);
      const quiet = await store.recordAssessment({ ...base, parentKey: v1.assessmentKey, trigger: ev, decision: "evidence_rejected", decisionReason: "the evidence was not verified; findings unchanged", sources: [{ ...rules, role: "rules" }, { ...ev, role: "evidence" }] });
      assert.equal(quiet.seq, 2);
      await assert.rejects(store.recordAssessment({ ...base, assessedAt: "2026-11-21T00:00:02Z", parentKey: v1.assessmentKey, trigger: ev, decision: "unchanged", decisionReason: "branch from an old version" }), /latest assessment/);
    });

    it("gives visitors and API roles nothing, the reader only display views, the ingest role no payments", async () => {
      for (const role of VISITORS) {
        for (const sql of ["select * from research.instruments", "select * from research.quote_display", "select * from research.assessment_display", "insert into research.instruments (exchange, instrument_id, outcome_id, question, outcome_label, category, data_label) values ('gemini','A','B','q','o','other','FIXTURE')"]) {
          const out = await as(owner, role, sql);
          assert.ok(denied(out), `${role}: ${sql} -> ${JSON.stringify(out).slice(0, 120)}`);
        }
      }
      const reader = "verity_research_reader";
      for (const t of ["instruments", "quote_snapshots", "source_documents", "assessments", "instrument_aliases", "schema_migrations"]) assert.ok(denied(await as(owner, reader, `select * from research.${t}`)), `reader on ${t}`);
      const view = await as(owner, reader, "select * from research.source_display where kind = 'evidence'");
      assert.ok(view.ok && view.rows.length >= 1 && view.rows.every((r) => r.public_text === null));
      assert.ok(view.ok && !("verification" in view.rows[0]!) && !("provenance" in view.rows[0]!));
      assert.ok(denied(await as(owner, reader, "insert into research.instruments (exchange, instrument_id, outcome_id, question, outcome_label, category, data_label) values ('gemini','A','B','q','o','other','FIXTURE')")));
      const ingest = "verity_research_ingest";
      assert.ok(denied(await as(owner, ingest, "select * from payments.ledger")));
      assert.ok(denied(await as(owner, ingest, "insert into payments.ledger values (1, 1)")));
      assert.ok(denied(await as(owner, ingest, "create table research.extra (id int)")));
      assert.ok(denied(await as(owner, ingest, "select * from research.schema_migrations")));
      assert.ok(denied(await as(owner, reader, "select * from payments.ledger")));
      const grants = await owner.query<{ n: number }>(
        `select count(*)::int as n from information_schema.role_table_grants
          where grantee in ('verity_research_ingest', 'verity_research_reader', 'anon', 'authenticated', 'service_role') and table_schema <> 'research'
            and table_schema not in ('pg_catalog', 'information_schema')`,
      );
      assert.equal(grants.rows[0]!.n, 0, "no research or API role has a grant outside the research schema in this database");
    });

    it("serves a read-only API with display fields only", async () => {
      const k = first.key;
      const list = await researchRoute(store, "GET", "/api/research/instruments", NOW);
      assert.equal(list!.status, 200);
      const detail = await researchRoute(store, "GET", `/api/research/instruments/${k.exchange}/${k.instrumentId}/${k.outcomeId}`, NOW);
      assert.equal(detail!.status, 200);
      const json = JSON.stringify(detail!.body);
      for (const secret of ["provenance", "receipt_digest", "receipt_signer", "request_hash", "purchase-", "tx_hash", "corrections_count", slice.delivery.receiptDigest, slice.delivery.txHash]) {
        assert.ok(!json.includes(secret), `response leaks ${secret}`);
      }
      assert.deepEqual((await researchRoute(store, "GET", "/api/research/aliases/fx-nyc-high-20261118", NOW))!.body, { key: k });
      assert.equal((await researchRoute(store, "POST", "/api/research/instruments", NOW))!.status, 405);
      assert.equal((await researchRoute(store, "DELETE", `/api/research/instruments/${k.exchange}/${k.instrumentId}/${k.outcomeId}`, NOW))!.status, 405);
      assert.equal((await researchRoute(store, "GET", "/api/research/instruments/gemini/x%27%20or%201%3D1/y", NOW))!.status, 400);
      assert.equal((await researchRoute(store, "GET", "/api/research/instruments/gemini/NOPE/NOPE", NOW))!.status, 404);
      assert.equal((await researchRoute(null, "GET", "/api/research/instruments", NOW))!.status, 503);
      assert.equal(await researchRoute(store, "GET", "/api/markets", NOW), null);
    });

    it("a read-only store refuses writes", async () => {
      const ro = new ResearchStore({ read: owner });
      await assert.rejects(ro.recordInstrument({}), /read-only|instrument/);
      await assert.rejects(ro.recordQuote({ instrument: first.key, provider: "verity-test", dataLabel: "FIXTURE", venueTs: null, capturedAt: "2026-11-21T02:00:00Z", capturedDate: null, bestBid: null, bestAsk: null, lastTrade: null, marketState: "open", unavailableReason: null, provenance: {} }), /read-only/);
    });

    it("rolls back and re-applies", async () => {
      await rollbackMigration(owner, "0001");
      const gone = await owner.query<{ n: number }>("select count(*)::int as n from pg_namespace where nspname = 'research'");
      assert.equal(gone.rows[0]!.n, 0);
      const roles = await owner.query<{ n: number }>("select count(*)::int as n from pg_roles where rolname like 'verity_research_%'");
      assert.equal(roles.rows[0]!.n, 0);
      assert.equal(Number((await owner.query<{ n: number }>("select count(*)::int as n from payments.ledger")).rows[0]!.n), 0, "the payments schema is untouched");
      assert.deepEqual(await applyMigrations(owner), ["0001"]);
      const s = await ingestFixtureSlice(new ResearchStore({ read: owner, ingest: owner }), slice, captures);
      assert.deepEqual(s.assessments, { inserted: 2, duplicate: 0 });
    });
  });
}
