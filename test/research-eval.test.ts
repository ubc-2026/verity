/**
 * The research evaluation set: its shape, its coverage, and (with Python) that
 * the deterministic checks hold. Disagreements on analyst quality are
 * findings for the report, not test failures.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { ROOT } from "./research.shared.ts";

const dataset = JSON.parse(readFileSync(join(ROOT, "eval", "research", "v1", "cases.json"), "utf8"));

describe("research evaluation set v1", () => {
  it("is versioned, labeled, and awaiting human review", () => {
    assert.equal(dataset.version, "research-eval-v1");
    assert.match(dataset.purpose, /does not measure forecasting performance/);
    const ids = new Set<string>();
    for (const c of dataset.cases) {
      assert.ok(!ids.has(c.id), `duplicate ${c.id}`);
      ids.add(c.id);
      assert.ok(["weather", "sports"].includes(c.category), c.id);
      assert.ok(c.label_source && c.summary, c.id);
      assert.ok(["pending", "approved", "changed"].includes(c.review.status), c.id);
      for (const [name, check] of Object.entries(c.checks as Record<string, { data: string }>)) {
        assert.ok(["FIXTURE", "CAPTURED", "LIVE"].includes(check.data), `${c.id}.${name} has no data label`);
      }
    }
    assert.equal(dataset.review.reviewed_cases, dataset.cases.filter((c: any) => c.review.status === "approved").length);
  });

  it("covers the required case types in weather and sports", () => {
    const tags = new Set(dataset.cases.flatMap((c: any) => c.tags));
    for (const t of ["clear_rules", "ambiguous_rules", "contradictory_sources", "missing_terms", "stale_quote", "one_sided_quote", "crossed_quote", "free_evidence_answers_gap", "unverified_evidence", "verified_evidence", "instrument_matching"]) {
      assert.ok(tags.has(t), `no case tagged ${t}`);
    }
    for (const cat of ["weather", "sports"]) {
      const own = new Set(dataset.cases.filter((c: any) => c.category === cat).flatMap((c: any) => c.tags));
      for (const t of ["clear_rules", "ambiguous_rules", "contradictory_sources", "missing_terms", "one_sided_quote", "unverified_evidence", "instrument_matching"]) assert.ok(own.has(t), `${cat} has no ${t} case`);
    }
  });

  const python = process.env.VERITY_PYTHON;
  it("passes every instrument, quote and traceability check", { skip: python ? false : "set VERITY_PYTHON to score the cases" }, () => {
    const out = mkdtempSync(join(tmpdir(), "verity-eval-"));
    try {
      const run = spawnSync(process.execPath, [join(ROOT, "scripts", "research-eval.ts"), "--out", out], { encoding: "utf8", timeout: 240_000 });
      assert.equal(run.status, 0, run.stderr);
      const { results } = JSON.parse(readFileSync(join(out, "results.json"), "utf8"));
      for (const check of ["instrument_matching", "quote_correctness", "risk_change_traceability"]) {
        const rows = results.filter((r: any) => r.check === check);
        assert.ok(rows.length > 0, check);
        for (const r of rows) assert.ok(r.pass, `${r.caseId} ${check}: ${JSON.stringify(r.got)}`);
      }
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });
});
