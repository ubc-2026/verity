import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Hex } from "viem";
import type { PaidRequest } from "./merchant.ts";
import { ResearchRequestError } from "./researchRequest.ts";
import { MerchantService, savedQuoteWire, type QuoteRequest } from "./service.ts";

export interface HttpResult {
  status: number;
  body: unknown;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > 1_000_000) {
        reject(new ResearchRequestError("body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function paidFromJson(value: unknown): PaidRequest {
  if (!value || typeof value !== "object") throw new ResearchRequestError("payment body must be an object");
  const record = value as Record<string, unknown>;
  const authorization = record.authorization;
  if (!authorization || typeof authorization !== "object") throw new ResearchRequestError("missing authorization");
  const auth = authorization as Record<string, unknown>;
  const body = record.body;
  const encoded =
    typeof body === "string" ? new TextEncoder().encode(body) : new TextEncoder().encode(JSON.stringify(body ?? {}));
  return {
    method: String(record.method ?? "POST"),
    target: String(record.target ?? ""),
    body: encoded,
    bindingHeader: typeof record.bindingHeader === "string" ? record.bindingHeader : undefined,
    buyerSessionId: String(record.buyerSessionId ?? ""),
    chainId: Number(record.chainId),
    token: String(record.token) as Hex,
    authorization: {
      from: String(auth.from) as Hex,
      to: String(auth.to) as Hex,
      value: String(auth.value),
      validAfter: String(auth.validAfter),
      validBefore: String(auth.validBefore),
      nonce: String(auth.nonce) as Hex,
      signature: String(auth.signature) as Hex,
    },
  };
}

export async function handleMerchantHttp(service: MerchantService, method: string, url: string, rawBody: string): Promise<HttpResult> {
  const path = url.split("?")[0] ?? url;
  try {
    if (method === "GET" && path === "/catalog") return { status: 200, body: { resources: service.listCatalog() } };
    if (method === "GET" && path === "/ledger") return { status: 200, body: { entries: service.ledger.entries() } };

    const json = rawBody.length === 0 ? {} : (JSON.parse(rawBody) as unknown);
    if (method === "POST" && path === "/quotes") {
      const quote = service.issueQuote(json as QuoteRequest);
      return { status: 402, body: { paymentRequired: true, quote: savedQuoteWire(quote) } };
    }
    if (method === "POST" && path === "/verify") {
      const report = await service.verify(paidFromJson(json));
      return { status: report.outcome === "verified" ? 200 : 400, body: report };
    }
    if (method === "POST" && path === "/attacks/wrong-resource") {
      const record = json as { payment?: unknown; wrongCatalogItemId?: string };
      if (!record.wrongCatalogItemId) throw new ResearchRequestError("wrongCatalogItemId is required");
      const report = await service.attackWrongResource(paidFromJson(record.payment), record.wrongCatalogItemId);
      return { status: 400, body: report };
    }
    if (method === "POST" && path === "/attacks/changed-url") {
      const record = json as { payment?: unknown; target?: string };
      if (!record.target) throw new ResearchRequestError("target is required");
      const report = await service.attackChangedUrl(paidFromJson(record.payment), record.target);
      return { status: report.outcome === "verified" ? 200 : 400, body: report };
    }
    if (method === "POST" && path === "/attacks/duplicate") {
      const report = await service.attackDuplicate(paidFromJson(json));
      return { status: report.outcome === "verified" ? 200 : 400, body: report };
    }
    return { status: 404, body: { outcome: "rejected", reason: "unknown route", delivery: null } };
  } catch (error) {
    const reason = error instanceof SyntaxError ? "invalid JSON" : error instanceof Error ? error.message : "request failed";
    return { status: 400, body: { outcome: "rejected", reason, delivery: null } };
  }
}

export function listen(service: MerchantService, port = 0): Promise<{ port: number; close: () => Promise<void> }> {
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const raw = await readBody(req).catch((error: unknown) => error);
      const result =
        typeof raw === "string"
          ? await handleMerchantHttp(service, req.method ?? "GET", req.url ?? "/", raw)
          : { status: 400, body: { outcome: "rejected", reason: raw instanceof Error ? raw.message : "request failed", delivery: null } };
      const encoded = JSON.stringify(result.body);
      res.writeHead(result.status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(encoded) });
      res.end(encoded);
    })();
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
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
