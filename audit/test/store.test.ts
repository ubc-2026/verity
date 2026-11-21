// One writer per ledger file: openLedger's exclusive lock, manual-only stale-lock cleanup and save fencing.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { closeLedger, LedgerLockedError, openLedger } from "../src/store.ts";
import { purchase, word } from "./fixture.ts";

function workspace() {
  const dir = mkdtempSync(join(tmpdir(), "audit-store-"));
  return { dir, path: join(dir, "ledger.json"), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const deadPid = () => spawnSync(process.execPath, ["-e", ""]).pid!;

test("a second writer on the same ledger is refused until the first closes", () => {
  const { path, cleanup } = workspace();
  try {
    const first = openLedger(path);
    assert.throws(() => openLedger(path), LedgerLockedError);
    closeLedger(first);
    assert.equal(existsSync(`${path}.lock`), false, "closing removes the lock");
    closeLedger(openLedger(path));
  } finally {
    cleanup();
  }
});

// Runs `count` Node processes at once. Each tries to open the ledger; the writer saves a purchase and
// then reports the pid recorded in the lock file after that save.
function race(path: string, count: number): Promise<string[]> {
  const store = pathToFileURL(join(import.meta.dirname, "../src/store.ts")).href;
  const fixture = pathToFileURL(join(import.meta.dirname, "fixture.ts")).href;
  const script = `import { readFileSync } from "node:fs";
    import { openLedger } from ${JSON.stringify(store)};
    import { purchase } from ${JSON.stringify(fixture)};
    try {
      const ledger = openLedger(${JSON.stringify(path)});
      ledger.registerPurchase(purchase());
      const owner = JSON.parse(readFileSync(${JSON.stringify(path + ".lock")}, "utf8")).pid;
      console.log(owner === process.pid ? "writer" : "lost-lock");
      setTimeout(() => {}, 1500);
    } catch (e) { console.log(e.name); }`;
  const run = () =>
    new Promise<string>((resolve, reject) => {
      const child = spawn(process.execPath, ["--input-type=module", "-e", script]);
      let out = "";
      child.stdout.on("data", (chunk) => (out += chunk));
      child.on("error", reject);
      child.on("exit", () => resolve(out.trim()));
    });
  return Promise.all(Array.from({ length: count }, run));
}

const tally = (results: string[], value: string) => results.filter((r) => r === value).length;

test("separate processes racing to open the same ledger: exactly one becomes the writer and keeps the lock through a save", async () => {
  const { path, cleanup } = workspace();
  try {
    const results = await race(path, 4);
    assert.equal(tally(results, "writer"), 1, results.join(","));
    assert.equal(tally(results, "LedgerLockedError"), 3, results.join(","));
    assert.equal(existsSync(`${path}.lock`), false, "the writer's lock is released when it exits");
    assert.equal(JSON.parse(readFileSync(path, "utf8")).purchases.length, 1, "the writer's save is on disk");
  } finally {
    cleanup();
  }
});

test("a lock left by a crashed process on this host is never taken over; the error says how to recover", () => {
  const { path, cleanup } = workspace();
  try {
    const stale = JSON.stringify({ token: "old", pid: deadPid(), host: hostname(), startedAt: "2026-01-01T00:00:00Z" });
    writeFileSync(`${path}.lock`, stale);
    assert.throws(() => openLedger(path), (error: Error) => {
      assert.ok(error instanceof LedgerLockedError);
      assert.match(error.message, /probably crashed/);
      assert.match(error.message, /delete .*ledger.json.lock/);
      return true;
    });
    assert.equal(readFileSync(`${path}.lock`, "utf8"), stale, "the stale lock is left exactly as it was");
    assert.equal(existsSync(path), false, "nothing was written");
  } finally {
    cleanup();
  }
});

test("concurrent crash recovery: servers restarting together never remove a lock, and after manual cleanup one writer wins and keeps it", async () => {
  const { path, cleanup } = workspace();
  try {
    const stale = JSON.stringify({ token: "old", pid: deadPid(), host: hostname(), startedAt: "2026-01-01T00:00:00Z" });
    writeFileSync(`${path}.lock`, stale);
    const blocked = await race(path, 4);
    assert.equal(tally(blocked, "LedgerLockedError"), 4, blocked.join(","));
    assert.equal(readFileSync(`${path}.lock`, "utf8"), stale, "no restarting server moved or replaced the stale lock");

    rmSync(`${path}.lock`); // the operator, after confirming no audit server is running
    const recovered = await race(path, 4);
    assert.equal(tally(recovered, "writer"), 1, recovered.join(","));
    assert.equal(tally(recovered, "lost-lock"), 0, recovered.join(","));
    assert.equal(tally(recovered, "LedgerLockedError"), 3, recovered.join(","));
  } finally {
    cleanup();
  }
});

test("an unreadable lock file (crash while creating it) is refused, not removed", () => {
  const { path, cleanup } = workspace();
  try {
    writeFileSync(`${path}.lock`, "");
    assert.throws(() => openLedger(path), /can't be read/);
    assert.equal(readFileSync(`${path}.lock`, "utf8"), "");
  } finally {
    cleanup();
  }
});

test("a lock from another host is never taken over automatically", () => {
  const { path, cleanup } = workspace();
  try {
    writeFileSync(`${path}.lock`, JSON.stringify({ token: "other", pid: deadPid(), host: "some-other-host", startedAt: "2026-01-01T00:00:00Z" }));
    assert.throws(() => openLedger(path), /some-other-host/);
    assert.equal(JSON.parse(readFileSync(`${path}.lock`, "utf8")).token, "other", "the other host's lock is untouched");
  } finally {
    cleanup();
  }
});

test("fencing: a writer that lost its lock refuses to save instead of overwriting the ledger", () => {
  const { path, cleanup } = workspace();
  try {
    const ledger = openLedger(path);
    ledger.registerPurchase(purchase());
    const saved = readFileSync(path, "utf8");
    writeFileSync(`${path}.lock`, JSON.stringify({ token: "usurper", pid: process.pid, host: hostname(), startedAt: "x" }));
    assert.throws(() => ledger.registerPurchase(purchase({ purchaseId: "purchase-2", nonce: word(77) })), LedgerLockedError);
    assert.equal(readFileSync(path, "utf8"), saved, "the file on disk is unchanged");
    closeLedger(ledger);
    assert.equal(JSON.parse(readFileSync(`${path}.lock`, "utf8")).token, "usurper", "close never deletes another writer's lock");
  } finally {
    cleanup();
  }
});
