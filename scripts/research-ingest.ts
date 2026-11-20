/**
 * Trusted server-side ingestion of the research vertical slice (FIXTURE run
 * plus CAPTURED quotes). Replaying the same files adds nothing.
 *
 *   node scripts/research-ingest.ts [--pglite DIR] [--capture FILE ...]
 *
 * Without --pglite it writes to VERITY_RESEARCH_INGEST_URL (the ingest role),
 * from the environment or VERITY_RESEARCH_ENV_FILE (default .env.research).
 * It never migrates a server and never reads the payment env file.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { EventCapture } from "../src/research/capture.ts";
import { ingestFixtureSlice } from "../src/research/ingest.ts";
import { applyMigrations } from "../src/research/migrate.ts";
import { loadFixtureSlice } from "../src/research/runtime.ts";
import { openPglite, openPostgres, type SqlDatabase } from "../src/research/sql.ts";
import { ResearchStore } from "../src/research/store.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const envFile = process.env.VERITY_RESEARCH_ENV_FILE ?? join(root, ".env.research");
if (existsSync(envFile)) process.loadEnvFile(envFile);

const args = process.argv.slice(2);
const pgliteAt = args.indexOf("--pglite");
const extra = args.flatMap((a, i) => (args[i - 1] === "--capture" ? [a] : []));

let db: SqlDatabase;
if (pgliteAt >= 0) {
  const dir = args[pgliteAt + 1] ?? "";
  db = await openPglite(dir === "memory" ? undefined : resolve(dir));
  await applyMigrations(db); // local embedded database only
} else {
  const url = process.env.VERITY_RESEARCH_INGEST_URL;
  if (!url) {
    console.error("Set VERITY_RESEARCH_INGEST_URL (in .env.research) or pass --pglite DIR.");
    process.exit(2);
  }
  db = await openPostgres(url, "verity-research-ingest");
}
try {
  const { slice, captures } = loadFixtureSlice(root);
  for (const f of extra) captures.push(JSON.parse(readFileSync(resolve(f), "utf8")) as EventCapture);
  const store = new ResearchStore({ read: db, ingest: db });
  const s = await ingestFixtureSlice(store, slice, captures);
  console.log(
    `${s.key.exchange}/${s.key.instrumentId}/${s.key.outcomeId}: instrument ${s.instrument ? "added" : "exists"}; ` +
      `quotes +${s.quotes.inserted} (${s.quotes.duplicate} replayed); sources +${s.sources.inserted} (${s.sources.duplicate} replayed); ` +
      `assessments +${s.assessments.inserted} (${s.assessments.duplicate} replayed)`,
  );
} catch (error) {
  console.error((error as Error).message);
  process.exitCode = 1;
} finally {
  await db.close();
}
