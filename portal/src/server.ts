import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { z } from "zod";
import { portalHtml, publicPurchase, publicUnmatched } from "./page.ts";
import { PortalError, PortalStore, type DeliveryInput, type GatewayInput, type ObservationInput, type PurchaseInput } from "./store.ts";

const isoUtc = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/);
const bytes32 = z.string().regex(/^0x[0-9a-fA-F]{64}$/);
const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
const amount = z.string().regex(/^[1-9][0-9]*$/);

const purchaseSchema = z.strictObject({
  purchaseId: id,
  missionId: id,
  quoteId: id,
  contractId: id,
  evidenceType: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),
  merchantLabel: z.string().min(1).max(160),
  rail: z.enum(["arc-eip3009", "circle-gateway-batched"]),
  amountBaseUnits: amount,
  chainId: z.literal(5042002),
  token: z.literal("0x3600000000000000000000000000000000000000"),
  payer: address,
  payTo: address,
  nonce: bytes32,
  salt: bytes32,
  requestHash: bytes32,
  deliveryDeadlineUtc: isoUtc,
  environment: z.enum(["fixture", "arc-testnet"]),
});

const deliverySchema = z.strictObject({
  ok: z.boolean(),
  detail: z.string().max(240).optional(),
  contentHash: bytes32.nullable().optional(),
});

const gatewaySchema = z.strictObject({
  paymentRef: z.string().min(1).max(160),
  receiptDigest: bytes32,
  batchStatus: z.enum(["received", "batched", "confirmed", "completed", "failed"]).nullable().optional(),
  batchTxHash: bytes32.nullable().optional(),
});

const observationSchema = z.strictObject({
  txHash: bytes32,
  blockNumber: z.number().int().nonnegative(),
  blockHash: bytes32,
  kind: z.enum(["transfer", "authorization"]),
  payer: address,
  payTo: address.nullable(),
  amountBaseUnits: z.string().regex(/^(0|[1-9][0-9]*)$/),
  nonce: bytes32.nullable(),
  logIndex: z.number().int().nonnegative(),
  source: z.string().min(1).max(80).optional(),
});

const observeSchema = z.strictObject({
  head: z.number().int().nonnegative(),
  observations: z.array(observationSchema).max(5000),
});

export interface PortalServerOptions {
  store: PortalStore;
  readToken: string;
  writeToken: string;
  now?: () => Date;
}

export class PortalServer {
  readonly store: PortalStore;
  readonly #readToken: string;
  readonly #writeToken: string;
  readonly #now: () => Date;
  readonly http: Server;

  constructor(options: PortalServerOptions) {
    this.store = options.store;
    this.#readToken = options.readToken;
    this.#writeToken = options.writeToken;
    this.#now = options.now ?? (() => new Date());
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

  async #handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      const url = new URL(request.url ?? "/", "http://localhost");
      const parts = url.pathname.split("/").filter(Boolean);
      if (request.method === "GET" && parts.length === 0) return this.#send(response, 200, portalHtml(), "text/html; charset=utf-8");
      if (request.method === "GET" && parts.length === 1 && parts[0] === "healthz") return this.#send(response, 200, { ok: true });
      if (request.method === "GET" && parts.length === 1 && parts[0] === "activity") {
        if (!this.#bearer(request, this.#readToken)) return this.#send(response, 401, { error: "unauthorized" });
        const requested = Number(url.searchParams.get("limit") ?? 100);
        const limit = Number.isInteger(requested) ? Math.min(500, Math.max(1, requested)) : 100;
        const counts = this.store.counts();
        return this.#send(response, 200, { logs: this.store.activity(limit), ...counts });
      }
      if (request.method === "GET" && parts.length === 1 && parts[0] === "purchases") {
        if (!this.#bearer(request, this.#readToken)) return this.#send(response, 401, { error: "unauthorized" });
        return this.#send(response, 200, { purchases: this.store.list().map(publicPurchase) });
      }
      if (request.method === "GET" && parts.length === 2 && parts[0] === "purchases") {
        if (!this.#bearer(request, this.#readToken)) return this.#send(response, 401, { error: "unauthorized" });
        const view = this.store.view(decodeURIComponent(parts[1]!));
        if (!view) return this.#send(response, 404, { error: "unknown purchase" });
        return this.#send(response, 200, publicPurchase(view));
      }
      if (request.method === "GET" && parts.length === 1 && parts[0] === "unmatched") {
        if (!this.#bearer(request, this.#readToken)) return this.#send(response, 401, { error: "unauthorized" });
        const counts = this.store.counts();
        return this.#send(response, 200, {
          payments: this.store.unmatched().map(publicUnmatched),
          observations: counts.observations,
          head: counts.head,
        });
      }
      if (request.method === "POST" && parts.length === 1 && parts[0] === "purchases") {
        if (!this.#bearer(request, this.#writeToken)) return this.#send(response, 401, { error: "unauthorized" });
        const parsed = purchaseSchema.safeParse(await this.#json(request));
        if (!parsed.success) return this.#send(response, 400, { error: "invalid purchase" });
        const result = this.store.registerPurchase(normalizePurchase(parsed.data), this.#now().toISOString());
        return this.#send(response, result.created ? 201 : 200, publicPurchase(result.purchase));
      }
      if (request.method === "POST" && parts.length === 3 && parts[0] === "purchases" && parts[2] === "delivery") {
        if (!this.#bearer(request, this.#writeToken)) return this.#send(response, 401, { error: "unauthorized" });
        const parsed = deliverySchema.safeParse(await this.#json(request));
        if (!parsed.success) return this.#send(response, 400, { error: "invalid delivery" });
        const purchaseId = decodeURIComponent(parts[1]!);
        const delivery: DeliveryInput = {
          purchaseId,
          ok: parsed.data.ok,
          detail: parsed.data.detail ?? (parsed.data.ok ? "delivery verified" : "delivery rejected"),
          contentHash: parsed.data.contentHash ?? null,
          recordedAtUtc: this.#now().toISOString(),
        };
        return this.#send(response, 200, publicPurchase(this.store.noteDelivery(delivery)));
      }
      if (request.method === "POST" && parts.length === 3 && parts[0] === "purchases" && parts[2] === "gateway") {
        if (!this.#bearer(request, this.#writeToken)) return this.#send(response, 401, { error: "unauthorized" });
        const parsed = gatewaySchema.safeParse(await this.#json(request));
        if (!parsed.success) return this.#send(response, 400, { error: "invalid gateway record" });
        const record: GatewayInput = {
          purchaseId: decodeURIComponent(parts[1]!),
          paymentRef: parsed.data.paymentRef,
          receiptDigest: parsed.data.receiptDigest.toLowerCase(),
          batchStatus: parsed.data.batchStatus ?? null,
          batchTxHash: parsed.data.batchTxHash?.toLowerCase() ?? null,
          updatedAtUtc: this.#now().toISOString(),
        };
        return this.#send(response, 200, publicPurchase(this.store.noteGateway(record)));
      }
      if (request.method === "POST" && parts.length === 1 && parts[0] === "observations") {
        if (!this.#bearer(request, this.#writeToken)) return this.#send(response, 401, { error: "unauthorized" });
        const parsed = observeSchema.safeParse(await this.#json(request));
        if (!parsed.success) return this.#send(response, 400, { error: "invalid observations" });
        const seenAtUtc = this.#now().toISOString();
        const observations: ObservationInput[] = parsed.data.observations.map((item) => ({
          txHash: item.txHash.toLowerCase(),
          blockNumber: item.blockNumber,
          blockHash: item.blockHash.toLowerCase(),
          kind: item.kind,
          payer: item.payer.toLowerCase(),
          payTo: item.payTo?.toLowerCase() ?? null,
          amountBaseUnits: item.amountBaseUnits,
          nonce: item.nonce?.toLowerCase() ?? null,
          logIndex: item.logIndex,
          source: item.source ?? "quicknode",
          seenAtUtc,
        }));
        return this.#send(response, 200, this.store.observe(parsed.data.head, observations));
      }
      this.#send(response, 404, { error: "not found" });
    } catch (error) {
      if (error instanceof PortalError) {
        const status = error.message.includes("unknown purchase") ? 404 : error.message.includes("already") || error.message.includes("different") ? 409 : 400;
        return this.#send(response, status, { error: error.message });
      }
      if (error instanceof HttpError) return this.#send(response, error.status, { error: error.message });
      return this.#send(response, 500, { error: "internal error" });
    }
  }

  async #json(request: IncomingMessage): Promise<unknown> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of request) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buffer.length;
      if (size > 8_000_000) throw new HttpError(413, "payload too large");
      chunks.push(buffer);
    }
    try {
      return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      throw new HttpError(400, "invalid json");
    }
  }

  #bearer(request: IncomingMessage, expected: string): boolean {
    const presented = header(request, "authorization");
    if (!presented?.startsWith("Bearer ") || !expected) return false;
    const got = Buffer.from(presented.slice("Bearer ".length));
    const want = Buffer.from(expected);
    if (got.length !== want.length) return false;
    let mismatch = 0;
    for (let index = 0; index < got.length; index += 1) mismatch |= got[index]! ^ want[index]!;
    return mismatch === 0;
  }

  #send(response: ServerResponse, status: number, body: unknown, contentType = "application/json; charset=utf-8"): void {
    const payload = typeof body === "string" ? body : JSON.stringify(body);
    response.writeHead(status, { "content-type": contentType, "content-length": Buffer.byteLength(payload) });
    response.end(payload);
  }
}

function normalizePurchase(input: z.infer<typeof purchaseSchema>): PurchaseInput {
  return {
    ...input,
    merchantLabel: input.merchantLabel.trim(),
    token: input.token.toLowerCase(),
    payer: input.payer.toLowerCase(),
    payTo: input.payTo.toLowerCase(),
    nonce: input.nonce.toLowerCase(),
    salt: input.salt.toLowerCase(),
    requestHash: input.requestHash.toLowerCase(),
  };
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
