/**
 * One live NWS purchase on Decong's Arc path, then the QuickNode backfill
 * against that same transaction.
 *
 *   npm run arc:nws
 *
 * Uses samples/live/nws-nyc-261121.json and the Central Park contract unless
 * VERITY_NWS_EVIDENCE_FILE or VERITY_CONTRACT_ID is already set. Keys stay in
 * .env.arc-testnet. The purchase script exits 2 when the wallets are unfunded,
 * and this script does not run the backfill in that case.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

const evidenceFile = process.env.VERITY_NWS_EVIDENCE_FILE ?? "samples/live/nws-nyc-261121.json";
const contractId = process.env.VERITY_CONTRACT_ID ?? "GEMI-WXHIGH-NYC-2611210459-66TO67";
if (!existsSync(evidenceFile)) {
  console.log(`BLOCKED. Evidence file not found: ${evidenceFile}`);
  process.exit(2);
}

const env = { ...process.env, VERITY_NWS_EVIDENCE_FILE: evidenceFile, VERITY_CONTRACT_ID: contractId };
const purchase = spawnSync(process.execPath, ["scripts/arc-purchase.ts"], { stdio: "inherit", env });
if ((purchase.status ?? 1) !== 0) process.exit(purchase.status ?? 1);

const backfill = spawnSync(process.execPath, ["scripts/quicknode-backfill.ts"], { stdio: "inherit", env });
process.exit(backfill.status ?? 1);
