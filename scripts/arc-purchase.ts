/**
 * One 0.05 USDC evidence purchase on Arc Testnet.
 *   npm run arc:purchase
 *
 * Live: Arc Testnet RPC, USDC EIP-3009 settlement through the self-hosted
 * testnet facilitator, durable SQLite records in .verity/payments.sqlite.
 * DEMO FIXTURE: the merchant is an in-process fixture serving the labeled demo
 * artifact (the merchant workstream owns the real HTTP merchant).
 *
 * Reads VERITY_PAYER_PRIVATE_KEY and VERITY_MERCHANT_PRIVATE_KEY from the
 * environment or .env.arc-testnet. Optional: ARC_RPC_URL, VERITY_DB.
 */
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createPublicClient, createWalletClient, formatUnits, http, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arcTestnet } from "viem/chains";
import { ARC_TESTNET } from "../src/payments/arc.ts";
import { SelfHostedArcFacilitator, SettlementError, USDC_EIP3009_ABI, viemArcChain } from "../src/payments/arcFacilitator.ts";
import { buildResearchRequest, type CatalogItem } from "../src/payments/buyer.ts";
import { handlePaidRequest, type MerchantConfig, type PaidRequest, type SavedQuote } from "../src/payments/merchant.ts";
import { authorizeStoredPurchase, type PaymentSigner } from "../src/payments/paymentService.ts";
import { parseQuote } from "../src/payments/quote.ts";
import { hashContent } from "../src/payments/researchRequest.ts";
import { PaymentStore } from "../src/payments/store.ts";
import { DEMO_RESPONSE_TEXT } from "../test/fixtures/demoVector.ts";

if (existsSync(".env.arc-testnet")) process.loadEnvFile(".env.arc-testnet");

const AMOUNT = 50_000n; // 0.05 USDC
const blockers: string[] = [];
const rpcUrl = process.env.ARC_RPC_URL ?? arcTestnet.rpcUrls.default.http[0];
const publicClient = createPublicClient({ chain: arcTestnet, transport: http(rpcUrl) });
const read = <T>(functionName: string, args: unknown[] = []) =>
  publicClient.readContract({ address: ARC_TESTNET.usdc, abi: USDC_EIP3009_ABI_FULL, functionName, args } as never) as Promise<T>;
const USDC_EIP3009_ABI_FULL = [
  ...USDC_EIP3009_ABI,
  { type: "function", name: "name", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { type: "function", name: "version", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { type: "function", name: "DOMAIN_SEPARATOR", stateMutability: "view", inputs: [], outputs: [{ type: "bytes32" }] },
] as const;

console.log("== Arc Testnet purchase (merchant is a labeled DEMO FIXTURE; settlement is live) ==");
console.log(`rpc ${rpcUrl}`);

// 1. Preflight: chain, token domain, keys, funding.
const chainId = await publicClient.getChainId();
const [name, version, separator] = await Promise.all([read<string>("name"), read<string>("version"), read<Hex>("DOMAIN_SEPARATOR")]);
console.log(`chainId ${chainId}  USDC domain name=${name} version=${version} separator=${separator}`);
if (chainId !== ARC_TESTNET.chainId) blockers.push(`RPC chainId ${chainId}, expected ${ARC_TESTNET.chainId}`);
if (name !== ARC_TESTNET.usdcDomain.name || version !== ARC_TESTNET.usdcDomain.version || separator !== ARC_TESTNET.domainSeparator) {
  blockers.push("on-chain USDC EIP-712 domain differs from src/payments/arc.ts");
}

const payerKey = process.env.VERITY_PAYER_PRIVATE_KEY as Hex | undefined;
const merchantKey = process.env.VERITY_MERCHANT_PRIVATE_KEY as Hex | undefined;
if (!payerKey) blockers.push("VERITY_PAYER_PRIVATE_KEY is not set (run `npm run arc:keygen`, then fund the payer)");
if (!merchantKey) blockers.push("VERITY_MERCHANT_PRIVATE_KEY is not set (run `npm run arc:keygen`, then fund the merchant for gas)");

const payer = payerKey ? privateKeyToAccount(payerKey) : undefined;
const merchant = merchantKey ? privateKeyToAccount(merchantKey) : undefined;
let payerBalanceBefore = 0n;
if (payer) {
  payerBalanceBefore = await read<bigint>("balanceOf", [payer.address]);
  console.log(`payer    ${payer.address}  USDC ${formatUnits(payerBalanceBefore, 6)}`);
  if (payerBalanceBefore < AMOUNT) blockers.push(`payer ${payer.address} holds ${formatUnits(payerBalanceBefore, 6)} USDC; needs >= 0.05 (https://faucet.circle.com/)`);
}
if (merchant) {
  const gas = await publicClient.getBalance({ address: merchant.address });
  console.log(`merchant ${merchant.address}  native gas balance ${formatUnits(gas, 18)} USDC`);
  if (gas === 0n) blockers.push(`merchant/relayer ${merchant.address} has no gas balance (https://faucet.circle.com/)`);
}
if (blockers.length > 0) {
  console.log("\nBLOCKED. Live purchase not attempted:");
  for (const blocker of blockers) console.log(`  - ${blocker}`);
  process.exit(2);
}

// 2. DEMO FIXTURE merchant: catalog, saved quote, artifact.
const now = Math.floor(Date.now() / 1000);
const purchaseId = process.env.VERITY_PURCHASE_ID ?? `purchase-arc-${now}`;
const artifact = new TextEncoder().encode(DEMO_RESPONSE_TEXT);
const contentHash = hashContent(artifact);
const parameters = { contractId: "demo-contract-001", evidenceType: "resolution_source" };
const item: CatalogItem = {
  catalogItemId: "resolution-source-excerpt-v1",
  merchantId: "verity-demo-merchant",
  resourceUrl: "https://merchant.example/evidence/resolution-source",
  method: "POST",
  contentType: "application/json",
  chainId: ARC_TESTNET.chainId,
  token: ARC_TESTNET.usdc,
  payTo: merchant!.address,
  maxAmount: 100_000n,
};
const savedQuote: SavedQuote = {
  quoteId: `quote-${purchaseId}`,
  purchaseId,
  merchantId: item.merchantId,
  catalogItemId: item.catalogItemId,
  method: "POST",
  resourceUrl: item.resourceUrl,
  parameters,
  contentType: item.contentType,
  expectedContentHash: contentHash,
  chainId: item.chainId,
  token: item.token,
  payTo: merchant!.address.toLowerCase() as Hex,
  amount: AMOUNT.toString(),
  expiresAt: now + 600,
  buyerSessionId: "session-arc-demo",
};
const merchantConfig: MerchantConfig = {
  origin: "https://merchant.example",
  merchantId: item.merchantId,
  chainId: ARC_TESTNET.chainId,
  token: ARC_TESTNET.usdc,
  payTo: merchant!.address,
  tokenDomain: ARC_TESTNET.usdcDomain,
  maxAuthorizationWindowSeconds: 600,
};

// 3. Buyer: build, reserve and record durably, then sign from the record.
const dbPath = process.env.VERITY_DB ?? ".verity/payments.sqlite";
mkdirSync(dirname(dbPath), { recursive: true });
const store = new PaymentStore(dbPath);
const { buyerSessionId: _session, ...wireQuote } = savedQuote;
const request = buildResearchRequest({
  catalog: new Map([[item.catalogItemId, item]]),
  proposal: { catalogItemId: item.catalogItemId, parameters, maxAmount: 100_000n },
  quote: parseQuote(wireQuote),
  payer: payer!.address,
  now,
});
const first = store.reserveAndRecord({ missionId: "mission-arc-demo", request, now });
console.log(`\npurchase ${purchaseId}  reserved=${store.reservation(purchaseId)?.status}  nonce=${first.record.nonce}`);

let signatures = 0;
const signer: PaymentSigner = {
  address: payer!.address,
  signTypedData: (args) => {
    signatures += 1;
    return payer!.signTypedData(args);
  },
};
const paid = await authorizeStoredPurchase({ store, purchaseId, signer, tokenDomain: ARC_TESTNET.usdcDomain, now });

// Retry the same purchase: must reuse the stored authorization.
store.reserveAndRecord({ missionId: "mission-arc-demo", request, now });
const retry = await authorizeStoredPurchase({ store, purchaseId, signer, tokenDomain: ARC_TESTNET.usdcDomain, now });
const reuseOk = retry.reused && retry.authorization.signature === paid.authorization.signature && retry.authorization.nonce === paid.authorization.nonce && signatures === 1;
console.log(`retry    reused=${retry.reused} sameNonce=${retry.authorization.nonce === paid.authorization.nonce} sameSignature=${retry.authorization.signature === paid.authorization.signature} signatures=${signatures}`);

// 4. Merchant: verify the binding, then settle live on Arc Testnet.
const walletClient = createWalletClient({ account: merchant!, chain: arcTestnet, transport: http(rpcUrl) });
const facilitator = new SelfHostedArcFacilitator(viemArcChain(publicClient as never, walletClient), (txHash) => {
  store.recordSubmission(purchaseId, txHash, Math.floor(Date.now() / 1000));
  console.log(`submitted ${txHash}`);
});
const paidRequest: PaidRequest = {
  method: "POST",
  target: "/evidence/resolution-source",
  body: new TextEncoder().encode(JSON.stringify(parameters)),
  bindingHeader: paid.bindingHeader,
  buyerSessionId: savedQuote.buyerSessionId,
  chainId: request.chainId,
  token: request.token,
  authorization: paid.authorization,
};
const deps = {
  config: merchantConfig,
  loadQuote: (id: string) => (id === savedQuote.quoteId ? savedQuote : undefined),
  hasArtifact: (hash: Hex) => hash === contentHash,
  now: () => Math.floor(Date.now() / 1000),
  settlement: facilitator,
};

let result;
try {
  result = await handlePaidRequest(paidRequest, deps);
} catch (error) {
  const txHash = error instanceof SettlementError ? error.txHash : undefined;
  console.log(`\nSETTLEMENT FAILED: ${(error as Error).message}${txHash ? ` (tx ${txHash}, purchase stays pending)` : ""}`);
  process.exit(1);
}
if (!result.verified.ok) {
  console.log(`\nMERCHANT REJECTED ${result.verified.status}: ${result.verified.reason}`);
  process.exit(1);
}
const receipt = result.settlement as Awaited<ReturnType<SelfHostedArcFacilitator["settle"]>>;
store.recordSettlement(purchaseId, receipt.txHash, Math.floor(Date.now() / 1000));

// 5. Resubmitting the same authorization must not create a second transfer.
let secondTransfer = "none";
try {
  await handlePaidRequest(paidRequest, deps);
  secondTransfer = "UNEXPECTED: second settlement accepted";
} catch (error) {
  secondTransfer = `refused (${(error as Error).message})`;
}

const payerBalanceAfter = await read<bigint>("balanceOf", [payer!.address]);
const stored = store.get(purchaseId)!;
console.log(`
purchaseId     ${purchaseId}
txHash         ${receipt.txHash}
explorer       ${ARC_TESTNET.explorer}/tx/${receipt.txHash}
receipt        status=${receipt.status} block=${receipt.blockNumber} gasUsed=${receipt.gasUsed} AuthorizationUsed(payer,nonce)=${receipt.authorizationUsedLog} Transfer(payer->merchant,50000)=${receipt.transferLog}
store          authorization=${stored.status} reservation=${store.reservation(purchaseId)?.status}
payer USDC     ${formatUnits(payerBalanceBefore, 6)} -> ${formatUnits(payerBalanceAfter, 6)}
retry          ${reuseOk ? "reused original authorization (1 signature)" : "FAILED"}
resubmission   ${secondTransfer}
`);
store.close();
process.exitCode = reuseOk && receipt.authorizationUsedLog && receipt.transferLog && secondTransfer.startsWith("refused") ? 0 : 1;
