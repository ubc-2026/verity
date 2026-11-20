/**
 * Runs the Python analysis CLI (analysis/verity/cli.py) without blocking the
 * server. Fixture analysis reads fixtures only; no network and no keys.
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

export interface RiskAnalysis {
  contract_id: string;
  question: string;
  expiry_utc: string | null;
  analyzed_at_utc: string;
  snapshot: { source_mode: string; source_label: string; snapshot_date: string | null; snapshot_time_utc: string | null; snapshot_hash: string };
  quoted_price: { outcome_label: string; best_bid: string | null; best_ask: string | null; mid: string | null; implied_probability: string | null; volume_usd: string | null; volume_basis: string | null; observed_date: string | null; observed_time_utc: string | null } | null;
  scores: Record<string, { score: number | null; rationale: string; null_reason: string | null; citation_ids: string[] }>;
  rating: { final_rating: string | null; raw_total: number | null; raw_rating: string | null; complete: boolean };
  research_action: string;
  summary: string;
  citations: { id: string; source: string; field_or_rule: string; quote: string }[];
  evidence_gaps: { id: string; question: string; gap_type: string; affects: string; material: boolean; why: string; free_checks: string[] }[];
  unresolved_questions: string[];
  data_quality_flags: string[];
}

export interface PurchaseProposal {
  version: string;
  proposal_id: string;
  contract_id: string;
  evidence_gap_id: string;
  catalog_item_id: string;
  evidence_type: string;
  catalog_parameters: Record<string, string>;
  rationale: string;
  max_amount_base_units: string;
  fixture_label: string | null;
  [key: string]: unknown;
}

export interface AnalyzeOutput {
  research: {
    market: {
      contract_id: string;
      event_ticker: string | null;
      outcome_label: string;
      question: string;
      expiry_utc: string | null;
      resolution: { settlement_source: string | null; terms_url: string | null; terms_url_note?: string | null; rule_excerpt_ids: string[] };
      quote: { best_bid: string | null; best_ask: string | null; volume_usd: string | null; volume_basis: string | null };
      source_mode: string;
      source_label: string;
      source_url: string;
      observed_date: string | null;
      observed_utc: string | null;
      unavailable: string[];
    };
    coverage: { status: string; reason: string | null };
    price_trend: { status: string; reason?: string | null };
  };
  risk_analysis: RiskAnalysis;
  purchase_proposal: PurchaseProposal | null;
  no_purchase_reason: string | null;
  decision_log: string[];
}

export interface Reassessment {
  status: "revised" | "unchanged" | "evidence_rejected";
  reason: string;
  revised: RiskAnalysis;
  changes: { finding: string; before: string | null; after: string | null; changed: boolean; reason: string }[];
  evidence_citation: { id: string; source: string; quote: string } | null;
}

export function findPython(analysisDir: string): string {
  const candidates = [
    process.env.VERITY_PYTHON,
    join(analysisDir, ".venv", "Scripts", "python.exe"),
    join(analysisDir, ".venv", "bin", "python"),
    "python3",
    "python",
  ].filter((c): c is string => Boolean(c));
  for (const candidate of candidates) {
    if ((candidate.includes("/") || candidate.includes("\\")) && !existsSync(candidate)) continue;
    const probe = spawnSync(candidate, ["-c", "import pydantic, sys; print(sys.version_info[:2] >= (3, 11))"], { encoding: "utf8", timeout: 20_000 });
    if (probe.status === 0 && probe.stdout.trim() === "True") return candidate;
  }
  throw new Error("No Python 3.11+ with pydantic found. Set VERITY_PYTHON or create analysis/.venv (see analysis/README.md).");
}

export class Analyst {
  readonly python: string;
  readonly dir: string;
  readonly #cache = new Map<string, Promise<AnalyzeOutput>>();

  constructor(python: string, dir: string) {
    this.python = python;
    this.dir = dir;
  }

  #run(args: string[], input?: string): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.python, ["-m", "verity.cli", ...args], {
        cwd: this.dir,
        env: { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1" },
        stdio: ["pipe", "pipe", "pipe"],
      });
      const out: Buffer[] = [];
      const err: Buffer[] = [];
      const timer = setTimeout(() => child.kill(), 60_000);
      child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
      child.stderr.on("data", (chunk: Buffer) => err.push(chunk));
      child.on("error", reject);
      child.on("close", (code) => {
        clearTimeout(timer);
        if (code !== 0) return reject(new Error(`analysis exited ${code}: ${Buffer.concat(err).toString("utf8").trim().split("\n").at(-1) ?? ""}`));
        try {
          resolve(JSON.parse(Buffer.concat(out).toString("utf8")));
        } catch (error) {
          reject(error);
        }
      });
      child.stdin.end(input ?? "");
    });
  }

  /** Fixture analysis is deterministic, so results are cached per contract and free-check scenario. */
  analyze(contract: string, scenario: string | null): Promise<AnalyzeOutput> {
    const key = `${contract}|${scenario ?? ""}`;
    let pending = this.#cache.get(key);
    if (!pending) {
      pending = this.#run(["analyze", "--contract", contract, ...(scenario ? ["--free-check-scenario", scenario] : [])]) as Promise<AnalyzeOutput>;
      pending.catch(() => this.#cache.delete(key));
      this.#cache.set(key, pending);
    }
    return pending;
  }

  reassess(riskAnalysis: RiskAnalysis, body: Uint8Array, provenance: Record<string, string>): Promise<Reassessment> {
    const input = JSON.stringify({ risk_analysis: riskAnalysis, body_b64: Buffer.from(body).toString("base64"), provenance });
    return this.#run(["reassess"], input) as Promise<Reassessment>;
  }
}
