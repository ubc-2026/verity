/**
 * Writes the recorded research history the run page shows when no app server
 * answers: the NYC weather slice ingested into a throwaway in-memory database
 * and read back through the reader role. Display fields only.
 *   node scripts/research-snapshot.ts   -> site/src/research-preview.json
 */
import { writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ingestFixtureSlice } from "../src/research/ingest.ts";
import { applyMigrations } from "../src/research/migrate.ts";
import { loadFixtureSlice } from "../src/research/runtime.ts";
import { openPglite } from "../src/research/sql.ts";
import { ResearchStore } from "../src/research/store.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const db = await openPglite();
await applyMigrations(db);
const store = new ResearchStore({ read: db, ingest: db });
const { slice, captures } = loadFixtureSlice(root);
const s = await ingestFixtureSlice(store, slice, captures);
const detail = await store.instrumentDetail(s.key);
await db.close();
const out = { label: "Recorded preview", alias: slice.contractId, recordedAtUtc: new Date().toISOString(), detail };
writeFileSync(join(root, "site", "src", "research-preview.json"), JSON.stringify(out, null, 2) + "\n");
console.log("wrote site/src/research-preview.json");
