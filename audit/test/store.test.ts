// One writer per ledger file: openLedger's exclusive lock, stale-lock recovery and save fencing.
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

test("separate processes racing to open the same ledger: exactly one becomes the writer", async () => {
  const { path, cleanup } = workspace();
  const store = pathToFileURL(join(import.meta.dirname, "../src/store.ts")).href;
  const script = `import { openLedger } from ${JSON.stringify(store)};
    try { openLedger(${JSON.stringify(path)}); console.log("writer"); setTimeout(() => {}, 1500); }
    catch (e) { console.log(e.name); }`;
  const run = () =>
    new Promise<string>((resolve, reject) => {
      const child = spawn(process.execPath, ["--input-type=module", "-e", script]);
      let out = "";
      child.stdout.on("data", (chunk) => (out += chunk));
      child.on("error", reject);
      child.on("exit", () => resolve(out.trim()));
    });
  try {
    const results = await Promise.all([run(), run(), run(), run()]);
    assert.equal(results.filter((r) => r === "writer").length, 1, results.join(","));
    assert.equal(results.filter((r) => r === "LedgerLockedError").length, 3, results.join(","));
    assert.equal(existsSync(`${path}.lock`), false, "the writer's lock is released when it exits");
  } finally {
    cleanup();
  }
});

test("a lock left by a crashed process on this host is taken over", () => {
  const { path, cleanup } = workspace();
  try {
    writeFileSync(`${path}.lock`, JSON.stringify({ token: "old", pid: deadPid(), host: hostname(), startedAt: "2026-01-01T00:00:00Z" }));
    const ledger = openLedger(path);
    assert.equal(JSON.parse(readFileSync(`${path}.lock`, "utf8")).pid, process.pid);
    closeLedger(ledger);
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
