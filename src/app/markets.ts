/**
 * Market snapshots for the app: the FIXTURE workbook markets and a LIVE
 * read-only view of Gemini Exchange prediction markets (public endpoint, no
 * key, no orders). Every quote carries a state, so a missing, one-sided, stale
 * or crossed book is shown as such instead of as a price.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

export const GEMINI_EVENTS_URL = "https://api.gemini.com/v1/prediction-markets/events";

export type QuoteState = "two_sided" | "one_sided_bid" | "one_sided_ask" | "missing" | "crossed" | "stale" | "closed";

export interface QuoteView {
  bestBid: string | null;
  bestAsk: string | null;
  /** Mid of a two-sided, uncrossed book. Null for every other state. */
  impliedProbability: string | null;
  spread: string | null;
  lastTradePrice: string | null;
  state: QuoteState;
  /** Plain-language note for the state. */
  note: string;
  /** When Verity read the quote (UTC). The exchange API does not timestamp its quotes. */
  observedAtUtc: string | null;
  /** Date of the snapshot when only the date was recorded (fixture workbook). */
  observedDate: string | null;
  ageSeconds: number | null;
}

const price = (value: unknown): number | null => {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 && n <= 1 ? n : null;
};
const fmt = (n: number) => n.toFixed(4).replace(/0+$/, "").replace(/\.$/, ".0");

/**
 * Classifies one quote. Stale means Verity's own reading is older than
 * `staleAfterSeconds` (a cached reading after a failed refresh, for example).
 */
export function classifyQuote(input: {
  bestBid: unknown;
  bestAsk: unknown;
  lastTradePrice?: unknown;
  observedAtUtc: string | null;
  observedDate?: string | null;
  now: number;
  staleAfterSeconds: number;
  open?: boolean;
}): QuoteView {
  const bid = price(input.bestBid);
  const ask = price(input.bestAsk);
  const observed = input.observedAtUtc ? Date.parse(input.observedAtUtc) / 1000 : null;
  const ageSeconds = observed === null ? null : Math.max(0, Math.round(input.now - observed));
  const base = {
    bestBid: bid === null ? null : fmt(bid),
    bestAsk: ask === null ? null : fmt(ask),
    lastTradePrice: price(input.lastTradePrice) === null ? null : fmt(price(input.lastTradePrice)!),
    observedAtUtc: input.observedAtUtc,
    observedDate: input.observedDate ?? (input.observedAtUtc ? input.observedAtUtc.slice(0, 10) : null),
    ageSeconds,
  };
  const none = { impliedProbability: null, spread: null };
  if (input.open === false) return { ...base, ...none, state: "closed", note: "The contract is not open for trading." };
  if (ageSeconds !== null && ageSeconds > input.staleAfterSeconds) {
    return { ...base, ...none, state: "stale", note: `Read ${ageSeconds} s ago, older than the ${input.staleAfterSeconds} s limit. No implied price is shown.` };
  }
  if (bid === null && ask === null) return { ...base, ...none, state: "missing", note: "No bid and no ask. A last trade is not a current price." };
  if (bid === null) return { ...base, ...none, state: "one_sided_ask", note: "Ask only. A one-sided book gives no market-implied price." };
  if (ask === null) return { ...base, ...none, state: "one_sided_bid", note: "Bid only. A one-sided book gives no market-implied price." };
  if (bid > ask) return { ...base, ...none, state: "crossed", note: "Bid above ask. The quote is inconsistent and is not used." };
  return {
    ...base,
    impliedProbability: fmt((bid + ask) / 2),
    spread: fmt(ask - bid),
    state: "two_sided",
    note: "Mid of the best bid and best ask.",
  };
}

// ---------------------------------------------------------------- FIXTURE markets

export interface FixtureMarket {
  contractId: string;
  question: string;
  outcomeLabel: string;
  eventTicker: string | null;
  expiryUtc: string | null;
  settlementSource: string | null;
  termsUrl: string | null;
  source: { mode: string; label: string; url: string; snapshotDate: string; snapshotTimeUtc: string | null };
  volumeUsd: string | null;
  volumeBasis: string | null;
  quote: QuoteView;
  label: "FIXTURE" | "LIVE";
}

interface RawFixtureMarket {
  contract_id: string;
  question: string;
  outcome_label: string;
  event_ticker: string | null;
  expiry_utc: string | null;
  settlement_source: string | null;
  terms_url: string | null;
  source: { mode: string; label: string; url: string; snapshot_date: string; snapshot_time_utc: string | null };
  market: { best_bid: string | null; best_ask: string | null; volume_usd: string | null; volume_basis: string | null };
}

export function loadFixtureMarkets(analysisDir: string): FixtureMarket[] {
  const raw = JSON.parse(readFileSync(join(analysisDir, "fixtures", "markets_2026-11-17.json"), "utf8")) as { markets: RawFixtureMarket[] };
  return raw.markets.map((m) => ({
    contractId: m.contract_id,
    question: m.question,
    outcomeLabel: m.outcome_label,
    eventTicker: m.event_ticker,
    expiryUtc: m.expiry_utc,
    settlementSource: m.settlement_source,
    termsUrl: m.terms_url,
    source: {
      mode: m.source.mode,
      label: m.source.label,
      url: m.source.url,
      snapshotDate: m.source.snapshot_date,
      snapshotTimeUtc: m.source.snapshot_time_utc,
    },
    volumeUsd: m.market.volume_usd,
    volumeBasis: m.market.volume_basis,
    // The workbook recorded a date, not a time, so the quote has no age and is labeled by date.
    quote: classifyQuote({
      bestBid: m.market.best_bid,
      bestAsk: m.market.best_ask,
      observedAtUtc: m.source.snapshot_time_utc,
      observedDate: m.source.snapshot_date,
      now: 0,
      staleAfterSeconds: Number.POSITIVE_INFINITY,
    }),
    label: "FIXTURE",
  }));
}

// ---------------------------------------------------------------- LIVE read-only markets

export interface LiveContract {
  ticker: string | null;
  label: string;
  instrumentSymbol: string | null;
  status: string | null;
  expiryUtc: string | null;
  termsUrl: string | null;
  quote: QuoteView;
}

export interface LiveEvent {
  ticker: string;
  title: string;
  category: string | null;
  status: string | null;
  expiryUtc: string | null;
  termsUrl: string | null;
  volumeUsd: string | null;
  url: string;
  contracts: LiveContract[];
}

export interface LiveSnapshot {
  label: "LIVE read-only";
  source: string;
  fetchedAtUtc: string | null;
  state: "ok" | "stale" | "unavailable";
  note: string;
  events: LiveEvent[];
}

export type Fetcher = (url: string, init: { signal: AbortSignal; headers: Record<string, string> }) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

const MAX_LIVE_BYTES = 4 * 1024 * 1024;
const iso = (seconds: number) => new Date(seconds * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");

function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : typeof value === "number" ? String(value) : null;
}

const TERMS_PDF = /https:\/\/assets\.gemini\.com\/predictions\/terms_and_conditions\/[^\s"'()<>\\]+?\.pdf/gi;

/**
 * Gemini weather events leave termsLink and termsAndConditionsUrl empty and link the terms PDF only in the
 * contract description. Returns that link when exactly one terms PDF appears, as analysis/verity/live.py does.
 */
export function termsPdfInDescription(description: unknown): string | null {
  const found = new Set(JSON.stringify(description ?? "").match(TERMS_PDF) ?? []);
  return found.size === 1 ? [...found][0]! : null;
}

export function shapeLiveEvent(raw: Record<string, any>, fetchedAt: number, now: number, staleAfterSeconds: number): LiveEvent {
  const ticker = String(raw.ticker ?? "");
  const eventOpen = (raw.status ?? "active") === "active";
  const rawContracts: Record<string, any>[] = Array.isArray(raw.contracts) ? raw.contracts : [];
  return {
    ticker,
    title: String(raw.title ?? ticker),
    category: str(raw.category),
    status: str(raw.status),
    expiryUtc: str(raw.expiryDate),
    termsUrl: str(raw.termsLink) ?? (rawContracts.length > 0 ? termsPdfInDescription(rawContracts[0]!.description) : null),
    volumeUsd: str(raw.volume),
    url: `${GEMINI_EVENTS_URL}/${encodeURIComponent(ticker)}`,
    contracts: rawContracts.map((c) => {
      const prices = (c.prices ?? {}) as Record<string, unknown>;
      const expired = typeof c.expiryDate === "string" && Date.parse(c.expiryDate) / 1000 <= now;
      return {
        ticker: str(c.ticker),
        label: String(c.label ?? c.ticker ?? ""),
        instrumentSymbol: str(c.instrumentSymbol),
        status: str(c.status),
        expiryUtc: str(c.expiryDate),
        termsUrl: str(c.termsAndConditionsUrl) ?? str(raw.termsLink) ?? termsPdfInDescription(c.description),
        quote: classifyQuote({
          bestBid: prices.bestBid,
          bestAsk: prices.bestAsk,
          lastTradePrice: prices.lastTradePrice,
          observedAtUtc: iso(fetchedAt),
          now,
          staleAfterSeconds,
          open: eventOpen && (c.status ?? "active") === "active" && !expired,
        }),
      };
    }),
  };
}

/**
 * Read-only client for the public Gemini Exchange events endpoint. One GET per
 * refresh, a 10 s timeout and a 4 MiB cap. A failed refresh keeps the last
 * reading and marks it stale; it never invents a price.
 */
export class LiveMarkets {
  readonly #fetch: Fetcher;
  readonly #clock: () => number;
  readonly #cacheSeconds: number;
  readonly #staleAfterSeconds: number;
  #last: { at: number; limit: number; raw: Record<string, any>[] } | null = null;
  #lastError: string | null = null;

  constructor(options: { fetch?: Fetcher; now?: () => number; cacheSeconds?: number; staleAfterSeconds?: number } = {}) {
    this.#fetch = options.fetch ?? (fetch as unknown as Fetcher);
    this.#clock = options.now ?? (() => Math.floor(Date.now() / 1000));
    this.#cacheSeconds = options.cacheSeconds ?? 30;
    this.#staleAfterSeconds = options.staleAfterSeconds ?? 120;
  }

  async snapshot(limit = 25): Promise<LiveSnapshot> {
    const now = this.#clock();
    const wanted = Math.min(Math.max(Math.floor(limit) || 1, 1), 100);
    // A cached reading serves any smaller limit; a larger limit needs a new read.
    if (!this.#last || now - this.#last.at >= this.#cacheSeconds || this.#last.limit < wanted) await this.#refresh(wanted, now);
    if (!this.#last) {
      const source = `${GEMINI_EVENTS_URL}?status=active&limit=${wanted}`;
      return { label: "LIVE read-only", source, fetchedAtUtc: null, state: "unavailable", note: `Gemini Exchange did not answer: ${this.#lastError ?? "no reading yet"}.`, events: [] };
    }
    const source = `${GEMINI_EVENTS_URL}?status=active&limit=${this.#last.limit}`;
    const age = now - this.#last.at;
    const stale = age > this.#staleAfterSeconds;
    return {
      label: "LIVE read-only",
      source,
      fetchedAtUtc: iso(this.#last.at),
      state: stale ? "stale" : "ok",
      note: stale
        ? `Last reading is ${age} s old (refresh failed: ${this.#lastError ?? "unknown"}). Prices are not shown as current.`
        : "Read from the public endpoint. The API does not timestamp quotes, so the time shown is when Verity read them.",
      events: this.#last.raw.slice(0, wanted).map((raw) => shapeLiveEvent(raw, this.#last!.at, now, this.#staleAfterSeconds)),
    };
  }

  async #refresh(limit: number, now: number) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    try {
      const response = await this.#fetch(`${GEMINI_EVENTS_URL}?status=active&limit=${limit}`, {
        signal: controller.signal,
        headers: { accept: "application/json", "user-agent": "verity-readonly" },
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const text = await response.text();
      if (text.length > MAX_LIVE_BYTES) throw new Error("response too large");
      const body = JSON.parse(text) as { data?: unknown };
      if (!Array.isArray(body.data)) throw new Error("unexpected response shape");
      this.#last = { at: now, limit, raw: body.data as Record<string, any>[] };
      this.#lastError = null;
    } catch (error) {
      this.#lastError = (error as Error).name === "AbortError" ? "timed out" : (error as Error).message;
    } finally {
      clearTimeout(timer);
    }
  }
}
