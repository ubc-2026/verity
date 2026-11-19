/**
 * DEMO FIXTURE runner. Local only: no network, no testnet, no funds.
 *   npm run fixture
 * 1. Reproduces the pinned ResearchRequestV1 test vector.
 * 2. Runs buyer construction -> authorization -> merchant verification, with
 *    a stub settlement adapter, for one honest and one tampered request.
 */
import { buildResearchRequest, InMemoryAuthorizationStore, prepareAuthorization } from "../src/payments/buyer.ts";
import { verifyPaidRequest, type PaidRequest } from "../src/payments/merchant.ts";
import { parseQuote } from "../src/payments/quote.ts";
import { commitResearchRequest, hashContent, parseResearchRequestJson } from "../src/payments/researchRequest.ts";
import * as vector from "../test/fixtures/demoVector.ts";
import * as demo from "../test/fixtures/scenario.ts";

console.log("== DEMO FIXTURE: labeled test data, not production configuration ==\n");

const commitment = commitResearchRequest(parseResearchRequestJson(vector.DEMO_REQUEST_JSON), vector.DEMO_SALT);
const contentHash = hashContent(new TextEncoder().encode(vector.DEMO_RESPONSE_TEXT));
const rows: Array<[string, string, string]> = [
  ["contentHash", contentHash, vector.DEMO_EXPECTED_CONTENT_HASH],
  ["requestHash", commitment.requestHash, vector.DEMO_REQUEST_HASH],
  ["nonce", commitment.nonce, vector.DEMO_NONCE],
];
let vectorOk = true;
for (const [name, got, want] of rows) {
  const ok = got === want;
  vectorOk &&= ok;
  console.log(`${ok ? "PASS" : "FAIL"} ${name.padEnd(12)} ${got}`);
}

const { buyerSessionId, ...wire } = demo.demoQuote();
const request = buildResearchRequest({
  catalog: demo.DEMO_CATALOG,
  proposal: { catalogItemId: demo.DEMO_CATALOG_ITEM.catalogItemId, parameters: demo.DEMO_PARAMETERS, maxAmount: 100_000n },
  quote: parseQuote(wire),
  purchaseId: wire.purchaseId,
  payer: demo.DEMO_PAYER.address,
  now: demo.DEMO_NOW,
});
const { record, bindingHeader } = prepareAuthorization(request, new InMemoryAuthorizationStore());
const signature = await demo.signTransferWithAuthorization(request, record.nonce);

const paid = (body: object): PaidRequest => ({
  method: "POST",
  target: "/evidence/resolution-source",
  body: new TextEncoder().encode(JSON.stringify(body)),
  bindingHeader,
  buyerSessionId,
  chainId: request.chainId,
  token: request.token,
  authorization: {
    from: request.payer,
    to: request.payTo,
    value: request.amount,
    validAfter: String(request.validAfter),
    validBefore: String(request.validBefore),
    nonce: record.nonce,
    signature,
  },
});

const deps = {
  config: demo.DEMO_MERCHANT_CONFIG,
  loadQuote: (id: string) => (id === wire.quoteId ? { ...wire, buyerSessionId } : undefined),
  hasArtifact: () => true,
  now: () => demo.DEMO_NOW,
};

// Verification only. Settlement, receipts, and retries are exercised by `npm run e2e`.
console.log(`\nbuyer nonce  ${record.nonce}`);
const honest = await verifyPaidRequest(paid(demo.DEMO_PARAMETERS), deps);
console.log(`honest   -> ${honest.ok ? "verified" : `rejected: ${honest.reason}`}`);
const tampered = await verifyPaidRequest(paid({ ...demo.DEMO_PARAMETERS, contractId: "demo-contract-002" }), deps);
console.log(`tampered -> ${tampered.ok ? "verified (UNEXPECTED)" : `rejected ${tampered.status}: ${tampered.reason}`}`);

const ok = vectorOk && honest.ok && !tampered.ok;
console.log(`\n${ok ? "FIXTURE OK" : "FIXTURE FAILED"}`);
process.exitCode = ok ? 0 : 1;
