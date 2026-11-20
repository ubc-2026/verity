/**
 * Postgres access for the research store. One interface, two drivers:
 *
 * - PGlite (embedded Postgres compiled to WASM) for local and fixture use. No
 *   server and no credentials. With a data directory, history survives a
 *   restart.
 * - node-postgres for a real server (local Docker, or the Supabase project
 *   once it is reviewed). Connection strings come from server-side
 *   configuration only and are never logged.
 *
 * Every query takes positional parameters ($1, $2, ...). Callers never build
 * SQL from input.
 */
import { PGlite } from "@electric-sql/pglite";
import pg from "pg";

export interface Queryable {
  query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<{ rows: T[] }>;
}

export interface SqlDatabase extends Queryable {
  readonly driver: "pglite" | "postgres";
  /** Several statements in one call, without parameters. Migrations only. */
  exec(sql: string): Promise<void>;
  transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export const INGEST_ROLE = "verity_research_ingest";
export const READER_ROLE = "verity_research_reader";
export type ResearchRole = typeof INGEST_ROLE | typeof READER_ROLE;

type RawQuery = (text: string, params: unknown[]) => Promise<{ rows: unknown[] }>;
const wrap = (run: RawQuery): Queryable => ({
  async query<T>(text: string, params: unknown[] = []) {
    return { rows: (await run(text, params)).rows as T[] };
  },
});

/** Opens embedded Postgres. Without a directory the database lives in memory. */
export async function openPglite(dataDir?: string): Promise<SqlDatabase> {
  const db = dataDir ? new PGlite(dataDir) : new PGlite();
  await db.waitReady;
  const q = wrap((text, params) => db.query(text, params));
  return {
    driver: "pglite",
    query: q.query,
    async exec(sql) {
      await db.exec(sql);
    },
    transaction: (fn) => db.transaction((tx) => fn(wrap((text, params) => tx.query(text, params)))),
    close: () => db.close(),
  };
}

/** Opens a pool on a real Postgres server. */
export async function openPostgres(connectionString: string, applicationName = "verity-research"): Promise<SqlDatabase> {
  const pool = new pg.Pool({
    connectionString,
    max: 4,
    application_name: applicationName,
    statement_timeout: 15_000,
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 10_000,
  });
  // An idle client that loses its connection must not crash the server. The
  // next query reports the failure to its caller.
  pool.on("error", () => {});
  const q = wrap((text, params) => pool.query(text, params));
  return {
    driver: "postgres",
    query: q.query,
    async exec(sql) {
      // A multi-statement simple query runs as one implicit transaction.
      await pool.query(sql);
    },
    async transaction(fn) {
      const client = await pool.connect();
      try {
        await client.query("begin");
        const out = await fn(wrap((text, params) => client.query(text, params)));
        await client.query("commit");
        return out;
      } catch (error) {
        await client.query("rollback").catch(() => {});
        throw error;
      } finally {
        client.release();
      }
    },
    close: () => pool.end(),
  };
}

/**
 * Runs fn in one transaction under a research role, so the database checks
 * its grants even when the login is broader. Reader transactions are also
 * read-only.
 */
export function asRole<T>(db: SqlDatabase, role: ResearchRole, fn: (tx: Queryable) => Promise<T>): Promise<T> {
  if (role !== INGEST_ROLE && role !== READER_ROLE) throw new Error("unknown research role");
  return db.transaction(async (tx) => {
    if (role === READER_ROLE) await tx.query("set transaction read only");
    await tx.query(`set local role ${role}`);
    return fn(tx);
  });
}
