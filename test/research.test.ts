/**
 * Research store on embedded Postgres (PGlite), plus restart persistence, the
 * app server's research API across a restart, and the payments boundary.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { ingestFixtureSlice } from "../src/research/ingest.ts";
import { applyMigrations } from "../src/research/migrate.ts";
import { loadFixtureSlice } from "../src/research/runtime.ts";
import { openPglite } from "../src/research/sql.ts";
import { ResearchStore } from "../src/research/store.ts";
import { ROOT, researchSuite } from "./research.shared.ts";

researchSuite("PGlite", async () => {
  const owner = await openPglite();
  return { owner, close: () => owner.close() };
});

const NOW = Date.parse("2026-11-20T03:00:00Z");

describe("research history across restarts", () => {
  it("survives closing and reopening the database directory, and a replay adds nothing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "verity-research-"));
    try {
      const { slice, captures } = loadFixtureSlice(ROOT);
      let db = await openPglite(dir);
      await applyMigrations(db);
      const first = await ingestFixtureSlice(new ResearchStore({ read: db, ingest: db }), slice, captures);
      const before = await new ResearchStore({ read: db }).instrumentDetail(first.key, NOW);
      await db.close();

      db = await openPglite(dir);
      assert.deepEqual(await applyMigrations(db), [], "already migrated");
      const store = new ResearchStore({ read: db, ingest: db });
      const after = await store.instrumentDetail(first.key, NOW);
      assert.deepEqual(after, before);
      const replay = await ingestFixtureSlice(store, slice, captures);
      assert.deepEqual([replay.quotes.inserted, replay.sources.inserted, replay.assessments.inserted], [0, 0, 0]);
      assert.equal((await store.instrumentDetail(first.key, NOW))!.market.history.length, 3);
      await db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  const python = process.env.VERITY_PYTHON;
  it("serves the same history from the app server after a restart", { skip: python ? false : "set VERITY_PYTHON to run the app server" }, async () => {
    const dir = mkdtempSync(join(tmpdir(), "verity-research-app-"));
    const port = await new Promise<number>((resolve) => {
      const s = createServer().listen(0, "127.0.0.1", () => {
        const p = (s.address() as { port: number }).port;
        s.close(() => resolve(p));
      });
    });
    const start = () =>
      new Promise<{ stop: () => Promise<void>; log: string }>((resolve, reject) => {
        const child = spawn(process.execPath, [join(ROOT, "scripts", "app-server.ts")], {
          env: { ...process.env, PORT: String(port), VERITY_RESEARCH_PGLITE_DIR: dir, VERITY_OPERATOR_TOKEN: "t".repeat(32) },
          stdio: ["ignore", "pipe", "pipe"],
        });
        let log = "";
        const timer = setTimeout(() => reject(new Error(`app server did not start: ${log}`)), 60_000);
        const onData = (b: Buffer) => {
          log += b.toString();
          if (/Research store: pglite/.test(log) && /Verity app API/.test(log)) {
            clearTimeout(timer);
            resolve({ log, stop: () => new Promise<void>((done) => { child.once("exit", () => done()); child.kill(); }) });
          }
        };
        child.stdout.on("data", onData);
        child.stderr.on("data", onData);
        child.once("exit", (code) => reject(new Error(`app server exited ${code}: ${log}`)));
      });
    const path = "/api/research/instruments/gemini/WXHIGH-NYC-2611190459/GEMI-WXHIGH-NYC-2611190459-62TO63";
    const read = async () => (await (await fetch(`http://127.0.0.1:${port}${path}`)).json()) as any;
    try {
      const a = await start();
      assert.match(a.log, /FIXTURE slice: \d+ new record/);
      const one = await read();
      assert.equal((await fetch(`http://127.0.0.1:${port}/api/research/instruments`, { method: "POST" })).status, 405);
      await a.stop();
      const b = await start();
      assert.match(b.log, /FIXTURE slice: 0 new record/, "the restart replays the slice and adds nothing");
      const two = await read();
      assert.deepEqual(two.market.history.map((q: any) => q.snapshotId), one.market.history.map((q: any) => q.snapshotId));
      assert.deepEqual(two.resolutionRisk.versions.map((v: any) => v.seq), [1, 2]);
      await b.stop();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("research service boundary", () => {
  it("has no path to payment signing, spending or the payment ledger", () => {
    const dir = join(ROOT, "src", "research");
    const files = readdirSync(dir).filter((f) => f.endsWith(".ts"));
    assert.ok(files.length >= 8);
    for (const f of files) {
      const text = readFileSync(join(dir, f), "utf8");
      assert.doesNotMatch(text, /from "(\.\.\/payments|viem|@x402|@circle-fin)/, `${f} imports payment code`);
      assert.doesNotMatch(text, /VERITY_ENV_FILE|PRIVATE_KEY|privateKey|signTypedData|\.sqlite/i, `${f} touches keys or the SQLite ledger`);
    }
    for (const f of ["research-migrate.ts", "research-ingest.ts", "research-capture.ts"]) {
      const text = readFileSync(join(ROOT, "scripts", f), "utf8");
      assert.doesNotMatch(text, /src\/payments|loadEnvFile\(process\.env\.VERITY_ENV_FILE/, `${f} reaches payment code or the payment env file`);
    }
  });
});
