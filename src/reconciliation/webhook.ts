import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { gunzipSync } from "node:zlib";
import type { IngestResult, ReconciliationLedger, StreamMatch } from "./ledger.ts";
import { verifyQuickNodeSignature } from "./quicknodeSignature.ts";

export const QUICKNODE_WEBHOOK_PATH = "/webhooks/quicknode";
const MAX_BODY_BYTES = 10 * 1024 * 1024;

export interface WebhookDeps {
  securityToken: string;
  ledger: ReconciliationLedger;
  /** Chain finalized height; Arc has deterministic finality. */
  finalizedBlock(): Promise<bigint>;
  now(): number;
  /** Ledger source label. Defaults to "quicknode-streams". */
  source?: string;
  /** Refuse signed deliveries whose X-QN-Timestamp is further than this from now(). Live ingestion sets it. */
  maxTimestampSkewSeconds?: number;
}

const header = (req: IncomingMessage, name: string) => {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
};

function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new Error("body too large");
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

/** Accepts the filter output directly, or wrapped as { data, metadata }. */
export function extractMatches(body: unknown): { matches: StreamMatch[]; metadata: Record<string, unknown> | null } {
  const root = body as Record<string, any> | null;
  const filtered = root?.matches ? root : root?.data?.matches ? root.data : null;
  if (!filtered || !Array.isArray(filtered.matches)) return { matches: [], metadata: root?.metadata ?? null };
  return { matches: filtered.matches as StreamMatch[], metadata: filtered.metadata ?? root?.metadata ?? null };
}

/**
 * POST /webhooks/quicknode. Authenticates the QuickNode HMAC over the decoded
 * body, persists the event, and reconciles matches, all before returning 2xx.
 */
export function createQuickNodeWebhookHandler(deps: WebhookDeps) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<IngestResult | undefined> => {
    if (req.method !== "POST" || req.url !== QUICKNODE_WEBHOOK_PATH) return void send(res, 404, { error: "not found" });

    let raw: Buffer;
    try {
      raw = await readBody(req);
      if (/gzip/i.test(header(req, "content-encoding") ?? "")) raw = gunzipSync(raw, { maxOutputLength: MAX_BODY_BYTES });
    } catch (error) {
      return void send(res, 400, { error: (error as Error).message });
    }
    const payload = raw.toString("utf8");

    const authentic = verifyQuickNodeSignature(deps.securityToken, {
      nonce: header(req, "x-qn-nonce"),
      timestamp: header(req, "x-qn-timestamp"),
      signature: header(req, "x-qn-signature"),
      payload,
    }, deps.maxTimestampSkewSeconds === undefined ? undefined : { now: deps.now(), maxSkewSeconds: deps.maxTimestampSkewSeconds });
    if (!authentic) return void send(res, 401, { error: "invalid QuickNode signature" });

    let body: unknown;
    try {
      body = JSON.parse(payload);
    } catch {
      return void send(res, 400, { error: "invalid JSON" });
    }

    const { matches, metadata } = extractMatches(body);
    const streamId = String(header(req, "stream-id") ?? metadata?.stream_id ?? "unknown");
    const batchStart = header(req, "batch-start-range") ?? metadata?.batch_start_range;
    const batchEnd = header(req, "batch-end-range") ?? metadata?.batch_end_range;
    // Same stream + same bytes = same event, regardless of nonce/timestamp on retries.
    const eventId = createHash("sha256").update(`${streamId}\n${payload}`).digest("hex");

    const result = deps.ledger.ingest({
      eventId,
      streamId,
      batchStart: batchStart === undefined || batchStart === null ? null : Number(batchStart),
      batchEnd: batchEnd === undefined || batchEnd === null ? null : Number(batchEnd),
      payload,
      matches,
      finalizedBlock: await deps.finalizedBlock(),
      now: deps.now(),
      source: deps.source,
    });
    send(res, 200, result);
    return result;
  };
}
