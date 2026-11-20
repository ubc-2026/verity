import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Hex } from "viem";
import { arcTestnet } from "viem/chains";
import { findPython, pythonChildEnv, type LiveAnalyzeOutput, type Reassessment } from "../src/app/analyst.ts";
import { ARC_TESTNET } from "../src/payments/arc.ts";
import { encodeReceiptHeader, verifyDelivery } from "../src/payments/deliveryReceipt.ts";
import { hashContent, parseResearchRequestJson } from "../src/payments/researchRequest.ts";
import { backfillStreamBody } from "../src/reconciliation/streamConfig.ts";

const item = "cat-nws-cli-settlement-version-v1";
const rail = "arc-eip3009";
const merchantId = "verity-demo-merchant";
const amount = "50000";
const streamsUrl = "https://api.quicknode.com/streams/rest/v1/streams";
const runRoot = resolve(".verity", "arc-nws-live");
const analysisDir = resolve("analysis");
const runIdPattern = /^arc-nws-[0-9a-f-]{36}$/;
const transactionPattern = /^0x[0-9a-f]{64}$/;
const streamPattern = /^[a-zA-Z0-9_-]{8,80}$/;

type Prepared = { analysis: LiveAnalyzeOutput; evidenceHash: Hex };
type Purchase = { purchaseId: string; txHash: Hex; blockNumber: number; chainId: number; contractId: string };

function runFiles(id: string) {
  const dir = resolve(runRoot, id);
  return {
    dir,
    analysis: resolve(dir, "prepared.json"), catalog: resolve(dir, "catalog.json"), evidence: resolve(dir, "evidence.json"),
    buyer: resolve(dir, "payments.sqlite"), merchant: resolve(dir, "merchant.sqlite"), attempt: resolve(dir, "purchase-attempt.json"),
    purchase: resolve(dir, "purchase.json"), stream: resolve(dir, "stream.json"), report: resolve(dir, "report.json"),
  };
}

function writeJson(path: string, value: unknown) {
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

function analyze<T>(args: string[], input?: string): T {
  const child = spawnSync(findPython(analysisDir), ["-m", "verity.cli", ...args], {
    cwd: analysisDir, env: pythonChildEnv(), timeout: 60_000, encoding: "utf8", input,
  });
  if (child.status !== 0) throw new Error("The analysis command failed. Check the Python environment and the public inputs.");
  return JSON.parse(child.stdout) as T;
}

function eligible(analysis: LiveAnalyzeOutput, evidence: Uint8Array) {
  const { risk_analysis: risk, purchase_proposal: proposal } = analysis;
  const doc = JSON.parse(Buffer.from(evidence).toString("utf8")) as Record<string, unknown>;
  if (risk.snapshot.source_mode !== "live" || !proposal || proposal.signed !== false || proposal.contract_id !== risk.contract_id ||
      proposal.catalog_item_id !== item || proposal.network_label !== "arc-testnet" || proposal.asset !== "USDC" ||
      proposal.max_amount_base_units !== amount || proposal.evidence_type !== "settlement_source_version" ||
      !risk.evidence_gaps.some((gap) => gap.id === proposal.evidence_gap_id && gap.gap_type === proposal.evidence_type) ||
      doc.label !== "LIVE" || doc.gap_type !== proposal.evidence_type || doc.station !== proposal.catalog_parameters.station ||
      doc.date !== proposal.catalog_parameters.date) {
    throw new Error("A live Arc NWS proposal for exactly 0.05 USDC and matching live evidence are required.");
  }
  return proposal;
}

function prepare(event: string, outcome: string) {
  const args = ["--event", event, "--outcome", outcome];
  const analysis = analyze<LiveAnalyzeOutput>(["analyze-live", ...args, "--rail", rail, "--approve-nws"]);
  if (!analysis.purchase_proposal) throw new Error("The live market returned no eligible Arc evidence proposal.");
  const id = `arc-nws-${randomUUID()}`;
  const files = runFiles(id);
  mkdirSync(runRoot, { recursive: true, mode: 0o700 });
  mkdirSync(files.dir, { mode: 0o700 });
  analyze(["capture-evidence", ...args, "--out", files.evidence]);
  const body = readFileSync(files.evidence);
  const proposal = eligible(analysis, body);
  const catalog = readJson<{ items: Array<{ id: string; live_contract_id?: string }> }>(resolve(analysisDir, "fixtures", "catalog_v1.json"));
  const entry = catalog.items.find(({ id }) => id === item);
  if (!entry) throw new Error("The NWS catalog item is missing.");
  entry.live_contract_id = proposal.contract_id;
  writeJson(files.catalog, catalog);
  writeJson(files.analysis, { analysis, evidenceHash: hashContent(body) } satisfies Prepared);
  return { runId: id, contract: proposal.contract_id, amountBaseUnits: amount, status: "prepared" };
}

function quickNodeConfig() {
  if (existsSync(".env.quicknode")) process.loadEnvFile(".env.quicknode");
  const { QUICKNODE_API_KEY: apiKey, VERITY_QN_SECURITY_TOKEN: securityToken, VERITY_WEBHOOK_URL: rawUrl } = process.env;
  if (!apiKey || !securityToken || securityToken.length < 32 || !rawUrl) {
    throw new Error("QuickNode API access, its signing token, and the dedicated webhook URL are required.");
  }
  const url = new URL(rawUrl);
  if (url.protocol !== "https:" || url.pathname !== "/webhooks/quicknode" || url.username || url.password || url.search || url.hash) {
    throw new Error("The dedicated webhook must use HTTPS and the exact /webhooks/quicknode path.");
  }
  return { headers: { "x-api-key": apiKey, "content-type": "application/json" }, webhookUrl: url.href, securityToken };
}

function receive(id: string, files: ReturnType<typeof runFiles>) {
  readJson<Prepared>(files.analysis);
  const receiver = spawnSync(process.execPath, ["scripts/webhook-server.ts"], {
    env: { ...process.env, VERITY_DB: files.buyer, VERITY_ARC_LIVE_RUN_ID: id, PORT: process.env.VERITY_ARC_LIVE_PORT ?? "8791" },
    stdio: "inherit",
  });
  if (receiver.status !== 0) throw new Error("The dedicated webhook receiver stopped or failed to start.");
}

async function purchase(id: string, files: ReturnType<typeof runFiles>) {
  if (existsSync(files.attempt)) throw new Error("A payment attempt already exists for this run. Resume the audit; do not buy again.");
  const saved = readJson<Prepared>(files.analysis);
  const evidence = readFileSync(files.evidence);
  const proposal = eligible(saved.analysis, evidence);
  const proposedAt = typeof proposal.created_at_utc === "string" ? Date.parse(proposal.created_at_utc) : NaN;
  const age = Date.now() - proposedAt;
  if (saved.evidenceHash !== hashContent(evidence) || !(age >= 0 && age <= 15 * 60_000)) {
    throw new Error("The evidence changed or the proposal expired; prepare a new quote before paying.");
  }
  const contractLock = resolve(runRoot, `${createHash("sha256").update(proposal.contract_id).digest("hex")}.attempt`);
  if (existsSync(contractLock)) throw new Error("This contract already has a payment attempt in this workspace. Resume the original run.");
  const { headers, webhookUrl } = quickNodeConfig();
  const health = await fetch(new URL("/healthz", webhookUrl), { redirect: "error", signal: AbortSignal.timeout(15_000) });
  if (!health.ok || (await health.json() as { runId?: string }).runId !== id) {
    throw new Error("The public webhook does not reach the receiver for this run. Payment was not started.");
  }
  const access = await fetch(`${streamsUrl}?limit=1`, { headers, redirect: "error", signal: AbortSignal.timeout(15_000) });
  await access.body?.cancel();
  if (!access.ok) throw new Error(`QuickNode Streams preflight returned HTTP ${access.status}. Payment was not started.`);
  const env: NodeJS.ProcessEnv = {
    ...process.env, ARC_RPC_URL: arcTestnet.rpcUrls.default.http[0],
    VERITY_DB: files.buyer, VERITY_MERCHANT_DB: files.merchant, VERITY_ARC_PURCHASE_FILE: files.purchase,
    VERITY_PURCHASE_ID: id, VERITY_NWS_EVIDENCE_FILE: files.evidence, VERITY_CONTRACT_ID: proposal.contract_id,
    VERITY_ARC_QUOTE_ID: `quote-${id}-${proposal.proposal_id}`,
  };
  delete env.QUICKNODE_API_KEY;
  delete env.VERITY_QN_SECURITY_TOKEN;
  const settle = (args: string[]) => spawnSync(process.execPath, ["scripts/arc-purchase.ts", ...args], { env, stdio: "ignore", timeout: 120_000 });
  if (settle(["--preflight"]).status !== 0) throw new Error("Arc Testnet preflight failed. Check the funded buyer and merchant wallet configuration.");
  writeFileSync(contractLock, id + "\n", { flag: "wx", mode: 0o600 });
  writeFileSync(files.attempt, JSON.stringify({ startedAt: new Date().toISOString() }), { flag: "wx", mode: 0o600 });
  if (settle([]).status !== 0) throw new Error("The payment attempt did not complete. Inspect the existing ledger before any further purchase.");
  return readPurchase(id, files);
}

function readPurchase(id: string, files: ReturnType<typeof runFiles>) {
  const record = readJson<Purchase>(files.purchase);
  if (record.purchaseId !== id || !transactionPattern.test(record.txHash) || record.chainId !== ARC_TESTNET.chainId ||
      !Number.isSafeInteger(record.blockNumber) || record.blockNumber <= 0) throw new Error("Invalid Arc purchase record.");
  const { purchaseId, txHash, blockNumber, chainId, contractId } = record;
  return { purchaseId, txHash, blockNumber, chainId, contractId };
}

async function stream(id: string, files: ReturnType<typeof runFiles>) {
  const paid = readPurchase(id, files);
  if (existsSync(files.stream)) return readJson(files.stream);
  const { headers, webhookUrl, securityToken } = quickNodeConfig();
  const config = backfillStreamBody({ network: "arc-testnet", block: paid.blockNumber, txHashes: [paid.txHash], webhookUrl, securityToken });
  const response = await fetch(streamsUrl, {
    method: "POST", headers, body: JSON.stringify({ ...config, external_id: id }), redirect: "error", signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`QuickNode could not create the one-block stream (HTTP ${response.status}).`);
  }
  const created = await response.json() as { id?: string; external_id?: string; start_range?: number; end_range?: number };
  const streamId = created.id;
  if (typeof streamId !== "string" || !streamPattern.test(streamId) || created.external_id !== id ||
      created.start_range !== paid.blockNumber || created.end_range !== paid.blockNumber) {
    throw new Error("QuickNode did not confirm the requested one-block stream.");
  }
  const result = { streamId, block: paid.blockNumber, txHash: paid.txHash };
  writeJson(files.stream, result);
  return result;
}

async function report(id: string, files: ReturnType<typeof runFiles>) {
  const paid = readPurchase(id, files);
  const provider = readJson<{ streamId: string; block: number; txHash: Hex }>(files.stream);
  const saved = readJson<Prepared>(files.analysis);
  const bytes = readFileSync(files.evidence);
  const proposal = eligible(saved.analysis, bytes);
  const db = new DatabaseSync(files.buyer, { readOnly: true });
  const row = (() => {
    try {
      return db.prepare(`SELECT a.request_json, a.request_hash, a.tx_hash, d.receipt_json, d.receipt_digest,
          d.tx_hash AS delivery_tx, e.stream_id
        FROM authorizations a JOIN deliveries d USING (purchase_id) JOIN settlements s USING (purchase_id)
        JOIN webhook_events e ON e.event_id = s.first_event_id
        WHERE a.purchase_id = ? AND s.tx_hash = ? AND s.block_number = ? AND s.chain_id = ? AND s.amount = ?
          AND s.source = 'quicknode-streams' AND s.delivery_status = 'verified' AND s.ledger_outcome = 'reconciled'`).get(
        id, paid.txHash, paid.blockNumber, ARC_TESTNET.chainId, amount,
      );
    } finally {
      db.close();
    }
  })();
  if (!row || provider.block !== paid.blockNumber || provider.txHash !== paid.txHash || !streamPattern.test(provider.streamId) ||
      row.stream_id !== provider.streamId || row.delivery_tx !== paid.txHash || row.tx_hash !== paid.txHash ||
      proposal.contract_id !== paid.contractId || saved.evidenceHash !== hashContent(bytes)) {
    throw new Error("The genuine QuickNode delivery and verified receipt have not been joined for this purchase.");
  }
  const request = parseResearchRequestJson(row.request_json as string);
  if (request.purchaseId !== id || request.quoteId !== `quote-${id}-${proposal.proposal_id}` ||
      request.amount !== amount || request.token !== ARC_TESTNET.usdc.toLowerCase() ||
      request.chainId !== ARC_TESTNET.chainId || request.parameters.contractId !== proposal.contract_id) {
    throw new Error("The buyer request does not match the live evidence proposal.");
  }
  const accepted = await verifyDelivery({ body: bytes, request, expectedTxHash: paid.txHash,
    trusted: { merchantId, receiptSigner: request.payTo }, receiptHeader: encodeReceiptHeader(JSON.parse(row.receipt_json as string)) });
  if (!accepted.ok || accepted.digest !== row.receipt_digest || accepted.receipt.requestHash !== row.request_hash) {
    throw new Error("The buyer receipt did not verify against the stored authorization and exact evidence bytes.");
  }
  const outcome = analyze<Reassessment>(["reassess", "--evidence-catalog", files.catalog], JSON.stringify({
    risk_analysis: saved.analysis.risk_analysis, body_b64: bytes.toString("base64"), provenance: {
      purchase_id: id, contract_id: proposal.contract_id, evidence_gap_id: proposal.evidence_gap_id,
      catalog_item_id: item, merchant_id: merchantId, request_hash: accepted.receipt.requestHash,
      content_hash_keccak256: accepted.contentHash, content_sha256: `0x${createHash("sha256").update(bytes).digest("hex")}`,
      receipt_digest: accepted.digest, receipt_signer: accepted.receipt.merchant,
      tx_hash: paid.txHash, verified_by: "verifyDelivery", data_label: "LIVE", payment_rail: rail,
    },
  }));
  if (outcome.status === "evidence_rejected") throw new Error("The analysis rejected the purchased evidence.");
  const result = { runId: id, contract: proposal.contract_id, proposalId: proposal.proposal_id, payment: paid,
    receiptDigest: accepted.digest, quickNodeStreamId: provider.streamId, ledger: "reconciled",
    reassessment: { status: outcome.status, reason: outcome.reason, before: saved.analysis.risk_analysis.rating, after: outcome.revised.rating } };
  writeJson(files.report, result);
  return result;
}

try {
  const [step, target, outcome] = process.argv.slice(2);
  if (!target || (step === "prepare" ? !outcome : !runIdPattern.test(target) || !["receive", "purchase", "stream", "report"].includes(step ?? ""))) {
    throw new Error("Use prepare <event> <outcome>, or receive, purchase, stream, and report with <runId>.");
  }
  const files = runFiles(target);
  if (step === "receive") receive(target, files);
  else {
    const result = step === "prepare" ? prepare(target, outcome!) : step === "purchase" ? await purchase(target, files)
      : step === "stream" ? await stream(target, files) : await report(target, files);
    console.log(JSON.stringify(result, null, 2));
  }
} catch (error) {
  const message = error instanceof Error ? error.message : "Unknown error";
  // Avoid disclosing provider response bodies or config values.
  console.error(error instanceof SyntaxError || error instanceof TypeError || (error instanceof Error && "code" in error)
    ? "Could not read the run, configuration, or provider response." : message);
  process.exitCode = 1;
}
