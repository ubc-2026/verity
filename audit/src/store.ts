import { randomUUID } from "node:crypto";
import { closeSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { dirname } from "node:path";
import { Ledger, type LedgerOptions, type LedgerState } from "./ledger.ts";

/**
 * One writer per ledger file, enforced here.
 *
 * Webhook replay protection reads receipts from this process's in-memory ledger, so two processes writing
 * the same file could each accept the same delivery. openLedger therefore takes an exclusive lock file
 * (`<ledger>.lock`, created with O_EXCL) before loading, and every save first checks the lock still belongs
 * to this process. A second server on the same file fails at startup with LedgerLockedError.
 *
 * The lock is never taken over automatically, not even when its pid looks dead. Moving or deleting a lock
 * file is not atomic with the check that it is stale, so two servers recovering from the same crash could
 * each remove a lock the other had just created. Only the owner (on exit) or an operator (after confirming
 * no audit server is running on this ledger) removes it. With no other remover, the token check before
 * each save is a backstop: it catches a lock deleted by hand while its server was still running.
 */
export class LedgerLockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LedgerLockedError";
  }
}

interface LockInfo {
  token: string;
  pid: number;
  host: string;
  startedAt: string;
}

const held = new WeakMap<Ledger, { lockPath: string; token: string; release: () => void }>();

export function openLedger(path: string, options: LedgerOptions = {}): Ledger {
  mkdirSync(dirname(path), { recursive: true });
  const lockPath = `${path}.lock`;
  const token = acquireLock(lockPath);

  let loaded: LedgerState | undefined;
  try {
    loaded = JSON.parse(readFileSync(path, "utf8")) as LedgerState;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      releaseLock(lockPath, token);
      throw error;
    }
  }

  let ledger!: Ledger;
  ledger = new Ledger(loaded, options, () => {
    // Fencing: never write after another process has taken the lock.
    const current = readLock(lockPath);
    if (current?.token !== token) {
      throw new LedgerLockedError(`refusing to save ${path}: this process no longer holds ${lockPath}`);
    }
    const temporary = `${path}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(ledger.snapshot(), null, 2)}\n`);
    renameSync(temporary, path);
  });

  const release = () => releaseLock(lockPath, token);
  process.once("exit", release);
  held.set(ledger, { lockPath, token, release });
  return ledger;
}

/** Releases the writer lock taken by openLedger. Safe to call more than once. */
export function closeLedger(ledger: Ledger): void {
  const entry = held.get(ledger);
  if (!entry) return;
  held.delete(ledger);
  process.removeListener("exit", entry.release);
  entry.release();
}

function acquireLock(lockPath: string): string {
  const mine: LockInfo = { token: randomUUID(), pid: process.pid, host: hostname(), startedAt: new Date().toISOString() };
  if (createLock(lockPath, mine)) return mine.token;
  throw new LedgerLockedError(describeHolder(lockPath, readLock(lockPath), mine.host));
}

function describeHolder(lockPath: string, other: LockInfo | null, host: string): string {
  const cleanup = `If no audit server is running on this ledger, delete ${lockPath} and start again.`;
  if (!other) {
    return `${lockPath} exists but can't be read (a server may be starting, or one crashed while creating it). ${cleanup}`;
  }
  const holder = `ledger is already open for writing by pid ${other.pid} on ${other.host} (since ${other.startedAt}). Only one audit server may write it.`;
  if (other.host === host && !isAlive(other.pid)) {
    return `${holder} No process with pid ${other.pid} is running on this host, so the server probably crashed. ${cleanup}`;
  }
  return `${holder} ${cleanup}`;
}

function createLock(lockPath: string, info: LockInfo): boolean {
  let fd: number;
  try {
    fd = openSync(lockPath, "wx");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  }
  try {
    // If this write fails the lock stays (unreadable) for an operator to remove, like any other leftover lock.
    writeFileSync(fd, JSON.stringify(info));
  } finally {
    closeSync(fd);
  }
  return true;
}

function releaseLock(lockPath: string, token: string): void {
  if (readLock(lockPath)?.token !== token) return; // never delete another process's lock
  try {
    unlinkSync(lockPath);
  } catch {
    // already gone
  }
}

function readLock(lockPath: string): LockInfo | null {
  try {
    const parsed = JSON.parse(readFileSync(lockPath, "utf8")) as Partial<LockInfo>;
    if (typeof parsed.token !== "string" || typeof parsed.pid !== "number" || typeof parsed.host !== "string") return null;
    return parsed as LockInfo;
  } catch {
    return null;
  }
}

function isAlive(pid: number): boolean {
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
