/**
 * HTTP API for the website. Public routes are read-only or fixture-only:
 * markets, the live read-only snapshot, and fixture analysis runs. Every step
 * that touches payments is under /api/operator and needs the operator bearer
 * token, checked here on the server. Payer, merchant, webhook and feed
 * credentials never appear in a response.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { ARC_TESTNET } from "../payments/arc.ts";
import { ARC_TESTNET_GATEWAY_WALLET } from "../payments/circleGateway.ts";
import { AppError, RAILS, RunEngine, SCENARIOS, toJson } from "./engine.ts";
import type { LiveMarkets } from "./markets.ts";

const MAX_BODY = 16 * 1024;
const digest = (value: string) => createHash("sha256").update(value, "utf8").digest();

export interface AppDeps {
  engine: RunEngine;
  live: LiveMarkets;
  /** Operator bearer token. Compared by SHA-256 digest in constant time. */
  operatorToken: string;
  /** Opt-in Circle Gateway panel (archived evidence only). */
  gatewayEnabled: boolean;
  repoRoot: string;
  /** Built single-file site to serve at "/", when present. */
  siteIndex?: string;
}

export function capabilities(deps: Pick<AppDeps, "gatewayEnabled" | "engine">) {
  return [
    { id: "fixture", name: "Fixture run", state: "fixture", detail: "Analysis, quote, policy, approval, payment, delivery, QuickNode join and reassessment, all local. No keys." },
    { id: "live-markets", name: "Live market snapshot", state: "live read-only", detail: "Public Gemini Exchange events endpoint, no key, no orders. Quotes show missing, one-sided, stale, crossed and closed states." },
    {
      id: "live-analysis",
      name: "Live analysis run",
      state: "live read-only",
      detail: "analyze-live reads api.gemini.com, assets.gemini.com and forecast.weather.gov only. No model, no payment, and no evidence catalog, so a live run never proposes a purchase.",
    },
    {
      id: "arc-direct",
      name: "Arc Testnet direct settlement",
      state: "blocked",
      detail: "Not wired into this server. scripts/arc-purchase.ts settles through deliverPaidRequest but has not been run live in this version (docs/integration.md). Missing: the owner's approval for a live spend and a configured VERITY_ENV_FILE.",
    },
    {
      id: "quicknode",
      name: "QuickNode reconciliation",
      state: "fixture",
      detail: "The real stream filter, HMAC check, replay window and finality rule run on locally signed deliveries: the purchase's own transaction on Arc direct, and the batch transaction on Gateway (batch-level confirmation only). Live ingestion runs only in scripts/webhook-server.ts; no live delivery was received in this build (the last key returned 403).",
    },
    {
      id: "gateway",
      name: "Circle Gateway rail",
      state: deps.gatewayEnabled ? "fixture runs; archived live evidence shown" : "fixture runs",
      detail: "Runs use a FIXTURE Circle Gateway (no network, no funds): verify, settle once, per-transfer status, batch. Set VERITY_GATEWAY_RAIL=1 to also show the archived live 0.001 USDC purchase. No live Gateway payment is made from this server.",
    },
    { id: "grok", name: "Grok overdue alert", state: "fixture", detail: "Overdue events come from the ledger status. A contract model of the Grok routine opens one card per purchase and counts replays. The real routine is not called." },
    { id: "voice", name: "ElevenLabs voice", state: "blocked", detail: "Approval explanations are text. No authorized ElevenLabs integration is wired or captured." },
    { id: "x402", name: "Standard x402", state: "blocked", detail: "The transport uses Verity headers (X-Verity-Binding, X-Verity-Payment, X-Verity-Receipt). x402 interoperability has not been checked." },
    {
      id: "owner",
      name: "Owner wallet approval",
      state: deps.engine.fixtureOwnerEnrolled ? "fixture" : "configured",
      detail: deps.engine.fixtureOwnerEnrolled
        ? "Enrolled owner is the public Anvil test key #3. Set VERITY_OWNER_ADDRESS to enroll a real wallet; then only its EIP-712 signature is accepted."
        : "A configured owner address is enrolled. Only its EIP-712 signature over this exact request is accepted.",
    },
  ];
}

function gatewayPanel(repoRoot: string) {
  const read = (name: string) => JSON.parse(readFileSync(`${repoRoot}/samples/${name}`, "utf8")) as Record<string, any>;
  const pay = read("arc-gateway-live-pay.json");
  const refresh = read("arc-gateway-live-refresh.json");
  return {
    label: "LIVE (archived 2026-11-19); analysis and evidence bytes were FIXTURE",
    purchaseId: pay.purchaseId,
    amountUsdc: "0.001",
    circleTransferId: pay.receipt?.paymentRef ?? null,
    arcBatchTx: refresh.buyerLedger?.batch?.txHash ?? null,
    batchStatus: refresh.buyerLedger?.batch?.status ?? null,
    gatewayWallet: pay.gatewayWallet,
    payer: pay.payer,
    payTo: pay.payTo,
    quicknode: refresh.buyerLedger?.quicknode ?? null,
    explorer: `${ARC_TESTNET.explorer}/tx/`,
    note: "The Circle transfer ID is Circle's record of this one payment. The Arc batch transaction settles many payments at once and does not name this purchase.",
  };
}

function send(res: ServerResponse, status: number, body: unknown) {
  const bytes = Buffer.from(toJson(body), "utf8");
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": bytes.byteLength,
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  res.end(bytes);
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new AppError(413, "body too large");
    chunks.push(chunk as Buffer);
  }
  if (size === 0) return {};
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("not an object");
    return value as Record<string, unknown>;
  } catch {
    throw new AppError(400, "body must be a JSON object");
  }
}

export function createAppHandler(deps: AppDeps) {
  if (deps.operatorToken.length < 24) throw new Error("operator token must be at least 24 characters");
  const tokenDigest = digest(deps.operatorToken);
  const isOperator = (req: IncomingMessage) => {
    const token = req.headers.authorization?.match(/^Bearer (\S{16,512})$/)?.[1];
    return token !== undefined && timingSafeEqual(digest(token), tokenDigest);
  };
  // Public visitors may start fixture analysis runs, a few per minute.
  let windowStart = 0;
  let windowCount = 0;
  const allowPublicRun = () => {
    const now = Date.now();
    if (now - windowStart > 60_000) {
      windowStart = now;
      windowCount = 0;
    }
    windowCount += 1;
    return windowCount <= 30;
  };

  return async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;
    const method = req.method ?? "GET";
    try {
      if (method === "GET" && (path === "/" || path === "/index.html") && deps.siteIndex && existsSync(deps.siteIndex)) {
        const html = readFileSync(deps.siteIndex);
        res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" });
        return res.end(html);
      }
      if (!path.startsWith("/api/")) return send(res, 404, { error: "not found" });
      const operator = isOperator(req);

      if (method === "GET" && path === "/api/health") return send(res, 200, { ok: true });
      if (method === "GET" && path === "/api/config") {
        return send(res, 200, {
          mode: "fixture",
          role: operator ? "operator" : "visitor",
          paused: deps.engine.paused,
          scenarios: Object.entries(SCENARIOS).map(([id, s]) => ({ id, label: s.label, detail: s.detail, rails: s.rails ?? Object.keys(RAILS) })),
          rails: Object.entries(RAILS).map(([id, r]) => ({ id, ...r })),
          capabilities: capabilities(deps),
          arc: { chainId: ARC_TESTNET.chainId, usdc: ARC_TESTNET.usdc, gatewayWallet: ARC_TESTNET_GATEWAY_WALLET, explorer: ARC_TESTNET.explorer },
          gateway: deps.gatewayEnabled ? gatewayPanel(deps.repoRoot) : null,
        });
      }
      if (method === "GET" && path === "/api/markets") return send(res, 200, { label: "FIXTURE", markets: deps.engine.markets() });
      if (method === "GET" && path === "/api/markets/live") {
        const limit = Math.min(Math.max(Number(url.searchParams.get("limit") ?? 20) || 20, 1), 50);
        return send(res, 200, await deps.live.snapshot(limit));
      }
      if (method === "GET" && path === "/api/runs") {
        return send(res, 200, { runs: [...deps.engine.runs.values()].reverse().map((r) => ({ id: r.id, marketId: r.marketId, scenario: r.scenario, createdAtUtc: r.createdAtUtc })) });
      }
      if (method === "POST" && path === "/api/runs") {
        if (!operator && !allowPublicRun()) return send(res, 429, { error: "too many runs; try again in a minute" });
        const body = await readJson(req);
        const run = await deps.engine.createRun({ marketId: body.marketId, scenario: body.scenario, rail: body.rail, live: body.live }, operator ? "operator" : "visitor");
        return send(res, 201, operator ? deps.engine.operatorView(run) : deps.engine.publicView(run));
      }
      if (method === "GET" && path === "/api/audit") return send(res, 200, { label: "FIXTURE payments", records: deps.engine.auditLog() });
      const runMatch = path.match(/^\/api\/runs\/(run-[0-9a-f]{16})$/);
      if (method === "GET" && runMatch) {
        const run = deps.engine.get(runMatch[1]!);
        return send(res, 200, operator ? deps.engine.operatorView(run) : deps.engine.publicView(run));
      }

      if (path.startsWith("/api/operator/")) {
        if (!operator) return send(res, 401, { error: "operator token required" });
        if (method === "POST" && path === "/api/operator/pause") {
          const body = await readJson(req);
          if (typeof body.paused !== "boolean") throw new AppError(400, "paused must be true or false");
          deps.engine.setPaused(body.paused, typeof body.reason === "string" ? body.reason.slice(0, 200) : null);
          return send(res, 200, { paused: deps.engine.paused });
        }
        const step = path.match(/^\/api\/operator\/runs\/(run-[0-9a-f]{16})\/([a-z-]{3,20})$/);
        if (method === "POST" && step) {
          const body = await readJson(req);
          const run = await deps.engine.step(step[1]!, step[2]!, body);
          return send(res, 200, deps.engine.operatorView(run));
        }
      }
      return send(res, 404, { error: "not found" });
    } catch (error) {
      if (error instanceof AppError) {
        // Return the run with the error so the page can show both.
        return send(res, error.status, { error: error.message });
      }
      console.error(`${method} ${path}: ${(error as Error).stack ?? error}`);
      return send(res, 500, { error: "internal error" });
    }
  };
}
