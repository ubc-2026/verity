import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { keccak256, toBytes, toHex, type Hex } from "viem";
import { FIXTURE_FINALIZED_BLOCK, signedGatewayBatchDelivery } from "../src/app/fixtureChain.ts";
import { ARC_TESTNET } from "../src/payments/arc.ts";
import { ARC_TESTNET_GATEWAY_WALLET } from "../src/payments/circleGateway.ts";
import { PaymentStore } from "../src/payments/store.ts";
import { ReconciliationLedger, type GatewayBatchMatch } from "../src/reconciliation/ledger.ts";
import { runStreamFilter } from "../src/reconciliation/runFilter.ts";
import { extractMatches } from "../src/reconciliation/webhook.ts";

const BATCH: Hex = keccak256(toBytes("fixture-batch-1"));

function batch(overrides: Partial<GatewayBatchMatch> = {}): GatewayBatchMatch {
  return {
    blockNumber: toHex(72781650),
    blockHash: keccak256(toBytes("block-1")),
    blockTimestamp: toHex(1795185100),
    transactionHash: BATCH,
    to: ARC_TESTNET_GATEWAY_WALLET,
    status: "0x1",
    logCount: 1,
    ...overrides,
  };
}

function ingest(ledger: ReconciliationLedger, eventId: string, gatewayBatches: GatewayBatchMatch[]) {
  return ledger.ingest({ eventId, streamId: "s", batchStart: null, batchEnd: null, payload: eventId, matches: [], gatewayBatches, finalizedBlock: FIXTURE_FINALIZED_BLOCK, now: 1 });
}

describe("QuickNode Gateway batch confirmation", () => {
  it("the stream filter keeps a successful GatewayWallet receipt and the webhook extracts it", () => {
    const signed = signedGatewayBatchDelivery({ batchTxHash: BATCH, blockTimestamp: 1795185100, securityToken: "t", timestamp: 1795185100, streamId: "s" });
    const { matches, gatewayBatches } = extractMatches(JSON.parse(signed.payload));
    assert.deepEqual(matches, []);
    assert.equal(gatewayBatches.length, 1);
    assert.equal(gatewayBatches[0]!.transactionHash, BATCH);
    assert.equal(gatewayBatches[0]!.logCount, 1);
    // A reverted batch receipt, or one sent elsewhere, is not kept by the filter.
    const reverted = runStreamFilter({ data: [{ block: { number: "0x1", hash: "0x1", timestamp: "0x1" }, receipts: [{ transactionHash: BATCH, to: ARC_TESTNET_GATEWAY_WALLET, status: "0x0", logs: [] }] }] });
    assert.equal(reverted, null);
    const elsewhere = runStreamFilter({ data: [{ block: { number: "0x1", hash: "0x1", timestamp: "0x1" }, receipts: [{ transactionHash: BATCH, to: ARC_TESTNET.usdc, status: "0x1", logs: [] }] }] });
    assert.equal(elsewhere, null);
  });

  it("records one confirmation per batch transaction, only when final, successful, and sent to the GatewayWallet", () => {
    const store = new PaymentStore();
    const ledger = new ReconciliationLedger(store);
    const kinds = (r: ReturnType<typeof ingest>) => r.outcomes.map((o) => o.kind);
    assert.deepEqual(kinds(ingest(ledger, "e1", [batch({ to: ARC_TESTNET.usdc })])), ["gateway_batch_refused"]);
    assert.deepEqual(kinds(ingest(ledger, "e2", [batch({ status: "0x0" })])), ["gateway_batch_refused"]);
    assert.deepEqual(kinds(ingest(ledger, "e3", [batch({ blockNumber: toHex(FIXTURE_FINALIZED_BLOCK + 1n) })])), ["gateway_batch_not_final"]);
    assert.equal(ledger.gatewayBatch(BATCH), undefined);
    assert.deepEqual(kinds(ingest(ledger, "e4", [batch()])), ["gateway_batch_confirmed"]);
    assert.deepEqual(kinds(ingest(ledger, "e5", [batch()])), ["gateway_batch_already_confirmed"]);
    const replay = ingest(ledger, "e4", [batch()]);
    assert.equal(replay.duplicateEvent, true);
    const confirmation = ledger.gatewayBatch(BATCH.toUpperCase().replace("0X", "0x"));
    assert.equal(confirmation?.status, "success_final");
    assert.equal(confirmation?.blockNumber, 72781650);
    assert.equal(confirmation?.firstEventId, "e4");
    assert.equal((store.database.prepare("SELECT COUNT(*) AS n FROM gateway_batch_confirmations").get() as { n: number }).n, 1);
    assert.equal(ledger.counts().settlements, 0, "a batch confirmation is never a per-purchase settlement");
    store.close();
  });
});
