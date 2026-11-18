import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, it } from "node:test";
import { gzipSync } from "node:zlib";
import { pad, toHex, type Hex } from "viem";
import { ARC_TESTNET } from "../src/payments/arc.ts";
import { buildResearchRequest } from "../src/payments/buyer.ts";
import { authorizeStoredPurchase } from "../src/payments/paymentService.ts";
import { parseQuote } from "../src/payments/quote.ts";
import { PaymentStore } from "../src/payments/store.ts";
import { AUTHORIZATION_USED_TOPIC, ReconciliationLedger, TRANSFER_TOPIC } from "../src/reconciliation/ledger.ts";
import { signQuickNodePayload, verifyQuickNodeSignature } from "../src/reconciliation/quicknodeSignature.ts";
import { runStreamFilter } from "../src/reconciliation/runFilter.ts";
import { backfillStreamBody, filterSource } from "../src/reconciliation/streamConfig.ts";
import { createQuickNodeWebhookHandler, QUICKNODE_WEBHOOK_PATH } from "../src/reconciliation/webhook.ts";
import { DEMO_CATALOG, DEMO_CATALOG_ITEM, DEMO_NOW, DEMO_PARAMETERS, DEMO_PAYER, demoQuote } from "./fixtures/scenario.ts";

const TOKEN = "t".repeat(40);
const TX: Hex = `0x${"e3".repeat(32)}`;
const OTHER_TX: Hex = `0x${"aa".repeat(32)}`;
const USDC = ARC_TESTNET.usdc;
const topic = (address: string) => pad(address.toLowerCase() as Hex, { size: 32 });

/** A settled purchase in a fresh store, plus a block_with_receipts entry that settles it. */
async function settledScenario(opts: { amount?: bigint; payTo?: Hex; status?: Hex; nonce?: Hex } = {}) {
  const store = new PaymentStore();
  const { buyerSessionId: _s, ...wire } = demoQuote();
  const request = buildResearchRequest({
    catalog: DEMO_CATALOG,
    proposal: { catalogItemId: DEMO_CATALOG_ITEM.catalogItemId, parameters: DEMO_PARAMETERS, maxAmount: 100_000n },
    quote: parseQuote(wire),
    payer: DEMO_PAYER.address,
    now: DEMO_NOW,
  });
  store.reserveAndRecord({ missionId: "m", request, now: DEMO_NOW });
  const paid = await authorizeStoredPurchase({ store, purchaseId: request.purchaseId, signer: DEMO_PAYER, tokenDomain: ARC_TESTNET.usdcDomain, now: DEMO_NOW });
  store.recordSubmission(request.purchaseId, TX, DEMO_NOW);
  store.recordSettlement(request.purchaseId, TX, DEMO_NOW);

  const receipt = (txHash: Hex, logs: unknown[], status: Hex = "0x1") => ({ transactionHash: txHash, transactionIndex: "0x0", from: "0x0b53", to: USDC, status, logs });
  const entry = {
    block: { number: toHex(72781628), hash: `0x${"74".repeat(32)}`, timestamp: toHex(1794970283) },
    receipts: [
      receipt(OTHER_TX, [{ address: "0x9999999999999999999999999999999999999999", topics: [TRANSFER_TOPIC], data: "0x", logIndex: "0x0" }]),
      receipt(
        TX,
        [
          { address: USDC, topics: [AUTHORIZATION_USED_TOPIC, topic(request.payer), opts.nonce ?? paid.record.nonce], data: "0x", logIndex: "0x1" },
          { address: USDC, topics: [TRANSFER_TOPIC, topic(request.payer), topic(opts.payTo ?? request.payTo)], data: toHex(opts.amount ?? 50_000n, { size: 32 }), logIndex: "0x2" },
        ],
        opts.status,
      ),
    ],
  };
  return { store, request, paid, entry, ledger: new ReconciliationLedger(store) };
}

function ingest(ledger: ReconciliationLedger, filtered: unknown, eventId = "event-1") {
  return ledger.ingest({
    eventId,
    streamId: "s",
    batchStart: 72781628,
    batchEnd: 72781628,
    payload: JSON.stringify(filtered),
    matches: (filtered as { matches: never[] }).matches,
    finalizedBlock: 72781700n,
    now: DEMO_NOW + 60,
  });
}

describe("QuickNode webhook signature", () => {
  const payload = '{"matches":[]}';
  const sig = signQuickNodePayload(TOKEN, "nonce", "1700000000", payload);
  it("accepts HMAC-SHA256(token, nonce + timestamp + payload) in hex", () => {
    assert.equal(verifyQuickNodeSignature(TOKEN, { nonce: "nonce", timestamp: "1700000000", signature: sig, payload }), true);
  });
  const bad: Array<[string, Parameters<typeof verifyQuickNodeSignature>[1], string?]> = [
    ["altered payload", { nonce: "nonce", timestamp: "1700000000", signature: sig, payload: '{"matches":[1]}' }],
    ["altered nonce", { nonce: "nonce2", timestamp: "1700000000", signature: sig, payload }],
    ["altered timestamp", { nonce: "nonce", timestamp: "1700000001", signature: sig, payload }],
    ["missing signature", { nonce: "nonce", timestamp: "1700000000", signature: undefined, payload }],
    ["non-hex signature", { nonce: "nonce", timestamp: "1700000000", signature: "zz", payload }],
    ["wrong token", { nonce: "nonce", timestamp: "1700000000", signature: sig, payload }, "u".repeat(40)],
  ];
  for (const [label, request, token] of bad) {
    it(`rejects ${label}`, () => assert.equal(verifyQuickNodeSignature(token ?? TOKEN, request), false));
  }
});

describe("stream filter and config", () => {
  it("keeps only the target USDC AuthorizationUsed receipt", async () => {
    const { entry } = await settledScenario();
    const out = runStreamFilter({ data: [entry], metadata: { stream_id: "s" } }, [TX]) as { matches: Array<{ transactionHash: string; logs: unknown[] }> };
    assert.equal(out.matches.length, 1);
    assert.equal(out.matches[0]!.transactionHash, TX);
    assert.equal(out.matches[0]!.logs.length, 2);
  });

  it("returns null when the allowlisted tx is absent", async () => {
    const { entry } = await settledScenario();
    assert.equal(runStreamFilter({ data: [entry] }, [OTHER_TX]), null);
  });

  it("builds a one-block block_with_receipts backfill with the filter base64-encoded", () => {
    const body = backfillStreamBody({ network: "arc-testnet", block: 72781628, txHashes: [TX], webhookUrl: "https://x/webhooks/quicknode", securityToken: TOKEN });
    assert.equal(body.dataset, "block_with_receipts");
    assert.equal(body.start_range, 72781628);
    assert.equal(body.end_range, 72781628);
    assert.equal(Buffer.from(body.filter_function, "base64").toString("utf8"), filterSource([TX]));
    assert.match(filterSource([TX]), new RegExp(`TARGET_TX_HASHES = \\["${TX}"\\]`));
  });
});

describe("ReconciliationLedger", () => {
  it("matches token, payer, recipient, amount, and nonce and records one confirmed settlement", async () => {
    const { ledger, entry, request, paid, store } = await settledScenario();
    const filtered = runStreamFilter({ data: [entry] }, [TX]);
    const first = ingest(ledger, filtered);
    assert.deepEqual(first.outcomes, [{ kind: "settlement_recorded", purchaseId: request.purchaseId, nonce: paid.record.nonce }]);
    const record = ledger.settlement(request.purchaseId)!;
    assert.equal(record.settlementStatus, "confirmed");
    assert.equal(record.deliveryStatus, "pending");
    assert.equal(record.ledgerOutcome, "settlement_confirmed_delivery_pending");
    assert.equal(record.amount, "50000");
    assert.equal(record.payTo, request.payTo);
    assert.equal(record.txHash, TX);
    assert.equal(store.reservation(request.purchaseId)?.status, "spent");
  });

  it("is idempotent across replays: one settlement, reservation stays spent", async () => {
    const { ledger, entry, request, store } = await settledScenario();
    const filtered = runStreamFilter({ data: [entry] }, [TX]);
    ingest(ledger, filtered, "event-1");
    const replaySameEvent = ingest(ledger, filtered, "event-1");
    const redeliveredInNewBatch = ingest(ledger, filtered, "event-2");
    assert.equal(replaySameEvent.duplicateEvent, true);
    assert.equal(replaySameEvent.outcomes[0]!.kind, "settlement_already_recorded");
    assert.equal(redeliveredInNewBatch.outcomes[0]!.kind, "settlement_already_recorded");
    assert.equal(ledger.counts().settlements, 1);
    assert.equal(ledger.counts().events, 2);
    assert.equal(store.reservation(request.purchaseId)?.status, "spent");
  });

  const mismatches: Array<[string, Parameters<typeof settledScenario>[0], string]> = [
    ["wrong amount", { amount: 50_001n }, "mismatch"],
    ["wrong recipient", { payTo: "0x9999999999999999999999999999999999999999" }, "mismatch"],
    ["unknown nonce", { nonce: `0x${"77".repeat(32)}` }, "unmatched_payment"],
    ["failed receipt", { status: "0x0" }, "failed_receipt"],
  ];
  for (const [label, opts, kind] of mismatches) {
    it(`records a ${kind} finding for ${label} and no settlement`, async () => {
      const { ledger, entry, request } = await settledScenario(opts);
      const result = ingest(ledger, runStreamFilter({ data: [entry] }, [TX]));
      assert.equal(result.outcomes[0]!.kind, kind);
      assert.equal(ledger.settlement(request.purchaseId), undefined);
      assert.equal(ledger.counts().findings, 1);
    });
  }

  it("does not record a settlement above the finalized block", async () => {
    const { ledger, entry, request } = await settledScenario();
    const filtered = runStreamFilter({ data: [entry] }, [TX]) as { matches: never[] };
    const result = ledger.ingest({ eventId: "e", streamId: "s", batchStart: null, batchEnd: null, payload: "{}", matches: filtered.matches, finalizedBlock: 72781627n, now: DEMO_NOW });
    assert.equal(result.outcomes[0]!.kind, "not_final");
    assert.equal(ledger.settlement(request.purchaseId), undefined);
  });
});

describe("POST /webhooks/quicknode", () => {
  async function serve() {
    const scenario = await settledScenario();
    const handler = createQuickNodeWebhookHandler({ securityToken: TOKEN, ledger: scenario.ledger, finalizedBlock: async () => 72781700n, now: () => DEMO_NOW + 60 });
    const server = createServer((req, res) => void handler(req, res));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}${QUICKNODE_WEBHOOK_PATH}`;
    const payload = JSON.stringify(runStreamFilter({ data: [scenario.entry], metadata: { stream_id: "s" } }, [TX]));
    const post = (body: Buffer | string, headers: Record<string, string>) => fetch(url, { method: "POST", headers, body });
    const signed = (nonce: string, body = payload) => ({ "x-qn-nonce": nonce, "x-qn-timestamp": "1", "x-qn-signature": signQuickNodePayload(TOKEN, nonce, "1", body), "stream-id": "s" });
    return { ...scenario, server, payload, post, signed };
  }

  it("authenticates, persists, and replays to a single settlement", async () => {
    const t = await serve();
    try {
      const first = await t.post(t.payload, t.signed("a"));
      const replay = await t.post(t.payload, t.signed("b"));
      assert.equal(first.status, 200);
      assert.equal(replay.status, 200);
      assert.equal(((await replay.json()) as { duplicateEvent: boolean }).duplicateEvent, true);
      assert.equal(t.ledger.counts().settlements, 1);
      assert.equal(t.store.reservation(t.request.purchaseId)?.status, "spent");
    } finally {
      t.server.close();
    }
  });

  it("verifies gzip deliveries over the decoded body", async () => {
    const t = await serve();
    try {
      const response = await t.post(gzipSync(t.payload), { ...t.signed("a"), "content-encoding": "gzip" });
      assert.equal(response.status, 200);
      assert.equal(t.ledger.counts().settlements, 1);
    } finally {
      t.server.close();
    }
  });

  it("rejects unsigned, forged, and altered deliveries without persisting", async () => {
    const t = await serve();
    try {
      assert.equal((await t.post(t.payload, {})).status, 401);
      assert.equal((await t.post(t.payload, { ...t.signed("a"), "x-qn-signature": "0".repeat(64) })).status, 401);
      assert.equal((await t.post(t.payload.replace("0x1", "0x0"), t.signed("a"))).status, 401);
      assert.deepEqual(t.ledger.counts(), { events: 0, settlements: 0, findings: 0 });
    } finally {
      t.server.close();
    }
  });
});
