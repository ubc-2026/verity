/**
 * Runs the research evaluation set (eval/research/v1/cases.json) and writes
 * eval/research/v1/results.json and report.md.
 *
 *   node scripts/research-eval.ts            fixture and captured checks (needs Python: VERITY_PYTHON)
 *   node scripts/research-eval.ts --live     adds LIVE checks: one public Gemini Exchange read, no key
 *   node scripts/research-eval.ts --strict   exits 1 when any check fails
 *   node scripts/research-eval.ts --out DIR  writes results.json and report.md to DIR instead
 *
 * This is a research evaluation of how Verity reads markets. It says nothing
 * about forecasting performance; that needs a separate backtest.
 */
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { findPython } from "../src/app/analyst.ts";
import { classifyQuote } from "../src/app/markets.ts";
import { captureEvent, trimEvent, type EventCapture } from "../src/research/capture.ts";
import { rulesText, type FixtureSlice } from "../src/research/ingest.ts";
import { matchOutcome, type VenueEvent } from "../src/research/instruments.ts";
import { applyMigrations } from "../src/research/migrate.ts";
import { contentSha256, deriveQuote } from "../src/research/model.ts";
import { openPglite } from "../src/research/sql.ts";
import { ResearchStore } from "../src/research/store.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const evalDir = join(root, "eval", "research", "v1");
const live = process.argv.includes("--live");
const strict = process.argv.includes("--strict");
const outAt = process.argv.indexOf("--out");
const outDir = outAt > 0 && process.argv[outAt + 1] ? resolve(process.argv[outAt + 1]!) : evalDir;
type Json = Record<string, any>;

const dataset = JSON.parse(readFileSync(join(evalDir, "cases.json"), "utf8")) as Json;
const fixture = JSON.parse(readFileSync(join(root, "analysis", "fixtures", "markets_2026-11-17.json"), "utf8")) as { markets: Json[] };
const slice = JSON.parse(readFileSync(join(root, "samples", "research", "nyc-weather-slice.json"), "utf8")) as FixtureSlice & Json;
const read = (p: string) => JSON.parse(readFileSync(join(root, p), "utf8")) as Json;

function record(cfg: Json): Json {
  const id = String(cfg.base).replace(/^fixture:/, "");
  const base = fixture.markets.find((m) => m.contract_id === id);
  if (!base) throw new Error(`unknown base ${cfg.base}`);
  const r = structuredClone(base);
  Object.assign(r, cfg.patch ?? {});
  Object.assign(r.market, cfg.patch_market ?? {});
  if (cfg.keep_excerpts) r.rules_excerpts = r.rules_excerpts.filter((e: Json) => cfg.keep_excerpts.includes(e.id));
  for (const [eid, quote] of Object.entries(cfg.edit_excerpts ?? {})) {
    const e = r.rules_excerpts.find((x: Json) => x.id === eid);
    if (!e) throw new Error(`no excerpt ${eid}`);
    e.quote = quote;
  }
  return r;
}
function venue(ref: string): VenueEvent {
  if (ref.startsWith("capture:")) return (read(ref.slice(8)) as EventCapture).event!;
  if (ref.startsWith("raw:")) return trimEvent(read(ref.slice(4)));
  throw new Error(`unknown venue ${ref}`);
}
function evidence(cfg: Json, contractId: string) {
  const d = slice.delivery;
  const body = cfg.tamper ? d.bodyUtf8.replace("first_full_day_cli", "first_partial_day_cli") : d.bodyUtf8;
  return {
    body_utf8: body,
    provenance: {
      purchase_id: d.purchaseId,
      contract_id: cfg.contract_override ?? contractId,
      evidence_gap_id: "$PROPOSAL_GAP",
      catalog_item_id: (slice.analysis.purchase_proposal as Json).catalog_item_id,
      merchant_id: d.merchantId,
      request_hash: d.requestHash,
      content_hash_keccak256: d.contentHashKeccak256,
      content_sha256: d.contentSha256,
      receipt_digest: d.receiptDigest,
      receipt_signer: d.receiptSigner,
      tx_hash: d.txHash,
      verified_by: "verifyDelivery",
      data_label: "FIXTURE",
    },
  };
}

// ---------------------------------------------------------------- Python scoring
const jobs: Json[] = [];
for (const c of dataset.cases as Json[]) {
  const a = c.checks.analysis;
  const t = c.checks.trace;
  if (!a && !t) continue;
  const cfg = a ?? t;
  const r = record({ ...cfg, base: t?.base ?? a?.base });
  jobs.push({ id: c.id, record: r, analyst: "code", free_check_scenario: a?.free_check_scenario ?? null, ...(t ? { evidence: evidence(t, r.contract_id) } : {}) });
}
const python = findPython(join(root, "analysis"));
const py = spawnSync(python, [join(root, "eval", "research", "run_analysis.py")], { input: JSON.stringify(jobs), encoding: "utf8", timeout: 180_000, maxBuffer: 64 * 1024 * 1024 });
if (py.status !== 0) throw new Error(`analysis scorer failed: ${py.stderr.slice(0, 2000)}`);
const scored = new Map((JSON.parse(py.stdout) as Json[]).map((x) => [x.id, x]));

// ---------------------------------------------------------------- checks
interface Result { caseId: string; category: string; tags: string[]; check: string; data: string; pass: boolean; expected: unknown; got: unknown; detail: string }
const results: Result[] = [];
const add = (c: Json, check: string, data: string, pass: boolean, expected: unknown, got: unknown, detail = "") =>
  results.push({ caseId: c.id, category: c.category, tags: c.tags, check, data, pass, expected, got, detail });
const CATS = ["ambiguity", "source", "liquidity", "correlation"] as const;
const rubricCells: { caseId: string; category: string; dim: string; expected: number | null; got: number | null }[] = [];

const db = await openPglite();
await applyMigrations(db);
const store = new ResearchStore({ read: db, ingest: db });

for (const c of dataset.cases as Json[]) {
  for (const [name, cfg] of Object.entries(c.checks as Json)) {
    if (name.startsWith("instrument")) {
      const m = matchOutcome(cfg.query, venue(cfg.venue));
      const got = m.ok ? { outcomeId: m.key.outcomeId } : { fail: m.reason };
      const pass = cfg.expect.outcomeId ? m.ok && m.key.outcomeId === cfg.expect.outcomeId : !m.ok && m.reason === cfg.expect.fail;
      add(c, "instrument_matching", cfg.data, pass, cfg.expect, got, m.ok ? "" : m.detail);
    } else if (name === "quote") {
      const i = cfg.input;
      const view = classifyQuote({ bestBid: i.bestBid, bestAsk: i.bestAsk, observedAtUtc: i.observedAtUtc, observedDate: i.observedDate, now: Date.parse(i.now) / 1000, staleAfterSeconds: i.staleAfterSeconds ?? 120, open: i.open });
      let stored: { quoteState: string; impliedProbability: string | null } | null = null;
      if (cfg.expect.state !== "stale") {
        const q = deriveQuote({ instrument: { exchange: "gemini", instrumentId: "X", outcomeId: "Y" }, provider: "eval", dataLabel: "FIXTURE", venueTs: null, capturedAt: null, capturedDate: "2026-11-17", bestBid: i.bestBid, bestAsk: i.bestAsk, lastTrade: null, marketState: i.open ? "open" : "closed", unavailableReason: null, provenance: {} });
        stored = { quoteState: q.quoteState, impliedProbability: q.impliedProbability === null ? null : q.impliedProbability.replace(/0+$/, "").replace(/\.$/, ".0") };
      }
      const pass = view.state === cfg.expect.state && view.impliedProbability === cfg.expect.implied && (!stored || (stored.quoteState === cfg.expect.state && stored.impliedProbability === cfg.expect.implied));
      add(c, "quote_correctness", cfg.data, pass, cfg.expect, { state: view.state, implied: view.impliedProbability, stored }, view.note);
    }
  }
  const s = scored.get(c.id);
  const a = c.checks.analysis;
  if (a) {
    if (!s || s.error) {
      add(c, "analysis", a.data, false, "a scored analysis", s?.error ?? "missing", "the scorer crashed");
      continue;
    }
    // Citation support: every cited ID exists, a score of 2 or 3 cites something, and a cited
    // excerpt has text. An excerpt that records an empty field ("(empty)" for a named field)
    // supports only a rationale that claims the absence.
    const byId = new Map((s.citations as Json[]).map((x) => [x.id, x as { quote: string; field_or_rule: string }]));
    const issues: string[] = [];
    for (const cat of CATS) {
      const score = s.scores[cat];
      if (score === null) continue;
      const ids = s.score_citations[cat] as string[];
      if (score >= 2 && ids.length === 0) issues.push(`${cat}=${score} cites nothing`);
      for (const id of ids) {
        const x = byId.get(id);
        if (x === undefined) {
          issues.push(`${cat} cites unknown ${id}`);
          continue;
        }
        const empty = !x.quote.trim() || /^\(empty\)$/i.test(x.quote.trim());
        const documentsAbsence = /^[A-Za-z0-9_.\[\]]+$/.test(x.field_or_rule) && /empty|missing|not (read|published|captured|stated)/i.test(s.rationales[cat] ?? "");
        if (empty && !documentsAbsence) issues.push(`${cat} cites ${id}, which is empty, for a claim that is not about an absence`);
      }
    }
    add(c, "citation_support", a.data, issues.length === 0, "every cited excerpt exists and has text", issues.length ? issues : "ok", issues.join("; "));
    if (a.rubric) {
      const diffs = CATS.filter((k) => a.rubric[k] !== s.scores[k]);
      for (const k of CATS) rubricCells.push({ caseId: c.id, category: c.category, dim: k, expected: a.rubric[k], got: s.scores[k] });
      add(c, "rubric_agreement", a.data, diffs.length === 0, a.rubric, s.scores, diffs.map((k) => `${k}: expected ${a.rubric[k]}, got ${s.scores[k]}${s.null_reasons[k] ? ` (${s.null_reasons[k]})` : ""}`).join("; "));
    }
    if (a.decision) {
      const gapOk = !a.gap_type || (s.gaps as Json[]).find((g) => g.id === s.proposal?.gap_id)?.gap_type === a.gap_type;
      add(c, "abstention", a.data, s.decision === a.decision && gapOk, { decision: a.decision, gap_type: a.gap_type ?? null }, { decision: s.decision, proposal: s.proposal }, (s.decision_log as string[]).at(-1) ?? "");
    }
    if (a.quote_expect) {
      const qp = s.quoted_price ?? {};
      const pass = (a.quote_expect.implied === undefined || qp.implied_probability === a.quote_expect.implied) && (a.quote_expect.mid === undefined || qp.mid === a.quote_expect.mid);
      add(c, "quote_correctness", a.data, pass, { analysis_quoted_price: a.quote_expect }, { mid: qp.mid ?? null, implied: qp.implied_probability ?? null }, "analysis/verity/analysis.py _quoted_price");
    }
  }
  const t = c.checks.trace;
  if (t) {
    const r = s?.reassessment;
    if (!r) {
      add(c, "risk_change_traceability", t.data, false, t.expect, s?.error ?? "no reassessment", "the scorer did not reassess");
      continue;
    }
    const changed = (r.changes as Json[]).some((x) => x.changed);
    const findingOk = !t.expect.changed_finding || (r.changes as Json[]).some((x) => x.changed && x.finding === t.expect.changed_finding);
    const citedOk = !changed || (r.evidence_citation && Object.values(r.revised_score_citations as Record<string, string[]>).some((ids) => ids.includes(r.evidence_citation.id)));
    // The database must accept this lineage only when a change rests on verified evidence.
    const key = { exchange: "gemini", instrumentId: String(record({ base: t.base ?? c.checks.analysis.base }).event_ticker), outcomeId: `EVAL-${c.id}` };
    const rec = record({ base: t.base ?? c.checks.analysis.base });
    await store.recordInstrument({ key, question: rec.question, outcomeLabel: rec.outcome_label, category: c.category, expiryUtc: null, settlementSource: rec.settlement_source, termsUrl: null, dataLabel: "FIXTURE", aliases: [] });
    const rt = rulesText(rec.rules_excerpts);
    const rules = { sourceKey: `eval:${c.id}:rules`, contentSha256: contentSha256(rt) };
    await store.recordSource({ instrument: key, sourceKey: rules.sourceKey, kind: "rules", dataLabel: "FIXTURE", mediaType: "text/plain", content: rt, retrievedAt: null, retrievedDate: "2026-11-17", verificationStatus: "not_required", verification: {}, provenance: { eval: c.id } });
    const ev = evidence(t, rec.contract_id);
    const evRef = { sourceKey: `eval:${c.id}:evidence`, contentSha256: contentSha256(ev.body_utf8) };
    await store.recordSource({ instrument: key, sourceKey: evRef.sourceKey, kind: "evidence", dataLabel: "FIXTURE", mediaType: "application/json", content: ev.body_utf8, retrievedAt: "2026-11-18T01:02:00Z", retrievedDate: null, verificationStatus: t.verification, verification: {}, provenance: { eval: c.id } });
    const asInput = (scores: Json, rating: Json, extra: Json) => ({
      instrument: key, schemaVersion: "verity-risk-analysis-v1", rubricVersion: "framework-sheet-rev5", analystId: "verity-rules-v1", dataLabel: "FIXTURE",
      assessedAt: "2026-11-18T01:00:00Z", quoteSourceIdentity: null,
      rating: { final: rating.final, total: rating.total, complete: rating.total !== null, action: "eval" },
      scores: Object.fromEntries(CATS.map((k) => [k, { score: scores[k], rationale: "eval", nullReason: scores[k] === null ? "unscored" : null, citationIds: [] }])),
      citedClaims: [], evidenceGap: null, changes: [], sources: [{ ...rules, role: "rules" }], trigger: null, ...extra,
    });
    let dbOutcome = "accepted";
    try {
      const v1 = await store.recordAssessment(asInput(s.scores, s.rating, { parentKey: null, decision: s.decision, decisionReason: "eval original" }));
      await store.recordAssessment(asInput(r.revised_scores, r.revised_rating, {
        parentKey: v1.assessmentKey, decision: r.status, decisionReason: r.reason.slice(0, 4000), trigger: evRef,
        changes: (r.changes as Json[]).map((x) => ({ finding: x.finding, before: x.before, after: x.after, changed: x.changed, reason: x.reason })),
        sources: [{ ...rules, role: "rules" }, { ...evRef, role: "evidence" }], assessedAt: "2026-11-18T01:02:00Z",
      }));
    } catch (error) {
      dbOutcome = `rejected: ${(error as Error).message.slice(0, 120)}`;
    }
    const dbExpected = !changed || t.verification === "verified" ? "accepted" : "rejected";
    // A changed finding on unverified evidence must also be refused when it is attempted directly.
    let forced = "not attempted";
    if (t.verification !== "verified") {
      try {
        const k2 = { ...key, outcomeId: `${key.outcomeId}-forced` };
        await store.recordInstrument({ key: k2, question: rec.question, outcomeLabel: rec.outcome_label, category: c.category, expiryUtc: null, settlementSource: null, termsUrl: null, dataLabel: "FIXTURE", aliases: [] });
        await store.recordSource({ instrument: k2, sourceKey: `eval:${c.id}:rules-forced`, kind: "rules", dataLabel: "FIXTURE", mediaType: "text/plain", content: rt, retrievedAt: null, retrievedDate: "2026-11-17", verificationStatus: "not_required", verification: {}, provenance: {} });
        const ev2 = { sourceKey: `eval:${c.id}:evidence-forced`, contentSha256: evRef.contentSha256 };
        await store.recordSource({ instrument: k2, sourceKey: ev2.sourceKey, kind: "evidence", dataLabel: "FIXTURE", mediaType: "application/json", content: ev.body_utf8, retrievedAt: "2026-11-18T01:02:00Z", retrievedDate: null, verificationStatus: t.verification, verification: {}, provenance: {} });
        const r2 = { sourceKey: `eval:${c.id}:rules-forced`, contentSha256: rules.contentSha256 };
        const base2 = (sc: Json, rt2: Json, extra: Json) => ({ ...asInput(sc, rt2, extra), instrument: k2, sources: [{ ...r2, role: "rules" }] });
        const v1 = await store.recordAssessment(base2(s.scores, s.rating, { parentKey: null, decision: s.decision, decisionReason: "eval original" }));
        await store.recordAssessment(base2({ ...s.scores, source: 1 }, { final: s.rating.final, total: s.rating.total === null ? null : s.rating.total - 1 }, {
          parentKey: v1.assessmentKey, decision: "revised", decisionReason: "forced change", trigger: ev2, assessedAt: "2026-11-18T01:03:00Z",
          changes: [{ finding: "scores.source", before: String(s.scores.source), after: "1", changed: true, reason: "forced" }],
        }));
        forced = "accepted";
      } catch (error) {
        forced = /needs verified evidence/.test((error as Error).message) ? "refused" : `error: ${(error as Error).message.slice(0, 80)}`;
      }
    }
    const pass = r.status === t.expect.status && changed === t.expect.changed && findingOk && Boolean(citedOk) && dbOutcome.startsWith(dbExpected) && (forced === "not attempted" || forced === "refused");
    add(c, "risk_change_traceability", t.data, pass, { ...t.expect, database: dbExpected, forced_change_on_unverified: t.verification === "verified" ? "n/a" : "refused" },
      { status: r.status, changed, changes: (r.changes as Json[]).filter((x) => x.changed).map((x) => `${x.finding}: ${x.before} -> ${x.after}`), evidence_cited: Boolean(citedOk), database: dbOutcome, forced_change_on_unverified: forced },
      r.reason);
  }
}
await db.close();

// ---------------------------------------------------------------- live checks
if (live) {
  const capture = await captureEvent("WXHIGH-NYC-2611190459");
  const c = { id: "L01-nyc-live-read", category: "weather", tags: ["live", "instrument_matching", "closed_quote"] };
  if (!capture.event) {
    add(c, "instrument_matching", "LIVE", false, "a live read", capture.unavailableReason, "the public API could not be read");
  } else {
    const m = matchOutcome({ exchange: "gemini", eventTicker: "WXHIGH-NYC-2611190459", outcomeLabel: "62°F to 63°F" }, capture.event);
    add(c, "instrument_matching", "LIVE", m.ok && m.key.outcomeId === "GEMI-WXHIGH-NYC-2611190459-62TO63", { outcomeId: "GEMI-WXHIGH-NYC-2611190459-62TO63" }, m.ok ? m.key : m, `read ${capture.fetchedAtUtc}`);
    const k = capture.event.contracts.find((x) => x.instrumentSymbol === "GEMI-WXHIGH-NYC-2611190459-62TO63");
    const open = k?.status === "active";
    const view = classifyQuote({ bestBid: k?.prices.bestBid, bestAsk: k?.prices.bestAsk, observedAtUtc: capture.fetchedAtUtc, now: Date.now() / 1000, staleAfterSeconds: 120, open });
    add(c, "quote_correctness", "LIVE", open ? view.state !== "stale" : view.state === "closed" && view.impliedProbability === null, { state: open ? "a current state" : "closed", implied: open ? "mid only if two-sided" : null }, { state: view.state, implied: view.impliedProbability, venueStatus: k?.status ?? null }, view.note);
  }
}

// ---------------------------------------------------------------- report
const checks = ["instrument_matching", "quote_correctness", "citation_support", "rubric_agreement", "abstention", "risk_change_traceability"];
const tally = (rows: Result[]) => `${rows.filter((r) => r.pass).length}/${rows.length}`;
const by = <K extends string>(rows: Result[], f: (r: Result) => K) => rows.reduce((m, r) => m.set(f(r), [...(m.get(f(r)) ?? []), r]), new Map<K, Result[]>());
const failures = results.filter((r) => !r.pass);
const head = spawnSync("git", ["rev-parse", "--short", "HEAD"], { cwd: root, encoding: "utf8" }).stdout.trim();
const dirty = spawnSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" }).stdout.trim() !== "";
const summary = {
  dataset: dataset.version,
  ranAtUtc: new Date().toISOString(),
  code: `${head}${dirty ? " plus uncommitted changes" : ""}`,
  python,
  live,
  reviewedCases: (dataset.cases as Json[]).filter((c) => c.review?.status === "approved").length,
  cases: (dataset.cases as Json[]).length,
  checks: results.length,
  passed: results.length - failures.length,
};
writeFileSync(join(outDir, "results.json"), JSON.stringify({ summary, results, rubricCells }, null, 2) + "\n");

const md: string[] = [];
md.push(`# Research evaluation ${dataset.version}: results\n`);
md.push(`Ran ${summary.ranAtUtc} on ${summary.code}. ${summary.passed} of ${summary.checks} checks passed across ${summary.cases} cases.\n`);
md.push(`> This is a research evaluation of how Verity reads markets. It does not measure forecasting performance; that needs a separate backtest. Human review: ${summary.reviewedCases} of ${summary.cases} cases approved so far, so every expected label below is provisional.\n`);
md.push("## By category and check\n");
md.push(`| Check | Weather | Sports | All |\n| --- | --- | --- | --- |`);
for (const ch of checks) {
  const rows = results.filter((r) => r.check === ch);
  md.push(`| ${ch} | ${tally(rows.filter((r) => r.category === "weather"))} | ${tally(rows.filter((r) => r.category === "sports"))} | ${tally(rows)} |`);
}
md.push(`| **all checks** | ${tally(results.filter((r) => r.category === "weather"))} | ${tally(results.filter((r) => r.category === "sports"))} | ${tally(results)} |\n`);
md.push("## By data label\n");
md.push("| Data | Passed |\n| --- | --- |");
for (const [label, rows] of by(results, (r) => r.data as string)) md.push(`| ${label} | ${tally(rows)} |`);
if (!live) md.push("| LIVE | not run (use --live) |");
md.push("\n## Rubric agreement by dimension\n");
md.push("Exact agreement between the code-only rules analyst and the expected label, over cases with rubric labels.\n");
md.push("| Dimension | Weather | Sports | All |\n| --- | --- | --- | --- |");
for (const dim of CATS) {
  const cells = rubricCells.filter((x) => x.dim === dim);
  const t = (xs: typeof cells) => `${xs.filter((x) => x.expected === x.got).length}/${xs.length}`;
  md.push(`| ${dim} | ${t(cells.filter((x) => x.category === "weather"))} | ${t(cells.filter((x) => x.category === "sports"))} | ${t(cells)} |`);
}
md.push("\n## By case type\n");
md.push("| Tag | Passed |\n| --- | --- |");
const tags = new Map<string, Result[]>();
for (const r of results) for (const tag of r.tags) tags.set(tag, [...(tags.get(tag) ?? []), r]);
for (const [tag, rows] of [...tags].sort()) md.push(`| ${tag} | ${tally(rows)} |`);
md.push(`\n## Failures (${failures.length})\n`);
for (const f of failures) {
  md.push(`- **${f.caseId}** \`${f.check}\` (${f.data}): ${f.detail || "see results.json"}`);
  md.push(`  - expected \`${JSON.stringify(f.expected)}\``);
  md.push(`  - got \`${JSON.stringify(f.got)}\``);
}
md.push("\n## Examples that pass\n");
for (const id of ["W03-nyc-verified-evidence", "W04-nyc-unverified-evidence", "W07-nyc-crossed", "S08-okc-wrong-game"]) {
  for (const r of results.filter((x) => x.caseId === id && x.pass).slice(0, 2)) md.push(`- **${r.caseId}** \`${r.check}\` (${r.data}): got \`${JSON.stringify(r.got)}\``);
}
md.push("\n## How to read this\n");
md.push("- FIXTURE: recorded or hand-made test data, including fixture records changed for a case. CAPTURED: a saved real API response. LIVE: read during this run.");
md.push("- Labels from the team workbook are the team's human-entered scores. Labels drafted by Claude are marked in cases.json and need a reviewer before they count as ground truth.");
md.push("- A failure is a disagreement with the expected label. For a low-confidence label it may be the label that is wrong; the reviewer decides.");
writeFileSync(join(outDir, "report.md"), md.join("\n") + "\n");
console.log(`${summary.passed}/${summary.checks} checks passed (${summary.cases} cases, ${failures.length} failures). Report: eval/research/v1/report.md`);
if (strict && failures.length) process.exitCode = 1;
