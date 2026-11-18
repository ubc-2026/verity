import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Hex } from "viem";
import { encodeBindingHeader } from "../src/payments/binding.ts";
import { buildResearchRequest, InMemoryAuthorizationStore, prepareAuthorization } from "../src/payments/buyer.ts";
import { handlePaidRequest, type PaidRequest, type SavedQuote } from "../src/payments/merchant.ts";
import { parseQuote } from "../src/payments/quote.ts";
import {
  DEMO_CATALOG,
  DEMO_CATALOG_ITEM,
  DEMO_CONTENT_HASH,
  DEMO_MERCHANT_CONFIG,
  DEMO_NOW,
  DEMO_OTHER_SIGNER,
  DEMO_PARAMETERS,
  DEMO_PAYER,
  demoQuote,
  signTransferWithAuthorization,
} from "./fixtures/scenario.ts";

/** Buyer side end to end: catalog + quote -> request -> commitment -> signed authorization. */
async function paidRequest(): Promise<PaidRequest> {
  const { buyerSessionId: _session, ...wire } = demoQuote();
  const request = buildResearchRequest({
    catalog: DEMO_CATALOG,
    proposal: { catalogItemId: DEMO_CATALOG_ITEM.catalogItemId, parameters: DEMO_PARAMETERS, maxAmount: 100_000n },
    quote: parseQuote(JSON.stringify(wire)),
    payer: DEMO_PAYER.address,
    now: DEMO_NOW,
  });
  const { record, bindingHeader } = prepareAuthorization(request, new InMemoryAuthorizationStore());
  return {
    method: "POST",
    target: "/evidence/resolution-source",
    body: new TextEncoder().encode(JSON.stringify(DEMO_PARAMETERS)),
    bindingHeader,
    buyerSessionId: "session-demo-001",
    chainId: request.chainId,
    token: request.token,
    authorization: {
      from: request.payer,
      to: request.payTo,
      value: request.amount,
      validAfter: String(request.validAfter),
      validBefore: String(request.validBefore),
      nonce: record.nonce,
      signature: await signTransferWithAuthorization(request, record.nonce),
    },
  };
}

function harness(quote: SavedQuote = demoQuote()) {
  const settled: unknown[] = [];
  return {
    settled,
    deps: {
      config: DEMO_MERCHANT_CONFIG,
      loadQuote: (id: string) => (id === quote.quoteId ? quote : undefined),
      hasArtifact: (hash: Hex) => hash === DEMO_CONTENT_HASH,
      now: () => DEMO_NOW,
      settlement: {
        async settle(verified: unknown) {
          settled.push(verified);
          return { txHash: "0xfixture" };
        },
      },
    },
  };
}

describe("merchant verification before settlement", () => {
  it("accepts an untampered request and settles exactly once", async () => {
    const input = await paidRequest();
    const { deps, settled } = harness();
    const result = await handlePaidRequest(input, deps);
    assert.equal(result.verified.ok, true, JSON.stringify(result.verified));
    assert.equal(settled.length, 1);
    assert.ok(result.verified.ok && result.verified.nonce === input.authorization.nonce);
  });

  const tampered: Array<[string, number, (i: PaidRequest) => void | Promise<void>]> = [
    ["changed body parameter", 402, (i) => void (i.body = new TextEncoder().encode(JSON.stringify({ ...DEMO_PARAMETERS, contractId: "demo-contract-002" })))],
    ["body with unknown field", 400, (i) => void (i.body = new TextEncoder().encode(JSON.stringify({ ...DEMO_PARAMETERS, extra: 1 })))],
    ["body with duplicate key", 400, (i) => void (i.body = new TextEncoder().encode('{"contractId":"x","contractId":"demo-contract-001","evidenceType":"resolution_source"}'))],
    ["different route", 402, (i) => void (i.target = "/evidence/other")],
    ["query string", 400, (i) => void (i.target = "/evidence/resolution-source?x=1")],
    ["different method", 402, (i) => void (i.method = "PUT")],
    ["missing binding header", 400, (i) => void (i.bindingHeader = undefined)],
    ["wrong salt", 402, (i) => void (i.bindingHeader = encodeBindingHeader({ purchaseId: "purchase-demo-001", quoteId: "quote-demo-001", salt: `0x${"11".repeat(32)}` }))],
    ["binding for another purchase", 402, (i) => void (i.bindingHeader = encodeBindingHeader({ purchaseId: "purchase-demo-002", quoteId: "quote-demo-001", salt: `0x${"11".repeat(32)}` }))],
    ["unknown quote", 404, (i) => void (i.bindingHeader = encodeBindingHeader({ purchaseId: "purchase-demo-001", quoteId: "quote-demo-999", salt: `0x${"11".repeat(32)}` }))],
    ["another buyer session", 403, (i) => void (i.buyerSessionId = "session-other")],
    ["changed amount", 402, (i) => void (i.authorization.value = "50001")],
    ["changed recipient", 402, (i) => void (i.authorization.to = "0x9999999999999999999999999999999999999999")],
    ["changed network", 402, (i) => void (i.chainId = 1)],
    ["changed token", 402, (i) => void (i.token = "0x3600000000000000000000000000000000000001")],
    ["changed validity window", 402, (i) => void (i.authorization.validBefore = String(Number(i.authorization.validBefore) + 1))],
    ["changed payer", 402, (i) => void (i.authorization.from = DEMO_OTHER_SIGNER.address)],
    ["changed nonce", 402, (i) => void (i.authorization.nonce = `0x${"22".repeat(32)}`)],
    [
      "signature from another key",
      402,
      async (i) => {
        const { buyerSessionId: _s, ...wire } = demoQuote();
        const request = buildResearchRequest({
          catalog: DEMO_CATALOG,
          proposal: { catalogItemId: DEMO_CATALOG_ITEM.catalogItemId, parameters: DEMO_PARAMETERS, maxAmount: 100_000n },
          quote: parseQuote(wire),
          payer: DEMO_PAYER.address,
          now: DEMO_NOW,
        });
        i.authorization.signature = await signTransferWithAuthorization(request, i.authorization.nonce, DEMO_OTHER_SIGNER);
      },
    ],
  ];
  for (const [label, status, mutate] of tampered) {
    it(`rejects a ${label} with ${status} and never calls settlement`, async () => {
      const input = await paidRequest();
      await mutate(input);
      const { deps, settled } = harness();
      const result = await handlePaidRequest(input, deps);
      assert.equal(result.verified.ok, false);
      assert.ok(!result.verified.ok && result.verified.status === status, JSON.stringify(result.verified));
      assert.equal(settled.length, 0);
    });
  }

  it("rejects an expired authorization", async () => {
    const input = await paidRequest();
    const { deps, settled } = harness();
    const result = await handlePaidRequest(input, { ...deps, now: () => Number(input.authorization.validBefore) });
    assert.equal(result.verified.ok, false);
    assert.equal(settled.length, 0);
  });

  it("rejects when the merchant's saved quote differs from what the buyer committed to", async () => {
    const input = await paidRequest();
    const { deps, settled } = harness({ ...demoQuote(), expectedContentHash: `0x${"ab".repeat(32)}` });
    const result = await handlePaidRequest(input, { ...deps, hasArtifact: () => true });
    assert.ok(!result.verified.ok && /nonce/.test(result.verified.reason));
    assert.equal(settled.length, 0);
  });

  it("refuses when the quoted artifact is unavailable", async () => {
    const input = await paidRequest();
    const { deps, settled } = harness();
    const result = await handlePaidRequest(input, { ...deps, hasArtifact: () => false });
    assert.ok(!result.verified.ok && result.verified.status === 503);
    assert.equal(settled.length, 0);
  });
});
