/**
 * DEMO FIXTURE runner for DeliveryReceiptV1. Local only: no network, no
 * testnet, no funds. Settlement is a stub that returns a fixture tx hash.
 *   npm run delivery:demo
 * Shows: a valid delivery accepted and reconciled, altered content and a wrong
 * signer rejected, and merchant and buyer retries that never settle twice.
 */
import { privateKeyToAccount } from "viem/accounts";
import type { Hex } from "viem";
import { ARC_TESTNET } from "../src/payments/arc.ts";
import { SettlementError } from "../src/payments/arcFacilitator.ts";
import { buildResearchRequest } from "../src/payments/buyer.ts";
import { acceptDelivery, RECEIPT_HEADER, type TrustedMerchant } from "../src/payments/deliveryReceipt.ts";
import type { PaidRequest } from "../src/payments/merchant.ts";
import { deliverPaidRequest, MerchantDeliveryStore, type DeliveryResponse, type MerchantDeliveryDeps } from "../src/payments/merchantDelivery.ts";
import { authorizeStoredPurchase } from "../src/payments/paymentService.ts";
import { parseQuote } from "../src/payments/quote.ts";
import { PaymentStore } from "../src/payments/store.ts";
import { AUTHORIZATION_USED_TOPIC, ReconciliationLedger, TRANSFER_TOPIC } from "../src/reconciliation/ledger.ts";
import { pad, toHex } from "viem";
import { DEMO_RESPONSE_TEXT } from "../test/fixtures/demoVector.ts";
import * as demo from "../test/fixtures/scenario.ts";

console.log("== DEMO FIXTURE: labeled test data and a stub settlement; nothing here touches Arc Testnet ==\n");

const RECEIPT_KEY = privateKeyToAccount("0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a"); // public Anvil key #2
const TRUSTED: TrustedMerchant = { merchantId: demo.DEMO_MERCHANT_CONFIG.merchantId, receiptSigner: RECEIPT_KEY.address };
const FIXTURE_TX: Hex = `0x${"f1".repeat(32)}`;
const ARTIFACT = new TextEncoder().encode(DEMO_RESPONSE_TEXT);

async function scenario(settle: MerchantDeliveryDeps["settlement"], receiptSigner = RECEIPT_KEY) {
  const store = new PaymentStore();
  const { buyerSessionId: _s, ...wire } = demo.demoQuote();
  const request = buildResearchRequest({
    catalog: demo.DEMO_CATALOG,
    proposal: { catalogItemId: demo.DEMO_CATALOG_ITEM.catalogItemId, parameters: demo.DEMO_PARAMETERS, maxAmount: 100_000n },
    quote: parseQuote(wire),
    payer: demo.DEMO_PAYER.address,
    now: demo.DEMO_NOW,
  });
  store.reserveAndRecord({ missionId: "demo", request, now: demo.DEMO_NOW });
  const paid = await authorizeStoredPurchase({ store, purchaseId: request.purchaseId, signer: demo.DEMO_PAYER, tokenDomain: ARC_TESTNET.usdcDomain, now: demo.DEMO_NOW });
  const input: PaidRequest = {
    method: "POST",
    target: "/evidence/resolution-source",
    body: new TextEncoder().encode(JSON.stringify(demo.DEMO_PARAMETERS)),
    bindingHeader: paid.bindingHeader,
    buyerSessionId: "session-demo-001",
    chainId: request.chainId,
    token: request.token,
    authorization: paid.authorization,
  };
  let clock = demo.DEMO_NOW;
  const quote = demo.demoQuote();
  const deps: MerchantDeliveryDeps = {
    config: demo.DEMO_MERCHANT_CONFIG,
    loadQuote: (id) => (id === quote.quoteId ? quote : undefined),
    hasArtifact: (hash) => hash === demo.DEMO_CONTENT_HASH,
    loadArtifact: (hash) => (hash === demo.DEMO_CONTENT_HASH ? ARTIFACT : undefined),
    receiptSigner,
    deliveries: new MerchantDeliveryStore(":memory:"),
    settlement: settle,
    now: () => clock,
  };
  const ledger = new ReconciliationLedger(store);
  const accept = (response: { body: Uint8Array; headers: Record<string, string> }, body = response.body) =>
    acceptDelivery({ response: { body, receiptHeader: response.headers[RECEIPT_HEADER] }, trusted: TRUSTED, request, store: ledger, now: clock });
  const observeSettlement = () => {
    const topic = (a: string) => pad(a.toLowerCase() as Hex, { size: 32 });
    return ledger.ingest({
      eventId: "demo-settlement-event",
      streamId: "demo-fixture",
      batchStart: 1,
      batchEnd: 1,
      payload: "{}",
      matches: [
        {
          blockNumber: "0x1",
          blockHash: `0x${"0b".repeat(32)}`,
          blockTimestamp: toHex(demo.DEMO_NOW),
          transactionHash: FIXTURE_TX,
          status: "0x1",
          logs: [
            { address: ARC_TESTNET.usdc, topics: [AUTHORIZATION_USED_TOPIC, topic(request.payer), paid.record.nonce], data: "0x", logIndex: "0x0" },
            { address: ARC_TESTNET.usdc, topics: [TRANSFER_TOPIC, topic(request.payer), topic(request.payTo)], data: toHex(BigInt(request.amount), { size: 32 }), logIndex: "0x1" },
          ],
        },
      ],
      finalizedBlock: 1n,
      now: clock,
      source: "demo-fixture",
    });
  };
  return { request, input, deps, ledger, accept, observeSettlement, advance: (s: number) => (clock += s) };
}

const counter = () => {
  const calls = { settle: 0, resume: 0 };
  return { calls, adapter: { settle: async () => (calls.settle++, { txHash: FIXTURE_TX }) } };
};
const line = (label: string, value: unknown) => console.log(`${label.padEnd(34)} ${typeof value === "string" ? value : JSON.stringify(value)}`);
const status = (r: DeliveryResponse) => (r.status === 200 ? `200 replayed=${r.replayed}` : `${r.status} ${r.reason}${"txHash" in r && r.txHash ? ` tx=${r.txHash}` : ""}`);
const checks: Array<[string, boolean]> = [];

// 1. Valid delivery.
{
  const { calls, adapter } = counter();
  const s = await scenario(adapter);
  const response = await deliverPaidRequest(s.input, s.deps);
  if (response.status !== 200) throw new Error(status(response));
  console.log("-- 1. valid delivery --");
  line("merchant response", status(response));
  console.log(JSON.stringify(response.receipt, null, 2));
  line(`${RECEIPT_HEADER} bytes`, response.headers[RECEIPT_HEADER]!.length);
  const accepted = await s.accept(response);
  line("buyer accept", accepted.accepted ? accepted.outcome : accepted);
  s.observeSettlement();
  const settlement = s.ledger.settlement(s.request.purchaseId)!;
  line("after settlement observed", { deliveryStatus: settlement.deliveryStatus, ledgerOutcome: settlement.ledgerOutcome });
  checks.push(["valid delivery reconciled", accepted.accepted && settlement.ledgerOutcome === "reconciled" && calls.settle === 1]);

  // 2. Altered content.
  console.log("\n-- 2. altered content --");
  const altered = Uint8Array.from(response.body);
  altered[altered.length - 3]! ^= 0x01;
  const rejected = await s.accept(response, altered);
  line("buyer accept (1 byte flipped)", rejected.accepted ? "ACCEPTED" : `${rejected.code}: ${rejected.reason}`);
  checks.push(["altered content rejected", !rejected.accepted && rejected.code === "content_mismatch"]);

  // 4a. Merchant retry after the window, and buyer re-acceptance.
  console.log("\n-- 4a. safe retry: merchant replay and buyer re-accept --");
  s.advance(3600);
  const replay = await deliverPaidRequest(s.input, s.deps);
  const same = replay.status === 200 && replay.headers[RECEIPT_HEADER] === response.headers[RECEIPT_HEADER];
  line("merchant retry (+1h)", `${status(replay)}; identical receipt=${same}; settle calls=${calls.settle}`);
  const again = await s.accept(response);
  line("buyer re-accept", again.accepted ? again.outcome : again);
  line("ledger counts", s.ledger.counts());
  checks.push(["retry replays without settling", same && calls.settle === 1]);
  checks.push(["buyer re-accept is a no-op", again.accepted && again.outcome.kind === "delivery_already_recorded" && s.ledger.counts().deliveries === 1]);
}

// 3. Wrong signer.
{
  console.log("\n-- 3. wrong signer --");
  const s = await scenario(counter().adapter, demo.DEMO_OTHER_SIGNER);
  const response = await deliverPaidRequest(s.input, s.deps);
  if (response.status !== 200) throw new Error(status(response));
  const rejected = await s.accept(response);
  line("buyer accept", rejected.accepted ? "ACCEPTED" : `${rejected.code}: ${rejected.reason}`);
  checks.push(["wrong signer rejected", !rejected.accepted && rejected.code === "wrong_signer"]);
}

// 4b. Settlement timeout, then retry by tx hash.
{
  const calls = { settle: 0, resume: 0 };
  const s = await scenario({
    settle: async () => (calls.settle++, Promise.reject(new SettlementError("submitted but outcome unknown: timeout", FIXTURE_TX, true))),
    resume: async (_v, _a, txHash) => (calls.resume++, { txHash }),
  });
  console.log("\n-- 4b. safe retry: settlement timeout --");
  const first = await deliverPaidRequest(s.input, s.deps);
  line("timeout on first attempt", status(first));
  const second = await deliverPaidRequest(s.input, s.deps);
  line("retry resumes recorded tx", `${status(second)}; calls=${JSON.stringify(calls)}`);
  checks.push(["timeout retry never resubmits", first.status === 202 && second.status === 200 && calls.settle === 1 && calls.resume === 1]);
}

console.log("");
for (const [name, passed] of checks) console.log(`${passed ? "PASS" : "FAIL"}  ${name}`);
process.exitCode = checks.every(([, passed]) => passed) ? 0 : 1;
