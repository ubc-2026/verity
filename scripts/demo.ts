/**
 * Local demo. No network, no testnet, no funds.
 *   npm run demo
 *
 * One verified purchase, one swapped document, one changed URL, one replay.
 * Then the NYC analysis proposal, an owner-approved purchase, and a price
 * the policy rejects.
 */
import { catalogById, resourceById } from "../src/payments/catalog.ts";
import { acceptPurchaseProposal } from "../src/payments/proposal.ts";
import { approvalTypedData, PaymentService } from "../src/payments/purchase.ts";
import { parseQuote } from "../src/payments/quote.ts";
import { computeRequestHash } from "../src/payments/researchRequest.ts";
import { listen } from "../src/payments/server.ts";
import { MerchantService, savedQuoteWire, type QuoteRequest } from "../src/payments/service.ts";
import type { PaidRequest } from "../src/payments/merchant.ts";
import type { VerificationReport } from "../src/payments/report.ts";
import { NYC_PURCHASE_PROPOSAL } from "../test/fixtures/nycProposal.ts";
import {
  DEMO_MERCHANT_CONFIG,
  DEMO_MERCHANT_SIGNER,
  DEMO_NOW,
  DEMO_OWNER,
  DEMO_PAYER,
  signTransferWithAuthorization,
} from "../test/fixtures/scenario.ts";

const catalog = catalogById();
const payments = new PaymentService({ catalog, owner: DEMO_OWNER.address });
const merchant = new MerchantService({
  config: DEMO_MERCHANT_CONFIG,
  signer: DEMO_MERCHANT_SIGNER,
  now: () => DEMO_NOW,
});

function fail(message: string): never {
  console.error(message);
  process.exitCode = 1;
  throw new Error(message);
}

async function post<T>(port: number, path: string, body?: unknown): Promise<{ status: number; json: T }> {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, json: (await response.json()) as T };
}

async function authorize(input: {
  port: number;
  purchaseId: string;
  catalogItemId: string;
  contractId: string;
  groupKey: string;
  catalogParameters?: Record<string, string>;
  materialUnresolvedGap?: boolean;
  ownerSignature?: `0x${string}`;
}): Promise<{ payment: PaidRequest; groupKey: string; status: string }> {
  const item = resourceById(input.catalogItemId);
  if (!item) fail(`missing catalog item ${input.catalogItemId}`);
  const quoted = await post<{ quote: unknown }>(input.port, "/quotes", {
    catalogItemId: input.catalogItemId,
    purchaseId: input.purchaseId,
    buyerSessionId: "session-demo-001",
    parameters: { contractId: input.contractId, evidenceType: item.item.evidenceType },
    ...(input.catalogParameters ? { catalogParameters: input.catalogParameters } : {}),
  } satisfies QuoteRequest);
  if (quoted.status !== 402) fail(`quote for ${input.purchaseId} returned ${quoted.status}`);
  const quote = parseQuote(quoted.json.quote);
  const begun = await payments.begin({
    selection: {
      catalogItemId: input.catalogItemId,
      parameters: { contractId: input.contractId, evidenceType: item.item.evidenceType },
      maxAmount: item.item.maxAmount,
    },
    groupKey: input.groupKey,
    quote,
    payer: DEMO_PAYER.address,
    now: DEMO_NOW,
    materialUnresolvedGap: input.materialUnresolvedGap ?? true,
    ownerSignature: input.ownerSignature,
  });
  if (begun.status !== "ready") return { payment: undefined as never, groupKey: input.groupKey, status: begun.status };
  const payment: PaidRequest = {
    method: "POST",
    target: new URL(item.item.resourceUrl).pathname,
    body: new TextEncoder().encode(JSON.stringify({ contractId: input.contractId, evidenceType: item.item.evidenceType })),
    bindingHeader: begun.prepared.bindingHeader,
    buyerSessionId: "session-demo-001",
    chainId: begun.request.chainId,
    token: begun.request.token,
    authorization: {
      from: begun.request.payer,
      to: begun.request.payTo,
      value: begun.request.amount,
      validAfter: String(begun.request.validAfter),
      validBefore: String(begun.request.validBefore),
      nonce: begun.prepared.record.nonce,
      signature: await signTransferWithAuthorization(begun.request, begun.prepared.record.nonce),
    },
  };
  return { payment, groupKey: input.groupKey, status: "ready" };
}

function show(title: string, report: VerificationReport) {
  console.log(`\n== ${title} ==`);
  console.log(JSON.stringify({ outcome: report.outcome, reason: report.reason, checks: report.checks, delivery: report.delivery && { resourceId: report.delivery.resourceId, contentHash: report.delivery.contentHash } }, null, 2));
}

const http = await listen(merchant);
let ok = true;
try {
  console.log("== DEMO: local merchant, policy, receipt, and ledger. Not an Arc transaction. ==");

  const honest = await authorize({
    port: http.port,
    purchaseId: "purchase-honest-001",
    catalogItemId: "resolution-source-excerpt-v1",
    contractId: "demo-contract-001",
    groupKey: "demo-contract-001:resolution_source",
  });
  if (honest.status !== "ready") fail("honest purchase was not auto-approved");
  const verified = await post<VerificationReport>(http.port, "/verify", { ...honest.payment, body: JSON.parse(new TextDecoder().decode(honest.payment.body)) });
  show("1. successful purchase", verified.json);
  if (verified.json.outcome !== "verified") ok = false;
  else payments.confirm(honest.groupKey);

  const swappedPayment = await authorize({
    port: http.port,
    purchaseId: "purchase-swap-001",
    catalogItemId: "resolution-source-excerpt-v1",
    contractId: "demo-contract-002",
    groupKey: "demo-contract-002:resolution_source",
  });
  const swapped = await post<VerificationReport>(http.port, "/attacks/wrong-resource", {
    payment: { ...swappedPayment.payment, body: JSON.parse(new TextDecoder().decode(swappedPayment.payment.body)) },
    wrongCatalogItemId: "cat-filing-packet-v1",
  });
  show("2. malicious delivery rejected", swapped.json);
  if (swapped.json.reason !== "wrong_resource") ok = false;
  payments.release(swappedPayment.groupKey);

  const movedPayment = await authorize({
    port: http.port,
    purchaseId: "purchase-url-001",
    catalogItemId: "resolution-source-excerpt-v1",
    contractId: "demo-contract-003",
    groupKey: "demo-contract-003:resolution_source",
  });
  const moved = await post<VerificationReport>(http.port, "/attacks/changed-url", {
    payment: { ...movedPayment.payment, body: JSON.parse(new TextDecoder().decode(movedPayment.payment.body)) },
    target: "/evidence/other",
  });
  show("3. changed URL rejected", moved.json);
  if (moved.json.outcome !== "rejected") ok = false;
  payments.release(movedPayment.groupKey);

  const replay = await post<VerificationReport>(http.port, "/attacks/duplicate", {
    ...honest.payment,
    body: JSON.parse(new TextDecoder().decode(honest.payment.body)),
  });
  show("4. duplicate authorization rejected", replay.json);
  if (replay.json.reason !== "nonce_replay") ok = false;

  const proposal = acceptPurchaseProposal(NYC_PURCHASE_PROPOSAL, catalog);
  const nyc = await authorize({
    port: http.port,
    purchaseId: "purchase-nyc-001",
    catalogItemId: proposal.selection.catalogItemId,
    contractId: "fx-nyc-high-20261118",
    groupKey: proposal.groupKey,
    catalogParameters: proposal.catalogParameters,
    materialUnresolvedGap: proposal.materialUnresolvedGap,
  });
  const nycReport = await post<VerificationReport>(http.port, "/verify", {
    ...nyc.payment,
    body: JSON.parse(new TextDecoder().decode(nyc.payment.body)),
  });
  show("5. analysis proposal purchased", nycReport.json);
  if (nycReport.json.outcome !== "verified") ok = false;
  else payments.confirm(nyc.groupKey);

  const filingItem = resourceById("cat-filing-packet-v1");
  if (!filingItem) fail("missing filing item");
  const filingQuote = await post<{ quote: unknown }>(http.port, "/quotes", {
    catalogItemId: filingItem.item.catalogItemId,
    purchaseId: "purchase-filing-001",
    buyerSessionId: "session-demo-001",
    parameters: { contractId: "demo-contract-004", evidenceType: filingItem.item.evidenceType },
  });
  const filing = parseQuote(filingQuote.json.quote);
  const waiting = await payments.begin({
    selection: {
      catalogItemId: filingItem.item.catalogItemId,
      parameters: { contractId: "demo-contract-004", evidenceType: "regulatory_filing" },
      maxAmount: filingItem.item.maxAmount,
    },
    groupKey: "demo-contract-004:GAP-FILING",
    quote: filing,
    payer: DEMO_PAYER.address,
    now: DEMO_NOW,
    materialUnresolvedGap: true,
  });
  if (waiting.status !== "awaiting_approval") fail("0.80 USDC quote should wait for the owner");
  console.log(`\n== 6. owner approval required (${waiting.request.amount} base units) ==`);
  const signed = await payments.begin({
    selection: {
      catalogItemId: filingItem.item.catalogItemId,
      parameters: { contractId: "demo-contract-004", evidenceType: "regulatory_filing" },
      maxAmount: filingItem.item.maxAmount,
    },
    groupKey: "demo-contract-004:GAP-FILING",
    quote: filing,
    payer: DEMO_PAYER.address,
    now: DEMO_NOW,
    materialUnresolvedGap: true,
    ownerSignature: await DEMO_OWNER.signTypedData(approvalTypedData(waiting.request, computeRequestHash(waiting.request))),
  });
  if (signed.status !== "ready") fail("owner signature should release the filing purchase");
  const filingPayment: PaidRequest = {
    method: "POST",
    target: new URL(filingItem.item.resourceUrl).pathname,
    body: new TextEncoder().encode(JSON.stringify({ contractId: "demo-contract-004", evidenceType: "regulatory_filing" })),
    bindingHeader: signed.prepared.bindingHeader,
    buyerSessionId: "session-demo-001",
    chainId: signed.request.chainId,
    token: signed.request.token,
    authorization: {
      from: signed.request.payer,
      to: signed.request.payTo,
      value: signed.request.amount,
      validAfter: String(signed.request.validAfter),
      validBefore: String(signed.request.validBefore),
      nonce: signed.prepared.record.nonce,
      signature: await signTransferWithAuthorization(signed.request, signed.prepared.record.nonce),
    },
  };
  const filingReport = await post<VerificationReport>(http.port, "/verify", {
    ...filingPayment,
    body: { contractId: "demo-contract-004", evidenceType: "regulatory_filing" },
  });
  show("6. owner-signed purchase", filingReport.json);
  if (filingReport.json.outcome !== "verified") ok = false;
  else payments.confirm("demo-contract-004:GAP-FILING");

  const archive = resourceById("cat-archive-dump-v1");
  if (!archive) fail("missing archive item");
  const archiveQuote = await post<{ quote: unknown }>(http.port, "/quotes", {
    catalogItemId: archive.item.catalogItemId,
    purchaseId: "purchase-archive-001",
    buyerSessionId: "session-demo-001",
    parameters: { contractId: "demo-contract-005", evidenceType: archive.item.evidenceType },
  });
  const rejected = await payments.begin({
    selection: {
      catalogItemId: archive.item.catalogItemId,
      parameters: { contractId: "demo-contract-005", evidenceType: archive.item.evidenceType },
      maxAmount: archive.item.maxAmount,
    },
    groupKey: "demo-contract-005:archive_dump",
    quote: parseQuote(archiveQuote.json.quote),
    payer: DEMO_PAYER.address,
    now: DEMO_NOW,
    materialUnresolvedGap: true,
  });
  console.log(`\n== 7. price above 2.00 USDC ==\n${JSON.stringify(rejected, null, 2)}`);
  if (rejected.status !== "rejected") ok = false;

  const ledger = await post<{ entries: Array<{ purchaseId: string; status: string; detail: string }> }>(http.port, "/ledger");
  console.log("\n== ledger ==");
  console.log(JSON.stringify(ledger.json.entries, null, 2));
  const reconciled = ledger.json.entries.filter((entry) => entry.status === "reconciled").length;
  if (reconciled < 3) ok = false;
} finally {
  await http.close();
}

if (!ok) fail("demo assertions failed");
console.log("\nDEMO OK");
