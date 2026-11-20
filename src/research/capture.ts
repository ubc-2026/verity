/**
 * Captures one Gemini Exchange event from the public API: one GET, no key, no
 * orders. The capture keeps the fields research needs and the SHA-256 of the
 * full response, and is labeled CAPTURED. A failed read is recorded as an
 * unavailable capture, never as a price.
 */
import { createHash } from "node:crypto";
import { GEMINI_EVENTS_URL, type Fetcher } from "../app/markets.ts";

export const GEMINI_PROVIDER = "gemini-exchange-public-api";
const MAX_BYTES = 4 * 1024 * 1024;
const TICKER = /^[A-Z0-9][A-Z0-9-]{2,80}$/;

export interface CapturedContract {
  id: string | null;
  label: string;
  instrumentSymbol: string | null;
  status: string | null;
  marketState: string | null;
  prices: { bestBid: string | null; bestAsk: string | null; lastTradePrice: string | null };
  resolutionSide: string | null;
  termsUrl: string | null;
  expiryUtc: string | null;
}

export interface EventCapture {
  label: "CAPTURED";
  provider: typeof GEMINI_PROVIDER;
  url: string;
  fetchedAtUtc: string;
  httpStatus: number | null;
  responseSha256: string | null;
  unavailableReason: string | null;
  event: {
    ticker: string;
    title: string | null;
    category: string | null;
    status: string | null;
    expiryUtc: string | null;
    resolvedAtUtc: string | null;
    termsUrl: string | null;
    description: string | null;
    contracts: CapturedContract[];
  } | null;
}

const str = (v: unknown) => (typeof v === "string" && v !== "" ? v : null);
const priceStr = (v: unknown) => (typeof v === "string" || typeof v === "number" ? String(v) : null);

export function trimEvent(raw: Record<string, any>): NonNullable<EventCapture["event"]> {
  return {
    ticker: String(raw.ticker ?? ""),
    title: str(raw.title),
    category: str(raw.category),
    status: str(raw.status),
    expiryUtc: str(raw.expiryDate),
    resolvedAtUtc: str(raw.resolvedAt),
    termsUrl: str(raw.termsLink),
    description: str(raw.description)?.slice(0, 8000) ?? null,
    contracts: (Array.isArray(raw.contracts) ? raw.contracts : []).slice(0, 200).map((c: Record<string, any>) => {
      const p = (c.prices ?? {}) as Record<string, unknown>;
      return {
        id: str(c.id),
        label: String(c.label ?? c.ticker ?? ""),
        instrumentSymbol: str(c.instrumentSymbol),
        status: str(c.status),
        marketState: str(c.marketState),
        prices: { bestBid: priceStr(p.bestBid), bestAsk: priceStr(p.bestAsk), lastTradePrice: priceStr(p.lastTradePrice) },
        resolutionSide: str(c.resolutionSide),
        termsUrl: str(c.termsAndConditionsUrl),
        expiryUtc: str(c.expiryDate),
      };
    }),
  };
}

export async function captureEvent(ticker: string, opts: { fetch?: Fetcher; now?: () => Date } = {}): Promise<EventCapture> {
  if (!TICKER.test(ticker)) throw new Error("event ticker: capital letters, digits and - only");
  const url = `${GEMINI_EVENTS_URL}/${encodeURIComponent(ticker)}`;
  const fetcher = opts.fetch ?? (globalThis.fetch as unknown as Fetcher);
  const fetchedAtUtc = (opts.now?.() ?? new Date()).toISOString();
  const base = { label: "CAPTURED" as const, provider: GEMINI_PROVIDER as typeof GEMINI_PROVIDER, url, fetchedAtUtc };
  try {
    const response = await fetcher(url, { signal: AbortSignal.timeout(10_000), headers: { accept: "application/json" } });
    const body = await response.text();
    if (!response.ok) return { ...base, httpStatus: response.status, responseSha256: null, unavailableReason: `HTTP ${response.status}`, event: null };
    if (body.length > MAX_BYTES) return { ...base, httpStatus: response.status, responseSha256: null, unavailableReason: "response larger than 4 MiB", event: null };
    const raw = JSON.parse(body) as Record<string, any>;
    if (raw.ticker !== ticker) return { ...base, httpStatus: response.status, responseSha256: null, unavailableReason: "response names another event", event: null };
    return {
      ...base,
      httpStatus: response.status,
      responseSha256: "0x" + createHash("sha256").update(body, "utf8").digest("hex"),
      unavailableReason: null,
      event: trimEvent(raw),
    };
  } catch (error) {
    return { ...base, httpStatus: null, responseSha256: null, unavailableReason: `read failed: ${(error as Error).name}`, event: null };
  }
}
