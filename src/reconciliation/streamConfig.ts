import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const FILTER_PATH = fileURLToPath(new URL("../../quicknode/verity-usdc-filter.js", import.meta.url));

/** Filter source with an optional transaction allowlist baked in. */
export function filterSource(targetTxHashes: string[] = []): string {
  const source = readFileSync(FILTER_PATH, "utf8");
  const list = JSON.stringify(targetTxHashes.map((hash) => hash.toLowerCase()));
  const replaced = source.replace("var TARGET_TX_HASHES = [];", `var TARGET_TX_HASHES = ${list};`);
  if (targetTxHashes.length > 0 && replaced === source) throw new Error("filter template marker not found");
  return replaced;
}

export interface BackfillStreamOptions {
  /** QuickNode network slug for Arc Testnet. UNCONFIRMED: check GET /streams or the dashboard. */
  network: string;
  block: number;
  txHashes: string[];
  webhookUrl: string;
  securityToken: string;
}

/**
 * Body for POST https://api.quicknode.com/streams/rest/v1/streams (header x-api-key).
 * One-block historical backfill of block_with_receipts, filtered to our tx.
 */
export function backfillStreamBody(options: BackfillStreamOptions) {
  return {
    name: `verity-arc-usdc-backfill-${options.block}`,
    network: options.network,
    dataset: "block_with_receipts",
    region: "usa_east",
    start_range: options.block,
    end_range: options.block,
    dataset_batch_size: 1,
    elastic_batch_enabled: false,
    keep_distance_from_tip: 0,
    filter_function: Buffer.from(filterSource(options.txHashes), "utf8").toString("base64"),
    destination: "webhook",
    destination_attributes: {
      url: options.webhookUrl,
      compression: "none",
      max_retry: 3,
      retry_interval_sec: 1,
      post_timeout_sec: 30,
      security_token: options.securityToken,
    },
    status: "active",
  };
}
