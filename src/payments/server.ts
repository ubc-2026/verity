import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import canonicalize from "canonicalize";
import type { Hex } from "viem";
import { z } from "zod";
import { BINDING_HEADER } from "./binding.ts";
import { resourceByUrl } from "./catalog.ts";
import type { PaidRequest } from "./merchant.ts";
import { ResearchRequestError } from "./researchRequest.ts";
import { MerchantService, savedQuoteWire, type QuoteRequest } from "./service.ts";
import { parseStrictJson } from "./strictJson.ts";

/**
 * Verity's custom paid transport. This is not standard x402: the quote comes
 * back as a JSON 402 body, the authorization travels in X-Verity-Payment, the
 * request binding in X-Verity-Binding, and the receipt in X-Verity-Receipt.
 */
export const PAYMENT_HEADER = "X-Verity-Payment";
const MAX_BODY_BYTES = 64 * 1024;
const MAX_HEADER_CHARS = 4096;

export interface HttpResult {
  status: number;
  headers?: Record<string, string>;
  /** JSON value, or raw bytes for a delivered artifact. */
  body: unknown;
}

const hex = (bytes: number) => z.string().regex(new RegExp(`^0x[0-9a-fA-F]{${bytes * 2}}$`)) as unknown as z.ZodType<Hex>;
const uintString = z.string().regex(/^(0|[1-9][0-9]{0,77})$/);
const paymentSchema = z.strictObject({
  chainId: z.number().int().positive(),
  token: hex(20),
  authorization: z.strictObject({
    from: hex(20),
    to: hex(20),
    value: uintString,
    validAfter: uintString,
    validBefore: uintString,
    nonce: hex(32),
    signature: z.string().regex(/^0x[0-9a-fA-F]{130}$/) as unknown as z.ZodType<Hex>,
  }),
});
export type PaymentHeader = z.output<typeof paymentSchema>;

export function encodePaymentHeader(value: PaymentHeader): string {
  return Buffer.from(canonicalize(value)!, "utf8").toString("base64url");
}

export function parsePaymentHeader(value: string | undefined): PaymentHeader {
  if (!value) throw new ResearchRequestError(`missing ${PAYMENT_HEADER} header`);
  if (value.length > MAX_HEADER_CHARS || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new ResearchRequestError(`${PAYMENT_HEADER} must be base64url`);
  }
  const text = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(value, "base64url"));
  const parsed = paymentSchema.safeParse(parseStrictJson(text));
  if (!parsed.success) throw new ResearchRequestError(`invalid ${PAYMENT_HEADER}: ${parsed.error.issues[0]?.message}`);
  return parsed.data;
}

function bearer(headers: Record<string, string | undefined>): string | undefined {
  const value = headers["authorization"];
  const match = value?.match(/^Bearer ([A-Za-z0-9._~+/=-]{16,512})$/);
  return match?.[1];
}

const json = (status: number, body: unknown): HttpResult => ({ status, body });

/**
 * Routes:
 *   GET  /catalog                       public price list
 *   POST /quotes                        authenticated; 402 with the quote
 *   POST <catalog resource path>        authenticated paid request -> deliverPaidRequest
 * Every paid route calls MerchantService.deliver, which is deliverPaidRequest.
 */
export async function handleMerchantHttp(
  service: MerchantService,
  method: string,
  url: string,
  headers: Record<string, string | undefined>,
  rawBody: Uint8Array,
  origin: string,
): Promise<HttpResult> {
  const path = url.split("?")[0] ?? url;
  try {
    if (method === "GET" && path === "/catalog") return json(200, { resources: service.listCatalog() });

    const sessionId = service.authenticate(bearer(headers));
    if (!sessionId) return json(401, { outcome: "rejected", reason: "missing or unknown buyer session" });

    if (method === "POST" && path === "/quotes") {
      const request = parseStrictJson(new TextDecoder("utf-8", { fatal: true }).decode(rawBody)) as QuoteRequest;
      const quote = service.issueQuote(request, sessionId);
      return json(402, { paymentRequired: true, quote: savedQuoteWire(quote) });
    }

    if (method === "POST" && resourceByUrl(`${origin}${path}`)) {
      const payment = parsePaymentHeader(headers[PAYMENT_HEADER.toLowerCase()]);
      const paid: PaidRequest = {
        method,
        target: url,
        body: rawBody,
        bindingHeader: headers[BINDING_HEADER.toLowerCase()],
        buyerSessionId: sessionId,
        chainId: payment.chainId,
        token: payment.token,
        authorization: payment.authorization,
      };
      const result = await service.deliver(paid);
      if (result.status === 200) {
        return { status: 200, headers: { ...result.headers, "content-type": "application/json" }, body: result.body };
      }
      return json(result.status, { outcome: result.status === 202 ? "pending" : "rejected", reason: result.reason, txHash: result.txHash ?? null });
    }
    return json(404, { outcome: "rejected", reason: "unknown route" });
  } catch (error) {
    const reason = error instanceof SyntaxError ? "invalid JSON" : error instanceof Error ? error.message : "request failed";
    return json(400, { outcome: "rejected", reason });
  }
}

function readBody(req: IncomingMessage): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new ResearchRequestError("body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(new Uint8Array(Buffer.concat(chunks))));
    req.on("error", reject);
  });
}

/** Binds to 127.0.0.1 only. `origin` is the public origin the catalog URLs use. */
export function listen(
  service: MerchantService,
  options: { port?: number; origin: string },
): Promise<{ port: number; close: () => Promise<void> }> {
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const raw = await readBody(req).catch((error: unknown) => error);
      const headers = Object.fromEntries(
        Object.entries(req.headers).map(([key, value]) => [key.toLowerCase(), Array.isArray(value) ? value.join(",") : value]),
      );
      const result =
        raw instanceof Uint8Array
          ? await handleMerchantHttp(service, req.method ?? "GET", req.url ?? "/", headers, raw, options.origin)
          : json(400, { outcome: "rejected", reason: raw instanceof Error ? raw.message : "request failed" });
      const bytes = result.body instanceof Uint8Array ? result.body : new TextEncoder().encode(JSON.stringify(result.body));
      res.writeHead(result.status, {
        "content-type": "application/json; charset=utf-8",
        ...result.headers,
        "content-length": bytes.byteLength,
      });
      res.end(bytes);
    })();
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("merchant server has no port"));
        return;
      }
      resolve({
        port: address.port,
        close: () => new Promise((done, fail) => server.close((error) => (error ? fail(error) : done()))),
      });
    });
  });
}
