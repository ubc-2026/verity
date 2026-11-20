/**
 * LIVE Circle Gateway (nanopayments) runner on Arc Testnet. Opt-in; owner approval required
 * before `deposit` or `pay`.
 *
 *   node scripts/arc-gateway.ts                 # balances (read-only, default)
 *   node scripts/arc-gateway.ts deposit --live  # one 0.01 USDC Gateway deposit (onchain)
 *   node scripts/arc-gateway.ts pay --live      # one 0.001 USDC evidence purchase via Gateway
 *   node scripts/arc-gateway.ts refresh         # read-only: poll Circle for the batch status
 *
 * LIVE: Circle Gateway API and facilitator (verify/settle, transfers), Arc Testnet RPC,
 * the payer's EIP-3009 signature under GatewayWalletBatched v1.
 * FIXTURE: the NYC contract analysis and the evidence bytes the merchant serves; the
 * merchant runs in-process on 127.0.0.1 with a local bearer token.
 *
 * Reads VERITY_PAYER_PRIVATE_KEY (buyer, depositor) and VERITY_MERCHANT_PRIVATE_KEY
 * (seller payTo, Gateway transfer lookups, receipt signer) from the environment or
 * .env.arc-testnet (or the file named by VERITY_ENV_FILE). Keys are never printed; only
 * public addresses are.
 * Durable state: .verity/gateway-payments.sqlite (buyer) and .verity/gateway-merchant.sqlite
 * (merchant). Re-running `pay` resumes the same purchase: the stored authorization is reused,
 * and the merchant replays its stored receipt instead of settling again.
 */
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { ARC_TESTNET } from "../src/payments/arc.ts";
import { BINDING_HEADER } from "../src/payments/binding.ts";
import { catalogById } from "../src/payments/catalog.ts";
import {
  ARC_TESTNET_GATEWAY_WALLET,
  createLiveGatewayProvider,
  type GatewayNonceLookup,
  type GatewayPaymentPayload,
  type GatewayProvider,
  type GatewayRequirements,
  type GatewaySettleResult,
  type GatewayTransfer,
  type GatewayVerifyResult,
} from "../src/payments/circleGateway.ts";
import { RECEIPT_HEADER } from "../src/payments/deliveryReceipt.ts";
import { refreshGatewayBatch } from "../src/payments/gatewayDelivery.ts";
import { GatewayLedger } from "../src/payments/gatewayLedger.ts";
import { verifyGatewayDelivery } from "../src/payments/gatewayReceipt.ts";
import type { MerchantConfig } from "../src/payments/merchant.ts";
import { acceptPurchaseProposal } from "../src/payments/proposal.ts";
import { BuyerService } from "../src/payments/purchase.ts";
import { parseQuote } from "../src/payments/quote.ts";
import { encodePaymentHeader, listen, PAYMENT_HEADER } from "../src/payments/server.ts";
import { MerchantService } from "../src/payments/service.ts";
import { PaymentStore } from "../src/payments/store.ts";
import { ownerCallerFromEnv } from "../src/payments/voiceApproval.ts";
import { Analyst, findPython } from "./e2e/workflow.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const envFile = process.env.VERITY_ENV_FILE ?? join(root, ".env.arc-testnet");
if (existsSync(envFile)) process.loadEnvFile(envFile);
const dotEnv = join(root, ".env"); // ElevenLabs voice settings live here; already-set variables win
if (existsSync(dotEnv)) process.loadEnvFile(dotEnv);

const command = process.argv[2] && !process.argv[2].startsWith("--") ? process.argv[2] : "balances";
const live = process.argv.includes("--live");
const DEPOSIT_AMOUNT = "0.01"; // the approved amount; not configurable on purpose
const NYC = "fx-nyc-high-20261118";
const RAIL = "circle-gateway-batched" as const;
const ITEM = "cat-nws-cli-settlement-version-nano-v1";
// The buyer allowlists merchants by catalog entry, so the merchant identifies itself the same way.
const MERCHANT_ID = catalogById().get(ITEM)!.merchantId;
const POLL_SECONDS = Number(process.env.VERITY_GATEWAY_POLL_SECONDS ?? 180);
const stateDir = join(root, ".verity");
const buyerDb = join(stateDir, "gateway-payments.sqlite");
const merchantDb = join(stateDir, "gateway-merchant.sqlite");
const reportPath = join(root, "samples", "arc-gateway-live.json");

const payerKey = process.env.VERITY_PAYER_PRIVATE_KEY as Hex | undefined;
const merchantKey = process.env.VERITY_MERCHANT_PRIVATE_KEY as Hex | undefined;
if (!payerKey || !merchantKey) {
  console.log("BLOCKED: VERITY_PAYER_PRIVATE_KEY and VERITY_MERCHANT_PRIVATE_KEY must be set (.env.arc-testnet).");
  process.exit(2);
}
const payer = privateKeyToAccount(payerKey);
const merchant = privateKeyToAccount(merchantKey);
// Gateway purchases are nanopayments (0.001 USDC), which never need owner approval, so this call is only
// placed if a purchase ever reaches the owner tier. It is wired here so the live runner uses the same buyer setup.
const ownerCaller = ownerCallerFromEnv(process.env);
const nowSeconds = () => Math.floor(Date.now() / 1000);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const { GatewayClient } = await import("@circle-fin/x402-batching/client");
const payerGateway = new GatewayClient({ chain: "arcTestnet", privateKey: payerKey, ...(process.env.ARC_RPC_URL ? { rpcUrl: process.env.ARC_RPC_URL } : {}) });

async function balances() {
  const [p, m] = await Promise.all([payerGateway.getBalances(payer.address), payerGateway.getBalances(merchant.address)]);
  const row = (label: string, address: string, b: typeof p) =>
    `${label} ${address}  wallet ${b.wallet.formatted} USDC  gateway available ${b.gateway.formattedAvailable} (total ${b.gateway.formattedTotal})`;
  console.log(row("payer   ", payer.address, p));
  console.log(row("merchant", merchant.address, m));
  return { payer: p, merchant: m };
}

/** Records the raw facilitator answers so the run can report what Circle actually returned. */
class RecordingGateway implements GatewayProvider {
  readonly mode = "live" as const;
  readonly inner: GatewayProvider;
  readonly calls: { verify: GatewayVerifyResult[]; settle: GatewaySettleResult[]; transferByNonce: { at: number; found: GatewayTransfer | null }[] } = {
    verify: [], settle: [], transferByNonce: [],
  };
  constructor(inner: GatewayProvider) {
    this.inner = inner;
  }
  async verify(payload: GatewayPaymentPayload, requirements: GatewayRequirements) {
    const result = await this.inner.verify(payload, requirements);
    this.calls.verify.push(result);
    return result;
  }
  async settle(payload: GatewayPaymentPayload, requirements: GatewayRequirements) {
    const result = await this.inner.settle(payload, requirements);
    this.calls.settle.push(result);
    return result;
  }
  async transferByNonce(lookup: GatewayNonceLookup) {
    const found = await this.inner.transferByNonce(lookup);
    this.calls.transferByNonce.push({ at: nowSeconds(), found: found ?? null });
    return found;
  }
  transferById(id: string) {
    return this.inner.transferById(id);
  }
}

const merchantConfig: MerchantConfig = {
  origin: "https://merchant.example",
  merchantId: MERCHANT_ID,
  chainId: ARC_TESTNET.chainId,
  token: ARC_TESTNET.usdc,
  payTo: merchant.address,
  tokenDomain: ARC_TESTNET.usdcDomain,
  maxAuthorizationWindowSeconds: 600,
};

/**
 * The buyer's trusted catalog for this live run. The shared catalog pins payTo to the
 * placeholder 0x2222...2222, so the buyer refuses any other payee. Here the operator pins the
 * live seller address for the one Gateway item; every other field is unchanged.
 */
function liveCatalog() {
  const catalog = catalogById();
  catalog.set(ITEM, { ...catalog.get(ITEM)!, payTo: merchant.address });
  return catalog;
}

console.log(`== Circle Gateway on Arc Testnet: ${command}${live ? " (LIVE)" : ""} ==`);
console.log(`gateway wallet ${ARC_TESTNET_GATEWAY_WALLET}`);

if (command === "balances") {
  await balances();
} else if (command === "deposit") {
  if (!live) {
    console.log(`Dry run. Would deposit ${DEPOSIT_AMOUNT} USDC from ${payer.address} into Gateway. Add --live to send it.`);
    process.exit(0);
  }
  const before = await balances();
  if (before.payer.gateway.available >= 1000n) {
    console.log("REFUSED: payer already has a Gateway balance of at least 0.001 USDC; no deposit needed.");
    process.exit(3);
  }
  const result = await payerGateway.deposit(DEPOSIT_AMOUNT);
  console.log(`approval tx ${result.approvalTxHash ?? "(none needed)"}`);
  console.log(`deposit tx  ${result.depositTxHash}  amount ${result.formattedAmount} USDC  depositor ${result.depositor}`);
  for (let i = 0; i < 20; i++) {
    const b = await payerGateway.getBalances(payer.address);
    if (b.gateway.available >= 1000n) break;
    await sleep(5000);
  }
  await balances();
} else if (command === "pay" || command === "refresh") {
  if (command === "pay" && !live) {
    console.log(`Dry run. Would buy ${ITEM} for 0.001 USDC from ${payer.address} to ${merchant.address} via Gateway. Add --live to pay.`);
    process.exit(0);
  }
  mkdirSync(stateDir, { recursive: true });
  const gateway = new RecordingGateway(await createLiveGatewayProvider({ sellerPrivateKey: merchantKey, ...(process.env.ARC_RPC_URL ? { rpcUrl: process.env.ARC_RPC_URL } : {}) }));
  const store = new PaymentStore(buyerDb);
  const ledger = new GatewayLedger(store);
  const sessionToken = randomBytes(24).toString("hex"); // local server only, per process
  const service = new MerchantService({
    config: merchantConfig,
    signer: merchant,
    settlement: { settle: async () => { throw new Error("direct settlement is not used on the Gateway rail"); } },
    now: nowSeconds,
    sessions: { [sessionToken]: "session-live-buyer" },
    dbPath: merchantDb,
    gateway,
  });
  const report: Record<string, unknown> = { workflow: "verity-circle-gateway-live", network: "eip155:5042002", payer: payer.address, payTo: merchant.address, gatewayWallet: ARC_TESTNET_GATEWAY_WALLET, labels: { live: ["Circle Gateway facilitator verify/settle", "Circle transfer lookups", "Arc Testnet"], fixture: ["NYC contract analysis", "evidence bytes served by the in-process merchant"] } };
  try {
    const analyst = new Analyst(findPython(join(root, "analysis")), join(root, "analysis"));
    const analysis = analyst.analyze(NYC, "observed-2026-11-18", RAIL);
    const proposal = analysis.purchase_proposal;
    if (!proposal || proposal.catalog_item_id !== ITEM) throw new Error(`expected a proposal for ${ITEM}, got ${proposal?.catalog_item_id ?? "none"}`);
    const purchaseId = `purchase-live-${createHash("sha256").update(`${payer.address}|${proposal.proposal_id}`).digest("hex").slice(0, 24)}`;
    report.purchaseId = purchaseId;

    if (command === "pay") {
      const before = await balances();
      report.balancesBefore = { payerGatewayAvailable: before.payer.gateway.formattedAvailable, merchantGatewayAvailable: before.merchant.gateway.formattedAvailable };
      const server = await listen(service, { origin: merchantConfig.origin });
      const base = `http://127.0.0.1:${server.port}`;
      const post = async (path: string, headers: Record<string, string>, body: string) => {
        const response = await fetch(`${base}${path}`, { method: "POST", headers: { authorization: `Bearer ${sessionToken}`, "content-type": "application/json", ...headers }, body });
        return { status: response.status, headers: response.headers, bytes: new Uint8Array(await response.arrayBuffer()) };
      };
      try {
        const buyer = new BuyerService({ store, catalog: liveCatalog(), owner: payer.address, signer: payer, tokenDomain: ARC_TESTNET.usdcDomain, missionId: "mission-arc-gateway-live", ...(ownerCaller ? { ownerCaller } : {}) });
        const accepted = acceptPurchaseProposal(proposal, liveCatalog());
        let result;
        const existing = store.get(purchaseId);
        if (existing) {
          console.log(`resuming stored purchase ${purchaseId}`);
          result = await buyer.purchase({ accepted, purchaseId, quote: existing.request as never, now: nowSeconds() });
        } else {
          const quoteResponse = await post("/quotes", {}, JSON.stringify({ catalogItemId: accepted.selection.catalogItemId, purchaseId, parameters: accepted.selection.parameters, catalogParameters: accepted.catalogParameters }));
          const json = JSON.parse(new TextDecoder().decode(quoteResponse.bytes)) as { quote?: unknown; reason?: string };
          if (quoteResponse.status !== 402 || !json.quote) throw new Error(`quote refused: ${quoteResponse.status} ${json.reason}`);
          result = await buyer.purchase({ accepted, purchaseId, quote: parseQuote(json.quote), now: nowSeconds() });
        }
        if (result.status !== "authorized") throw new Error(`purchase not authorized: ${JSON.stringify(result).slice(0, 300)}`);
        console.log(`policy ${result.decision.decision}/${"tier" in result.decision ? result.decision.tier : "-"}  amount ${result.request.amount} base units  nonce ${store.get(purchaseId)!.nonce}`);
        const headers = {
          [BINDING_HEADER]: result.payment.bindingHeader,
          [PAYMENT_HEADER]: encodePaymentHeader({ chainId: result.request.chainId, token: result.request.token, authorization: result.payment.authorization }),
        };
        let attempt;
        const attempts: { status: number; reason: string | null }[] = [];
        for (let i = 0; i < 12; i++) {
          attempt = await post(new URL(result.request.resourceUrl).pathname, headers, JSON.stringify(result.request.parameters));
          const reason = attempt.status === 200 ? null : ((JSON.parse(new TextDecoder().decode(attempt.bytes)) as { reason?: string }).reason ?? null);
          attempts.push({ status: attempt.status, reason });
          console.log(`paid request #${i + 1}: ${attempt.status}${reason ? ` ${reason}` : ""}`);
          if (attempt.status !== 202) break;
          await sleep(5000);
        }
        report.paidRequestAttempts = attempts;
        if (!attempt || attempt.status !== 200) throw new Error("paid request did not deliver");
        const record = store.get(purchaseId)!;
        const verdict = await verifyGatewayDelivery({
          receiptHeader: attempt.headers.get(RECEIPT_HEADER) ?? undefined,
          body: attempt.bytes,
          trusted: { merchantId: MERCHANT_ID, receiptSigner: merchant.address },
          request: record.request,
          authorizationNonce: record.nonce,
        });
        if (!verdict.ok) throw new Error(`delivery verification failed: ${verdict.reason}`);
        const acceptedOutcome = ledger.recordVerifiedDelivery({ receipt: verdict.receipt, digest: verdict.digest, now: nowSeconds() });
        console.log(`delivery verified; ledger ${acceptedOutcome.kind}; paymentRef ${verdict.receipt.paymentRef}`);
        report.receipt = { version: verdict.receipt.version, paymentRail: verdict.receipt.paymentRail, paymentRef: verdict.receipt.paymentRef, authorizationNonce: verdict.receipt.authorizationNonce, contentHash: verdict.receipt.contentHash, digest: verdict.digest };
      } finally {
        await server.close();
      }
    }

    // Batch settlement: poll Circle by transfer ID (read-only), record buyer and merchant side separately.
    const merchantRecord = service.gatewayDeliveries.get(purchaseId);
    if (!merchantRecord?.paymentRef) throw new Error(`no accepted Gateway payment stored for ${purchaseId}`);
    const history: { at: number; status: string; txHash: string | null }[] = [];
    const deadline = nowSeconds() + (command === "pay" ? POLL_SECONDS : 15);
    let transfer: GatewayTransfer | undefined;
    do {
      transfer = await refreshGatewayBatch(purchaseId, { gateway, deliveries: service.gatewayDeliveries, now: nowSeconds });
      if (transfer) {
        history.push({ at: nowSeconds(), status: transfer.status, txHash: transfer.txHash });
        if (store.get(purchaseId) && ledger.status(purchaseId)) ledger.recordBatch(purchaseId, transfer, nowSeconds());
        console.log(`transfer ${transfer.id}: ${transfer.status}${transfer.txHash ? ` batch tx ${transfer.txHash}` : ""}`);
        if (transfer.status === "confirmed" || transfer.status === "completed" || transfer.status === "failed") break;
      }
      if (nowSeconds() >= deadline) break;
      await sleep(15_000);
    } while (true);
    const raw = transfer ? await gateway.inner.transferById(transfer.id) : undefined;
    report.batchHistory = history;
    report.buyerLedger = ledger.status(purchaseId) ?? null;
    report.merchantRecord = service.gatewayDeliveries.get(purchaseId) ?? null;
    report.facilitator = { verify: gateway.calls.verify, settle: gateway.calls.settle, transferByNonce: gateway.calls.transferByNonce };
    report.assumptions = {
      "1_derived_nonce_accepted": gateway.calls.settle.length ? gateway.calls.settle.some((s) => s.success) : "not observed in this process (see earlier run)",
      "2_settle_transaction": gateway.calls.settle.map((s) => s.transaction),
      "3_search_by_nonce_right_after_settle": gateway.calls.transferByNonce.map((c) => (c.found ? `found ${c.found.id}` : "not found")),
      "4_transfer_has_txHash": raw ? (raw.txHash ? `yes: ${raw.txHash}` : `not yet (status ${raw.status})`) : "no transfer",
    };
    const after = await balances();
    report.balancesAfter = { payerGatewayAvailable: after.payer.gateway.formattedAvailable, merchantGatewayAvailable: after.merchant.gateway.formattedAvailable };
    report.ranAt = new Date().toISOString();
    mkdirSync(dirname(reportPath), { recursive: true });
    writeFileSync(reportPath.replace(/\.json$/, `-${command}.json`), `${JSON.stringify(report, null, 2)}\n`);
    console.log(`\nassumptions: ${JSON.stringify(report.assumptions, null, 2)}`);
    console.log(`report: samples/arc-gateway-live-${command}.json`);
  } finally {
    service.close();
    store.close();
  }
} else {
  console.log(`unknown command ${command}; use balances | deposit | pay | refresh`);
  process.exitCode = 1;
}
