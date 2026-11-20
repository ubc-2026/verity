/**
 * Research schema migrations: db/research/NNNN_name.up.sql and .down.sql.
 *
 * Each migration is applied in one implicit transaction together with its
 * ledger row in research.schema_migrations. A migration whose recorded
 * checksum differs from the file is reported as drift and nothing is applied.
 * Checksums use LF line endings, so a Windows checkout (CRLF) and a Linux
 * checkout agree.
 */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { SqlDatabase } from "./sql.ts";

export const MIGRATIONS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "db", "research");

export interface Migration {
  version: string;
  name: string;
  up: string;
  down: string;
  checksum: string;
}

export interface MigrationState {
  version: string;
  name: string;
  checksum: string;
  state: "applied" | "pending" | "drift";
  appliedChecksum: string | null;
  appliedAt: string | null;
}

const lf = (text: string) => text.replace(/\r\n/g, "\n");

export function loadMigrations(dir = MIGRATIONS_DIR): Migration[] {
  const ups = readdirSync(dir).filter((f) => /^\d{4}_[a-z0-9_]+\.up\.sql$/.test(f)).sort();
  return ups.map((upFile) => {
    const [version, ...rest] = upFile.replace(/\.up\.sql$/, "").split("_");
    const up = lf(readFileSync(join(dir, upFile), "utf8"));
    const down = lf(readFileSync(join(dir, upFile.replace(/\.up\.sql$/, ".down.sql")), "utf8"));
    return { version: version!, name: rest.join("_"), up, down, checksum: "sha256:" + createHash("sha256").update(up, "utf8").digest("hex") };
  });
}

export async function migrationStatus(db: SqlDatabase, migrations = loadMigrations()): Promise<MigrationState[]> {
  const exists = await db.query<{ t: string | null }>("select to_regclass('research.schema_migrations')::text as t");
  const applied = new Map<string, { checksum: string; applied_at: string }>();
  if (exists.rows[0]?.t) {
    const rows = await db.query<{ version: string; checksum: string; applied_at: string }>(
      `select version, checksum, to_char(applied_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as applied_at
         from research.schema_migrations`,
    );
    for (const r of rows.rows) applied.set(r.version, r);
  }
  return migrations.map((m) => {
    const a = applied.get(m.version);
    return {
      version: m.version,
      name: m.name,
      checksum: m.checksum,
      state: !a ? "pending" : a.checksum === m.checksum ? "applied" : "drift",
      appliedChecksum: a?.checksum ?? null,
      appliedAt: a?.applied_at ?? null,
    };
  });
}

/** Applies every pending migration in order. Returns the versions applied. */
export async function applyMigrations(db: SqlDatabase, migrations = loadMigrations()): Promise<string[]> {
  const status = await migrationStatus(db, migrations);
  const drift = status.filter((s) => s.state === "drift");
  if (drift.length) throw new Error(`migration drift: ${drift.map((d) => d.version).join(", ")} changed after it was applied`);
  const done: string[] = [];
  for (const m of migrations) {
    if (status.find((s) => s.version === m.version)?.state === "applied") continue;
    if (!/^\d{4}$/.test(m.version) || !/^sha256:[0-9a-f]{64}$/.test(m.checksum)) throw new Error("bad migration id");
    await db.exec(
      `${m.up}\ninsert into research.schema_migrations (version, checksum) values ('${m.version}', '${m.checksum}') on conflict (version) do nothing;\n`,
    );
    done.push(m.version);
  }
  return done;
}

/** Runs one migration's down file. Destroys the data that migration created. */
export async function rollbackMigration(db: SqlDatabase, version: string, migrations = loadMigrations()): Promise<void> {
  const m = migrations.find((x) => x.version === version);
  if (!m) throw new Error(`unknown migration ${version}`);
  await db.exec(m.down);
}
