/**
 * Opens the research store for a server process from its environment.
 *
 * - VERITY_RESEARCH_READ_URL set: a real Postgres server, read-only through
 *   the reader role. VERITY_RESEARCH_INGEST_URL adds the ingest role. The
 *   server never migrates a real database; scripts/research-migrate.ts does,
 *   after review.
 * - Otherwise: embedded Postgres (PGlite) in VERITY_RESEARCH_PGLITE_DIR
 *   (default .verity/research-pg, or "memory"). The schema is migrated and the
 *   FIXTURE slice is ingested on start; both are idempotent. No credentials.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { EventCapture } from "./capture.ts";
import { ingestFixtureSlice, type FixtureSlice, type IngestSummary } from "./ingest.ts";
import { applyMigrations } from "./migrate.ts";
import { openPglite, openPostgres, type SqlDatabase } from "./sql.ts";
import { ResearchStore } from "./store.ts";

export function loadFixtureSlice(root: string): { slice: FixtureSlice; captures: EventCapture[] } {
  const dir = join(root, "samples", "research");
  const slice = JSON.parse(readFileSync(join(dir, "nyc-weather-slice.json"), "utf8")) as FixtureSlice;
  const captures = readdirSync(join(dir, "captures"))
    .filter((f) => f.startsWith(slice.market.eventTicker) && f.endsWith(".json"))
    .sort()
    .map((f) => JSON.parse(readFileSync(join(dir, "captures", f), "utf8")) as EventCapture);
  return { slice, captures };
}

export interface OpenedResearch {
  store: ResearchStore;
  mode: "pglite" | "postgres";
  where: string;
  seeded: IngestSummary | null;
  close(): Promise<void>;
}

export async function openResearchFromEnv(env: Record<string, string | undefined>, root: string): Promise<OpenedResearch> {
  const readUrl = env.VERITY_RESEARCH_READ_URL;
  if (readUrl) {
    const read = await openPostgres(readUrl, "verity-research-read");
    const ingest = env.VERITY_RESEARCH_INGEST_URL ? await openPostgres(env.VERITY_RESEARCH_INGEST_URL, "verity-research-ingest") : null;
    const store = new ResearchStore({ read, ingest });
    const host = (() => {
      try {
        const u = new URL(readUrl);
        return `${u.hostname}${u.pathname}`;
      } catch {
        return "configured server";
      }
    })();
    return {
      store,
      mode: "postgres",
      where: host,
      seeded: null,
      close: async () => {
        await read.close();
        await ingest?.close();
      },
    };
  }
  const dirSetting = env.VERITY_RESEARCH_PGLITE_DIR ?? join(root, ".verity", "research-pg");
  const db: SqlDatabase = await openPglite(dirSetting === "memory" ? undefined : dirSetting);
  await applyMigrations(db);
  const store = new ResearchStore({ read: db, ingest: db });
  const { slice, captures } = loadFixtureSlice(root);
  const seeded = await ingestFixtureSlice(store, slice, captures);
  return { store, mode: "pglite", where: dirSetting, seeded, close: () => db.close() };
}
