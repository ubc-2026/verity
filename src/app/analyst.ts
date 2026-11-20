/**
 * Runs the Python analysis CLI (analysis/verity/cli.py) without blocking the
 * server. Fixture analysis reads fixtures only; no network and no keys.
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

/** At most this many uncached live analyses run at once; more get a 429. */
export const MAX_LIVE_IN_FLIGHT = 2;

export class LiveAnalysisBusyError extends Error {
  constructor() {
    super("live analyses are busy; try again shortly");
  }
}

export interface RiskAnalysis {
  contract_id: string;
  event_ticker?: string | null;
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

/** Environment names the analysis process may see. Everything else, including secrets, stays in this process. */
const PYTHON_ENV_ALLOW = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TMPDIR",
  "TMP",
  "TEMP",
  "SYSTEMROOT",
  "WINDIR",
  "PATHEXT",
  "PYTHONPATH",
  "PYTHONHOME",
  "VIRTUAL_ENV",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
] as const;

export function pythonChildEnv(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1" };
  for (const key of PYTHON_ENV_ALLOW) {
    const value = source[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
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
    const probe = spawnSync(candidate, ["-c", "import pydantic, sys; print(sys.version_info[:2] >= (3, 11))"], { encoding: "utf8", timeout: 20_000, env: pythonChildEnv() });
    if (probe.status === 0 && probe.stdout.trim() === "True") return candidate;
  }
  throw new Error("No Python 3.11+ with pydantic found. Set VERITY_PYTHON or create analysis/.venv (see analysis/README.md).");
}

export class Analyst {
  readonly python: string;
  readonly dir: string;
  readonly #cache = new Map<string, Promise<AnalyzeOutput>>();
  readonly #liveCache = new Map<string, { pending: Promise<AnalyzeOutput>; expires: number }>();
  /** Live analyses that started a Python child and have not finished. */
  #liveInFlight = 0;

  constructor(python: string, dir: string) {
    this.python = python;
    this.dir = dir;
  }

  #run(args: string[], input?: string): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.python, ["-m", "verity.cli", ...args], {
        cwd: this.dir,
        env: pythonChildEnv(),
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
        if (code !== 0) {
          const last = Buffer.concat(err).toString("utf8").trim().split("\n").at(-1) ?? "";
          // findPython only checks for pydantic. Live runs also need requests and pypdf.
          const hint = /ModuleNotFoundError/.test(last) ? " (install analysis/requirements-live.txt into this Python)" : "";
          return reject(new Error(`analysis exited ${code}: ${last}${hint}`));
        }
        try {
          resolve(JSON.parse(Buffer.concat(out).toString("utf8")));
        } catch (error) {
          reject(error);
        }
      });
      child.stdin.end(input ?? "");
    });
  }

  /** Fixture analysis is deterministic, so results are cached per contract, free-check scenario, and payment rail. */
  analyze(contract: string, scenario: string | null, rail: "arc-eip3009" | "circle-gateway-batched" = "arc-eip3009"): Promise<AnalyzeOutput> {
    const key = `${contract}|${scenario ?? ""}|${rail}`;
    let pending = this.#cache.get(key);
    if (!pending) {
      pending = this.#run(["analyze", "--contract", contract, ...(scenario ? ["--free-check-scenario", scenario] : []), "--rail", rail]) as Promise<AnalyzeOutput>;
      pending.catch(() => this.#cache.delete(key));
      this.#cache.set(key, pending);
    }
    return pending;
  }

  /**
   * LIVE read-only analysis of one Gemini Exchange outcome (python -m verity.cli analyze-live): public
   * reads from api.gemini.com, assets.gemini.com and forecast.weather.gov only, no model, no payment.
   * No evidence catalog is passed, so a live run never proposes a purchase. The CLI output has no
   * `research` block; one is built from the risk analysis, and anything it does not carry is listed
   * as unavailable. Results are reused for 60 s per event, outcome and rail.
   */
  analyzeLive(event: string, outcome: string, rail: "arc-eip3009" | "circle-gateway-batched" = "circle-gateway-batched"): Promise<AnalyzeOutput> {
    const key = `live|${event}|${outcome}|${rail}`;
    const cached = this.#liveCache.get(key);
    if (cached && cached.expires > Date.now()) return cached.pending;
    // Each uncached live run starts a Python child that reads public sources; cap how many run at once.
    if (this.#liveInFlight >= MAX_LIVE_IN_FLIGHT) return Promise.reject(new LiveAnalysisBusyError());
    this.#liveInFlight += 1;
    const pending = (this.#run(["analyze-live", "--event", event, "--outcome", outcome, "--rail", rail]) as Promise<LiveAnalyzeOutput>)
      .then(withResearch)
      .finally(() => { this.#liveInFlight -= 1; });
    pending.catch(() => this.#liveCache.delete(key));
    this.#liveCache.set(key, { pending, expires: Date.now() + 60_000 });
    return pending;
  }

  reassess(riskAnalysis: RiskAnalysis, body: Uint8Array, provenance: Record<string, string>): Promise<Reassessment> {
    const input = JSON.stringify({ risk_analysis: riskAnalysis, body_b64: Buffer.from(body).toString("base64"), provenance });
    return this.#run(["reassess"], input) as Promise<Reassessment>;
  }
}

/** analyze-live output: the same analysis and proposal fields, without the fixture research block. */
export type LiveAnalyzeOutput = Omit<AnalyzeOutput, "research"> & { label?: string; command?: string };

/** Builds the research block the run views expect from a live risk analysis. Unknown fields stay null and are listed. */
export function withResearch(live: LiveAnalyzeOutput): AnalyzeOutput {
  const ra = live.risk_analysis;
  const byId = new Map(ra.citations.map((c) => [c.id, c]));
  const terms = ra.citations.find((c) => /terms|.pdf/i.test(c.source) && c.source.startsWith("https://assets.gemini.com/"));
  const ruleIds = ra.citations.filter((c) => c.id !== "C-EVENT" && (/^contract./.test(c.field_or_rule) || /terms|rule/i.test(c.field_or_rule) || c.id === "C-TERMS")).map((c) => c.id);
  const q = ra.quoted_price;
  return {
    ...live,
    research: {
      market: {
        contract_id: ra.contract_id,
        event_ticker: ra.event_ticker ?? null,
        outcome_label: q?.outcome_label ?? ra.contract_id,
        question: ra.question,
        expiry_utc: ra.expiry_utc,
        resolution: { settlement_source: null, terms_url: terms?.source ?? null, terms_url_note: terms ? null : "No terms PDF was cited by the live analysis.", rule_excerpt_ids: ruleIds },
        quote: { best_bid: q?.best_bid ?? null, best_ask: q?.best_ask ?? null, volume_usd: q?.volume_usd ?? null, volume_basis: q?.volume_basis ?? null },
        source_mode: ra.snapshot.source_mode,
        source_label: ra.snapshot.source_label,
        source_url: byId.get("C-EVENT")?.source ?? "https://api.gemini.com/v1/prediction-markets/events",
        observed_date: q?.observed_date ?? ra.snapshot.snapshot_date,
        observed_utc: q?.observed_time_utc ?? ra.snapshot.snapshot_time_utc,
        unavailable: ["settlement_source (not extracted as a field by the live analysis; see the rule citations)", "price_trend (live runs read one snapshot)"],
      },
      coverage: { status: "not_run", reason: "Live runs read public sources only; no paid search." },
      price_trend: { status: "not_run", reason: "One live snapshot." },
    },
  };
}
