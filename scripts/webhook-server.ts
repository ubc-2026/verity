/**
 * Persistent receiver for QuickNode Streams: serves the existing
 * POST /webhooks/quicknode handler on 127.0.0.1 for a Cloudflare tunnel.
 *   npm run webhook:serve
 *
 * Env (or .env.quicknode): VERITY_QN_SECURITY_TOKEN (required), PORT (8787),
 * VERITY_DB (.verity/payments.sqlite), ARC_RPC_URL, VERITY_QN_MAX_SKEW_SECONDS (300; 0 turns the
 * timestamp window off).
 * Each accepted delivery is logged to stdout and .verity/quicknode-deliveries.log.
 */
import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { createServer } from "node:http";
import { createPublicClient, http } from "viem";
import { arcTestnet } from "viem/chains";
import { PaymentStore } from "../src/payments/store.ts";
import { ReconciliationLedger } from "../src/reconciliation/ledger.ts";
import { createQuickNodeWebhookHandler } from "../src/reconciliation/webhook.ts";

if (existsSync(".env.quicknode")) process.loadEnvFile(".env.quicknode");
const securityToken = process.env.VERITY_QN_SECURITY_TOKEN;
const liveRunId = process.env.VERITY_ARC_LIVE_RUN_ID;
if (!securityToken || securityToken.length < 32) {
  console.error("VERITY_QN_SECURITY_TOKEN missing or shorter than 32 chars; run `npm run quicknode:token`.");
  process.exit(2);
}

mkdirSync(".verity", { recursive: true });
const logFile = ".verity/quicknode-deliveries.log";
const store = new PaymentStore(process.env.VERITY_DB ?? ".verity/payments.sqlite");
const ledger = new ReconciliationLedger(store);
const maxSkew = Number(process.env.VERITY_QN_MAX_SKEW_SECONDS ?? 300);
const client = createPublicClient({ chain: arcTestnet, transport: http(process.env.ARC_RPC_URL) });
const handler = createQuickNodeWebhookHandler({
  securityToken,
  ledger,
  finalizedBlock: async () => BigInt((await client.request({ method: "eth_getBlockByNumber", params: ["finalized", false] }))!.number!),
  now: () => Math.floor(Date.now() / 1000),
  source: "quicknode-streams",
  // Replay window: a signed delivery is refused when X-QN-Timestamp is further than this from now.
  ...(maxSkew > 0 ? { maxTimestampSkewSeconds: maxSkew } : {}),
});

const server = createServer(async (req, res) => {
  if (req.method === "GET" && req.url === "/healthz") {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify({ ok: true, ...(liveRunId ? { runId: liveRunId } : {}) }));
  }
  const started = new Date().toISOString();
  try {
    const result = await handler(req, res);
    const entry = {
      at: started,
      status: res.statusCode,
      streamId: req.headers["stream-id"] ?? null,
      batch: [req.headers["batch-start-range"] ?? null, req.headers["batch-end-range"] ?? null],
      eventId: result?.eventId ?? null,
      duplicateEvent: result?.duplicateEvent ?? null,
      outcomes: result?.outcomes ?? null,
      counts: ledger.counts(),
    };
    console.log(JSON.stringify(entry));
    appendFileSync(logFile, `${JSON.stringify(entry)}\n`);
  } catch (error) {
    console.error(`${started} handler error: ${(error as Error).message}`);
    if (!res.headersSent) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end('{"error":"internal"}');
    }
  }
});

const port = Number(process.env.PORT ?? 8787);
server.listen(port, "127.0.0.1", () => console.log(`QuickNode receiver on http://127.0.0.1:${port}/webhooks/quicknode (health: /healthz)`));
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => server.close(() => (store.close(), process.exit(0))));
}
