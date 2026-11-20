import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createHash, timingSafeEqual } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { z } from "zod";
import { dashboardHtml, publicPurchase } from "./dashboard.ts";
import { Ledger, LedgerError, type Purchase } from "./ledger.ts";
import type { OverdueEvent } from "./overdue.ts";
import { PayloadError } from "./parse.ts";
import { verifyWebhook } from "./signature.ts";

const isoUtc = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/);
const bytes32 = z.string().regex(/^0x[0-9a-fA-F]{64}$/);

const purchaseSchema = z.strictObject({
  purchaseId: z.string(),
  requestHash: bytes32,
  nonce: bytes32,
  payer: z.string(),
  payTo: z.string(),
  amountBaseUnits: z.string(),
  token: z.string(),
  chainId: z.number().int(),
  merchantLabel: z.string(),
  deliveryDeadlineUtc: isoUtc,
  environment: z.enum(["fixture", "arc-testnet"]),
});

const deliverySchema = z.strictObject({
  ok: z.boolean(),
  detail: z.string().max(240).optional(),
  contentHash: bytes32.nullable().optional(),
});

export interface AuditServerOptions {
  ledger: Ledger;
  quicknodeSecret: string;
  readToken: string;
  writeToken: string;
  maxSkewSeconds?: number;
  now?: () => Date;
  sink?: (event: OverdueEvent) => Promise<void>;
  bodyLimit?: number;
  /** When false, POST /webhooks/quicknode does not emit overdue events itself. */
  sweepOnWebhook?: boolean;
  /** Forwards AuthorizationUsed tickets to the payment portal. Failures stay off the QuickNode response. */
  report?: (body: unknown) => Promise<void>;
}

export class AuditServer {
  readonly ledger: Ledger;
  readonly #secret: string;
  readonly #readToken: string;
  readonly #writeToken: string;
  readonly #maxSkewSeconds: number;
  readonly #now: () => Date;
  readonly #sink?: (event: OverdueEvent) => Promise<void>;
  readonly #bodyLimit: number;
  readonly #sweepOnWebhook: boolean;
  readonly #report?: (body: unknown) => Promise<void>;
  readonly http: Server;
  /** Nonces of signed deliveries already processed, with the time they can be forgotten (ms). */
  readonly #seenNonces = new Map<string, number>();

  constructor(options: AuditServerOptions) {
    this.ledger = options.ledger;
    this.#secret = options.quicknodeSecret;
    this.#readToken = options.readToken;
    this.#writeToken = options.writeToken;
    this.#maxSkewSeconds = options.maxSkewSeconds ?? 300;
    this.#now = options.now ?? (() => new Date());
    this.#sink = options.sink;
    this.#bodyLimit = options.bodyLimit ?? 8_000_000;
    this.#sweepOnWebhook = options.sweepOnWebhook ?? true;
    this.#report = options.report;
    this.http = createHttpServer((request, response) => {
      void this.#handle(request, response);
    });
  }

  listen(port: number, host = "127.0.0.1"): Promise<void> {
    return new Promise((resolve) => this.http.listen(port, host, () => resolve()));
  }

  close(): Promise<void> {
    return new Promise((resolve, reject) => this.http.close((error) => (error ? reject(error) : resolve())));
  }

  address(): { port: number } {
    const value = this.http.address();
    if (!value || typeof value === "string") throw new Error("server is not listening");
    return { port: value.port };
  }

  async sweep(): Promise<number> {
    const pending = this.ledger.collectOverdue(this.#now());
    if (!this.#sink) return 0;
    let sent = 0;
    for (const event of pending) {
      try {
        await this.#sink(event);
        this.ledger.acknowledge(event.purchaseId, event.eventId);
        sent += 1;
      } catch {
        continue;
      }
    }
    return sent;
  }

  async #handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      const url = new URL(request.url ?? "/", "http://localhost");
      const parts = url.pathname.split("/").filter(Boolean);
      if (request.method === "GET" && parts.length === 0) return this.#send(response, 200, dashboardHtml(), "text/html; charset=utf-8");
      if (request.method === "GET" && parts.length === 1 && parts[0] === "healthz") {
        return this.#send(response, 200, { ok: true });
      }
      if (request.method === "POST" && parts.length === 2 && parts[0] === "webhooks" && parts[1] === "quicknode") {
        return await this.#webhook(request, response);
      }
      if (request.method === "GET" && parts.length === 1 && parts[0] === "purchases") {
        if (!this.#bearer(request, this.#readToken)) return this.#send(response, 401, { error: "unauthorized" });
        return this.#send(response, 200, { purchases: this.ledger.list().map(publicPurchase) });
      }
      if (request.method === "GET" && parts.length === 2 && parts[0] === "purchases") {
        if (!this.#bearer(request, this.#readToken)) return this.#send(response, 401, { error: "unauthorized" });
        const view = this.ledger.view(pathId(parts[1]!));
        if (!view) return this.#send(response, 404, { error: "unknown purchase" });
        return this.#send(response, 200, publicPurchase(view));
      }
      if (request.method === "GET" && parts.length === 1 && parts[0] === "unmatched") {
        if (!this.#bearer(request, this.#readToken)) return this.#send(response, 401, { error: "unauthorized" });
        return this.#send(response, 200, { payments: this.ledger.unmatched() });
      }
      if (request.method === "POST" && parts.length === 1 && parts[0] === "purchases") {
        if (!this.#bearer(request, this.#writeToken)) return this.#send(response, 401, { error: "unauthorized" });
        const parsed = purchaseSchema.safeParse(await this.#json(request));
        if (!parsed.success) return this.#send(response, 400, { error: "invalid purchase" });
        this.ledger.registerPurchase(parsed.data as Purchase);
        return this.#send(response, 201, publicPurchase(this.ledger.view(parsed.data.purchaseId)!));
      }
      if (request.method === "POST" && parts.length === 3 && parts[0] === "purchases" && parts[2] === "delivery") {
        if (!this.#bearer(request, this.#writeToken)) return this.#send(response, 401, { error: "unauthorized" });
        const parsed = deliverySchema.safeParse(await this.#json(request));
        if (!parsed.success) return this.#send(response, 400, { error: "invalid delivery" });
        this.ledger.noteDelivery({
          purchaseId: pathId(parts[1]!),
          ok: parsed.data.ok,
          detail: parsed.data.detail ?? (parsed.data.ok ? "delivery verified" : "delivery rejected"),
          contentHash: parsed.data.contentHash ?? null,
          recordedAtUtc: this.#now().toISOString(),
        });
        return this.#send(response, 200, publicPurchase(this.ledger.view(pathId(parts[1]!))!));
      }
      if (request.method === "POST" && parts.length === 2 && parts[0] === "internal" && parts[1] === "sweep") {
        if (!this.#bearer(request, this.#writeToken)) return this.#send(response, 401, { error: "unauthorized" });
        const sent = await this.sweep();
        return this.#send(response, 200, { sent });
      }
      this.#send(response, 404, { error: "not found" });
    } catch (error) {
      if (error instanceof PayloadError || error instanceof LedgerError) {
        const status = error.message.includes("unknown purchase") ? 404 : error.message.includes("already") ? 409 : 400;
        return this.#send(response, status, { error: error.message });
      }
      if (error instanceof HttpError) return this.#send(response, error.status, { error: error.message });
      return this.#send(response, 500, { error: "internal error" });
    }
  }

  async #webhook(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const nonce = header(request, "x-qn-nonce");
    const timestamp = header(request, "x-qn-timestamp");
    const signature = header(request, "x-qn-signature");
    if (!nonce || !timestamp || !signature) {
      // QuickNode's Check Connection probe has no HMAC headers. Real deliveries always do.
      // The body is not read, so an unsigned request cannot make the server decompress anything.
      return this.#send(response, 200, { ok: true, check: true });
    }
    const payload = (await this.#raw(request)).toString("utf8");
    const valid = verifyWebhook({
      secret: this.#secret,
      nonce: nonce ?? "",
      timestamp: timestamp ?? "",
      payload,
      signature: signature ?? "",
      nowSeconds: Math.floor(this.#now().getTime() / 1000),
      maxSkewSeconds: this.#maxSkewSeconds,
    });
    if (!valid) return this.#send(response, 401, { error: "invalid signature" });
    // A signed body stays valid for the whole skew window, so a captured delivery could be sent again.
    // A nonce is remembered only after it is processed, so a delivery that failed can still be retried.
    const nowMs = this.#now().getTime();
    for (const [seen, until] of this.#seenNonces) if (until <= nowMs) this.#seenNonces.delete(seen);
    if (this.#seenNonces.has(nonce)) return this.#send(response, 200, { ok: true, duplicate: true });
    let body: unknown;
    try {
      body = JSON.parse(payload);
    } catch {
      return this.#send(response, 400, { error: "invalid payload" });
    }
    const result = this.ledger.ingest(body);
    this.#seenNonces.set(nonce, nowMs + 2 * this.#maxSkewSeconds * 1000);
    this.#send(response, 200, { ok: true, ...result });
    if (this.#sweepOnWebhook) {
      void this.sweep().catch((error: unknown) => {
        console.error(`overdue sweep failed: ${error instanceof Error ? error.message : "unknown error"}`);
      });
    }
    if (this.#report) {
      void this.#report(body).catch((error: unknown) => {
        console.error(`portal report failed: ${error instanceof Error ? error.message : "unknown error"}`);
      });
    }
  }

  async #json(request: IncomingMessage): Promise<unknown> {
    try {
      return JSON.parse((await this.#raw(request)).toString("utf8"));
    } catch {
      throw new HttpError(400, "invalid json");
    }
  }

  async #raw(request: IncomingMessage): Promise<Buffer> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of request) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buffer.length;
      if (size > this.#bodyLimit) throw new HttpError(413, "payload too large");
      chunks.push(buffer);
    }
    const encoded = Buffer.concat(chunks);
    if (String(request.headers["content-encoding"] ?? "").toLowerCase() === "gzip") {
      try {
        // The size limit applies to the decompressed body too, so a small gzip bomb cannot exhaust memory.
        return gunzipSync(encoded, { maxOutputLength: this.#bodyLimit });
      } catch (error) {
        if ((error as { code?: string }).code === "ERR_BUFFER_TOO_LARGE") throw new HttpError(413, "payload too large");
        throw new HttpError(400, "invalid gzip payload");
      }
    }
    return encoded;
  }

  #bearer(request: IncomingMessage, expected: string): boolean {
    const presented = header(request, "authorization");
    if (!presented?.startsWith("Bearer ") || !expected) return false;
    // Compare fixed-length digests, so neither the contents nor the length of the token leaks through timing.
    const digest = (value: string) => createHash("sha256").update(value, "utf8").digest();
    return timingSafeEqual(digest(presented.slice("Bearer ".length)), digest(expected));
  }

  #send(response: ServerResponse, status: number, body: unknown, contentType = "application/json; charset=utf-8"): void {
    const payload = typeof body === "string" ? body : JSON.stringify(body);
    response.writeHead(status, { "content-type": contentType, "content-length": Buffer.byteLength(payload) });
    response.end(payload);
  }
}

/** Decodes one path segment; a malformed escape is the client's error (400), not a crash (500). */
function pathId(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    throw new HttpError(400, "invalid path");
  }
}

class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function header(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name];
  if (Array.isArray(value)) return value[0];
  return value;
}
