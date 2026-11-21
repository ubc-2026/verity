import { randomUUID } from "node:crypto";
import { closeSync, linkSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
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
 * A lock left by a crashed process on the same host (its pid no longer exists) is taken over safely.
 * A lock from another host is never taken over automatically, because its liveness can't be checked:
 * stop that server, then delete the lock file by hand.
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
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (createLock(lockPath, mine)) return mine.token;
    const other = readLock(lockPath);
    if (!other) continue; // removed between our create and read: try again
    if (other.host !== mine.host || isAlive(other.pid)) {
      throw new LedgerLockedError(
        `ledger is already open for writing by pid ${other.pid} on ${other.host} (since ${other.startedAt}). ` +
          `Only one audit server may write it. If that server is stopped, delete ${lockPath}.`,
      );
    }
    takeOverStale(lockPath, other);
  }
  throw new LedgerLockedError(`could not take ${lockPath}; another process is starting on the same ledger, or the lock file is unreadable. If no audit server is running, delete it.`);
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
    writeFileSync(fd, JSON.stringify(info));
  } finally {
    closeSync(fd);
  }
  return true;
}

/**
 * Moves a dead process's lock aside. rename is atomic, so when several processes race only one moves it.
 * If what was moved is not the stale lock that was inspected (a live process replaced it in between),
 * it is linked back; link fails rather than overwrite if yet another lock appeared.
 */
function takeOverStale(lockPath: string, stale: LockInfo): void {
  const aside = `${lockPath}.stale-${process.pid}-${randomUUID()}`;
  try {
    renameSync(lockPath, aside);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return; // someone else moved it
    throw error;
  }
  const moved = readLock(aside);
  if (moved && moved.token !== stale.token) {
    try {
      linkSync(aside, lockPath);
    } catch {
      // another lock already exists; leave it in place
    }
  }
  try {
    unlinkSync(aside);
  } catch {
    // already gone
  }
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
