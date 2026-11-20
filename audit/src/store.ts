import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { Ledger, type LedgerOptions, type LedgerState } from "./ledger.ts";

export function openLedger(path: string, options: LedgerOptions = {}): Ledger {
  let loaded: LedgerState | undefined;
  try {
    loaded = JSON.parse(readFileSync(path, "utf8")) as LedgerState;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  let ledger!: Ledger;
  ledger = new Ledger(loaded, options, () => {
    mkdirSync(dirname(path), { recursive: true });
    const temporary = `${path}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(ledger.snapshot(), null, 2)}\n`);
    renameSync(temporary, path);
  });
  return ledger;
}
