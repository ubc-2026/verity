/**
 * Instrument matching: from a market as Verity names it (event ticker and
 * outcome label) to the exchange's canonical key (event ticker and the
 * outcome's instrument symbol). A match must be exact and unique; anything
 * else is reported, never guessed.
 */
import type { InstrumentKey } from "./model.ts";

export interface VenueContract {
  id?: string | null;
  label: string;
  instrumentSymbol?: string | null;
}
export interface VenueEvent {
  ticker: string;
  contracts: VenueContract[];
}
export type OutcomeMatch =
  | { ok: true; key: InstrumentKey; venueContractId: string | null }
  | { ok: false; reason: "event_mismatch" | "no_match" | "ambiguous" | "bad_symbol"; detail: string };

/** Lower case, no degree sign, one form for ranges ("62°F to 63°F" = "62f-63f"). */
export function normalizeOutcomeLabel(label: string): string {
  return label
    .normalize("NFKC")
    .toLowerCase()
    .replace(/°/g, "")
    .replace(/[\u{2010}-\u{2015}]/gu, "-")
    .replace(/\s+to\s+/g, "-")
    .replace(/\s*-\s*/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

export function matchOutcome(query: { exchange: string; eventTicker: string; outcomeLabel: string }, event: VenueEvent): OutcomeMatch {
  if (query.exchange !== "gemini") return { ok: false, reason: "event_mismatch", detail: `no matcher for exchange ${query.exchange}` };
  if (event.ticker !== query.eventTicker) {
    return { ok: false, reason: "event_mismatch", detail: `event ${event.ticker} is not ${query.eventTicker}` };
  }
  const want = normalizeOutcomeLabel(query.outcomeLabel);
  const hits = event.contracts.filter((c) => normalizeOutcomeLabel(c.label) === want);
  if (hits.length === 0) return { ok: false, reason: "no_match", detail: `no outcome labeled "${query.outcomeLabel}" in ${event.ticker}` };
  if (hits.length > 1) return { ok: false, reason: "ambiguous", detail: `${hits.length} outcomes match "${query.outcomeLabel}"` };
  const symbol = hits[0]!.instrumentSymbol ?? "";
  if (!symbol.startsWith(`GEMI-${event.ticker}-`) || !/^[A-Za-z0-9._:-]{1,120}$/.test(symbol)) {
    return { ok: false, reason: "bad_symbol", detail: `instrument symbol "${symbol}" does not belong to ${event.ticker}` };
  }
  return { ok: true, key: { exchange: "gemini", instrumentId: event.ticker, outcomeId: symbol }, venueContractId: hits[0]!.id ?? null };
}
