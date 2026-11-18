/**
 * QuickNode reconciliation for one settled purchase.
 *   npm run quicknode:backfill            stream config + local signed delivery and replay
 *   npm run quicknode:backfill -- --create   also create the live stream (needs credentials)
 *
 * Local delivery: block 72781628 and its receipts are fetched from Arc Testnet
 * RPC, shaped as a QuickNode block_with_receipts batch, passed through the same
 * filter the stream runs, signed with the QuickNode HMAC scheme, and POSTed to
 * the real webhook handler over HTTP. It is NOT delivered by QuickNode.
 *
 * Optional env (or .env.quicknode, gitignored): QUICKNODE_API_KEY,
 * VERITY_QN_SECURITY_TOKEN, VERITY_WEBHOOK_URL, QUICKNODE_ARC_TESTNET_SLUG.
 */
import { createHash, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { createPublicClient, http, toHex } from "viem";
import { arcTestnet } from "viem/chains";
import { PaymentStore } from "../src/payments/store.ts";
import { ReconciliationLedger } from "../src/reconciliation/ledger.ts";
import { signQuickNodePayload } from "../src/reconciliation/quicknodeSignature.ts";
import { runStreamFilter } from "../src/reconciliation/runFilter.ts";
import { backfillStreamBody } from "../src/reconciliation/streamConfig.ts";
import { createQuickNodeWebhookHandler, QUICKNODE_WEBHOOK_PATH } from "../src/reconciliation/webhook.ts";

if (existsSync(".env.quicknode")) process.loadEnvFile(".env.quicknode");

const BLOCK = 72781628;
const TX = "0xe3a6642f57e846526ac9a349f13c16cb11880e982f07ebcaeb9be90957abb4b0";
const PURCHASE_ID = "purchase-arc-1794970282";
const slug = process.env.QUICKNODE_ARC_TESTNET_SLUG ?? "arc-testnet";
const providedToken = process.env.VERITY_QN_SECURITY_TOKEN;
const securityToken = providedToken ?? randomBytes(32).toString("hex");
const webhookUrl = process.env.VERITY_WEBHOOK_URL ?? `https://<public-host>${QUICKNODE_WEBHOOK_PATH}`;

// 1. Stream configuration.
const config = backfillStreamBody({ network: slug, block: BLOCK, txHashes: [TX], webhookUrl, securityToken });
const filterText = Buffer.from(config.filter_function, "base64").toString("utf8");
console.log("== QuickNode stream configuration (POST https://api.quicknode.com/streams/rest/v1/streams) ==");
console.log(
  JSON.stringify(
    {
      ...config,
      filter_function: `<base64 of quicknode/verity-usdc-filter.js with TARGET_TX_HASHES=[${TX}]; sha256 ${createHash("sha256").update(filterText).digest("hex")}>`,
      destination_attributes: { ...config.destination_attributes, security_token: "<redacted>" },
    },
    null,
    2,
  ),
);

const liveBlockers: string[] = [];
if (!process.env.QUICKNODE_API_KEY) liveBlockers.push("QUICKNODE_API_KEY is not set");
if (!process.env.VERITY_WEBHOOK_URL) liveBlockers.push("VERITY_WEBHOOK_URL (public HTTPS URL ending in /webhooks/quicknode) is not set");
if (!providedToken) liveBlockers.push("VERITY_QN_SECURITY_TOKEN is not set (using an ephemeral local token below)");
if (!process.env.QUICKNODE_ARC_TESTNET_SLUG) liveBlockers.push(`network slug "${slug}" is unconfirmed; set QUICKNODE_ARC_TESTNET_SLUG from GET /streams or the dashboard`);

if (process.argv.includes("--create")) {
  if (liveBlockers.length > 0) {
    console.log("\nLIVE STREAM NOT CREATED:");
    for (const blocker of liveBlockers) console.log(`  - ${blocker}`);
  } else {
    const response = await fetch("https://api.quicknode.com/streams/rest/v1/streams", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": process.env.QUICKNODE_API_KEY! },
      body: JSON.stringify(config),
    });
    console.log(`\ncreate stream -> HTTP ${response.status}: ${(await response.text()).slice(0, 500)}`);
  }
} else {
  console.log(`\nlive stream: not requested${liveBlockers.length ? `; blockers: ${liveBlockers.join("; ")}` : ""}`);
}

// 2. Rebuild the backfill batch from Arc RPC in block_with_receipts shape.
const client = createPublicClient({ chain: arcTestnet, transport: http(process.env.ARC_RPC_URL) });
const blockHex = toHex(BLOCK);
const [block, receipts] = await Promise.all([
  client.request({ method: "eth_getBlockByNumber", params: [blockHex, true] }),
  client.request({ method: "eth_getBlockReceipts" as never, params: [blockHex] as never }) as Promise<unknown[]>,
]);
const metadata = {
  stream_id: "local-backfill-replay",
  stream_name: config.name,
  network: slug,
  dataset: "block_with_receipts",
  start_range: BLOCK,
  end_range: BLOCK,
  batch_start_range: BLOCK,
  batch_end_range: BLOCK,
  keep_distance_from_tip: 0,
  reorgs: null,
  blocks_reorged: null,
};
const filtered = runStreamFilter({ data: [{ block, receipts }], metadata }, [TX]);
if (!filtered) throw new Error("filter dropped the target transaction");
const payload = JSON.stringify(filtered);
console.log(`\n== Local delivery (Arc RPC data, QuickNode format, signed locally; NOT delivered by QuickNode) ==`);
console.log(`block ${BLOCK}: ${(receipts as unknown[]).length} receipts in, ${(filtered as { matches: unknown[] }).matches.length} match out`);

// 3. Real webhook handler over HTTP against the purchase database.
const store = new PaymentStore(process.env.VERITY_DB ?? ".verity/payments.sqlite");
if (!store.get(PURCHASE_ID)) throw new Error(`${PURCHASE_ID} is not in the local purchase database`);
const ledger = new ReconciliationLedger(store);
const handler = createQuickNodeWebhookHandler({
  securityToken,
  ledger,
  finalizedBlock: async () => BigInt((await client.request({ method: "eth_getBlockByNumber", params: ["finalized", false] }))!.number!),
  now: () => Math.floor(Date.now() / 1000),
  source: "local-replay:arc-rpc-in-quicknode-block_with_receipts-format",
});
const server = createServer((req, res) => void handler(req, res));
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}${QUICKNODE_WEBHOOK_PATH}`;

async function deliver(label: string, body: string, token = securityToken) {
  const nonce = randomBytes(16).toString("hex");
  const timestamp = String(Math.floor(Date.now() / 1000));
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-qn-nonce": nonce,
      "x-qn-timestamp": timestamp,
      "x-qn-signature": signQuickNodePayload(token, nonce, timestamp, body),
      "stream-id": metadata.stream_id,
      "batch-start-range": String(BLOCK),
      "batch-end-range": String(BLOCK),
    },
    body,
  });
  const json = (await response.json()) as { duplicateEvent?: boolean; outcomes?: Array<{ kind: string }>; error?: string };
  const summary = json.error ?? `duplicateEvent=${json.duplicateEvent} outcomes=${json.outcomes?.map((o) => o.kind).join(",")}`;
  console.log(`${label.padEnd(22)} HTTP ${response.status}  ${summary}  ${JSON.stringify(ledger.counts())}`);
  return response.status;
}

const before = ledger.counts();
const reservationBefore = store.reservation(PURCHASE_ID)?.status;
console.log(`before                 reservation=${reservationBefore} ${JSON.stringify(before)}`);
const s1 = await deliver("delivery", payload);
const s2 = await deliver("replay (new nonce)", payload);
const s3 = await deliver("replay (again)", payload);
const s5 = await deliver("wrong security token", payload, randomBytes(32).toString("hex"));
// Signature computed over the genuine payload, body altered in transit.
const nonce = "n";
const ts = "1";
const forged = await fetch(url, {
  method: "POST",
  headers: { "x-qn-nonce": nonce, "x-qn-timestamp": ts, "x-qn-signature": signQuickNodePayload(securityToken, nonce, ts, payload) },
  body: payload.replace(TX.slice(-4), "beef"),
});
console.log(`${"body/signature differ".padEnd(22)} HTTP ${forged.status}  ${JSON.stringify(ledger.counts())}`);
server.close();

const settlement = ledger.settlement(PURCHASE_ID);
const after = ledger.counts();
console.log(`\n== Ledger record ==\n${JSON.stringify(settlement, null, 2)}`);
console.log(`authorization=${store.get(PURCHASE_ID)?.status} reservation=${store.reservation(PURCHASE_ID)?.status}`);
const settlementsForPurchase = settlement ? 1 : 0;
const ok =
  s1 === 200 && s2 === 200 && s3 === 200 && s5 === 401 && forged.status === 401 &&
  settlementsForPurchase === 1 && after.settlements - before.settlements <= 1 &&
  store.reservation(PURCHASE_ID)?.status === "spent" && settlement?.settlementStatus === "confirmed" && settlement.deliveryStatus === "pending";
console.log(ok ? "\nRECONCILED SETTLEMENT: one record, reservation spent, delivery pending" : "\nRECONCILIATION CHECK FAILED");
store.close();
process.exitCode = ok ? 0 : 1;
