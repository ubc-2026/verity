/**
 * Research schema migrations. Plans by default; applying to a server needs
 * the exact target and the checksum of the reviewed migration.
 *
 *   node scripts/research-migrate.ts status   [--pglite DIR]
 *   node scripts/research-migrate.ts plan     [--pglite DIR]        prints pending SQL and checksums
 *   node scripts/research-migrate.ts apply    [--pglite DIR]
 *        server: --confirm-target HOST:PORT/DB --reviewed sha256:<checksum of each pending migration>
 *   node scripts/research-migrate.ts rollback --version 0001 [--pglite DIR]
 *        server: --confirm-target HOST:PORT/DB --i-have-a-backup
 *
 * Server connection: VERITY_RESEARCH_MIGRATE_URL (the schema owner), read from
 * the environment or from VERITY_RESEARCH_ENV_FILE (default .env.research,
 * gitignored). The payment env file (VERITY_ENV_FILE) is never read here.
 * Credentials are never printed: the target shows host, port and database.
 */
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { applyMigrations, loadMigrations, migrationStatus, rollbackMigration } from "../src/research/migrate.ts";
import { openPglite, openPostgres, type SqlDatabase } from "../src/research/sql.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const envFile = process.env.VERITY_RESEARCH_ENV_FILE ?? join(root, ".env.research");
if (existsSync(envFile)) process.loadEnvFile(envFile);

const args = process.argv.slice(2);
const command = args[0] && !args[0].startsWith("--") ? args[0] : "status";
const flag = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? (args[i + 1] ?? "") : null;
};
const has = (name: string) => args.includes(name);

let db: SqlDatabase;
let target: string;
let server = false;
const pgliteDir = flag("--pglite");
if (pgliteDir !== null) {
  db = await openPglite(pgliteDir === "memory" ? undefined : resolve(pgliteDir));
  target = `pglite:${pgliteDir}`;
} else {
  const url = process.env.VERITY_RESEARCH_MIGRATE_URL;
  if (!url) {
    console.error("Set VERITY_RESEARCH_MIGRATE_URL (in .env.research) or pass --pglite DIR.");
    process.exit(2);
  }
  const u = new URL(url);
  target = `${u.hostname}:${u.port || "5432"}${u.pathname}`;
  server = true;
  db = await openPostgres(url, "verity-research-migrate");
}

try {
  const migrations = loadMigrations();
  const status = await migrationStatus(db, migrations);
  const pending = status.filter((s) => s.state === "pending");
  console.log(`Target: ${target}`);
  for (const s of status) console.log(`  ${s.version} ${s.name}: ${s.state} ${s.checksum}${s.appliedAt ? ` (applied ${s.appliedAt})` : ""}`);
  if (command === "status") {
    // done
  } else if (command === "plan") {
    if (!pending.length) console.log("Nothing to apply.");
    for (const p of pending) {
      const m = migrations.find((x) => x.version === p.version)!;
      console.log(`\n-- ---- ${m.version}_${m.name}.up.sql (${m.checksum})\n${m.up}`);
    }
  } else if (command === "apply") {
    if (server) {
      if (flag("--confirm-target") !== target) throw new Error(`refusing: pass --confirm-target ${target} after checking it is the reviewed project`);
      const reviewed = new Set(args.filter((_, i) => args[i - 1] === "--reviewed"));
      const unreviewed = pending.filter((p) => !reviewed.has(p.checksum));
      if (unreviewed.length) throw new Error(`refusing: pass --reviewed <checksum> for ${unreviewed.map((p) => p.version).join(", ")} (see plan)`);
    }
    const done = await applyMigrations(db, migrations);
    console.log(done.length ? `Applied: ${done.join(", ")}` : "Nothing to apply.");
  } else if (command === "rollback") {
    const version = flag("--version");
    if (!version) throw new Error("pass --version NNNN");
    if (server) {
      if (flag("--confirm-target") !== target) throw new Error(`refusing: pass --confirm-target ${target}`);
      if (!has("--i-have-a-backup")) throw new Error("refusing: rollback deletes every research record; back up first and pass --i-have-a-backup");
    }
    await rollbackMigration(db, version, migrations);
    console.log(`Rolled back ${version}.`);
  } else {
    throw new Error(`unknown command ${command}`);
  }
} catch (error) {
  console.error((error as Error).message);
  process.exitCode = 1;
} finally {
  await db.close();
}
