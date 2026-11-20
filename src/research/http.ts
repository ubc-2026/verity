/**
 * Read-only research API for the website. GET only; every other method gets
 * 405. Responses carry display fields from the reader role's views, never
 * provenance, verification internals or purchased evidence bytes.
 *
 *   GET /api/research/instruments
 *   GET /api/research/instruments/:exchange/:instrumentId/:outcomeId
 *   GET /api/research/aliases/:alias          (for example a Verity contract ID)
 */
import { InstrumentKeySchema } from "./model.ts";
import type { ResearchStore } from "./store.ts";

export interface RouteResult {
  status: number;
  body: unknown;
}

const segment = (s: string): string | null => {
  try {
    const v = decodeURIComponent(s);
    return /^[A-Za-z0-9._:-]{1,120}$/.test(v) ? v : null;
  } catch {
    return null;
  }
};

export async function researchRoute(store: ResearchStore | null, method: string, path: string, nowMs = Date.now()): Promise<RouteResult | null> {
  if (path !== "/api/research" && !path.startsWith("/api/research/")) return null;
  if (method !== "GET") return { status: 405, body: { error: "the research API is read-only" } };
  if (!store) return { status: 503, body: { error: "research store unavailable" } };
  if (path === "/api/research/instruments") return { status: 200, body: { instruments: await store.listInstruments() } };
  const alias = path.match(/^\/api\/research\/aliases\/([^/]+)$/);
  if (alias) {
    const a = segment(alias[1]!);
    if (!a) return { status: 400, body: { error: "bad alias" } };
    const key = await store.findAlias(a);
    return key ? { status: 200, body: { key } } : { status: 404, body: { error: "no instrument with that alias" } };
  }
  const detail = path.match(/^\/api\/research\/instruments\/([^/]+)\/([^/]+)\/([^/]+)$/);
  if (detail) {
    const parsed = InstrumentKeySchema.safeParse({ exchange: segment(detail[1]!), instrumentId: segment(detail[2]!), outcomeId: segment(detail[3]!) });
    if (!parsed.success) return { status: 400, body: { error: "bad instrument key" } };
    const view = await store.instrumentDetail(parsed.data, nowMs);
    return view ? { status: 200, body: view } : { status: 404, body: { error: "unknown instrument" } };
  }
  return { status: 404, body: { error: "not found" } };
}
