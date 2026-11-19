import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseBindingHeader } from "../src/payments/binding.ts";
import {
  buildResearchRequest,
  InMemoryAuthorizationStore,
  prepareAuthorization,
  type ProposalSelection,
} from "../src/payments/buyer.ts";
import { parseQuote } from "../src/payments/quote.ts";
import { ResearchRequestError } from "../src/payments/researchRequest.ts";
import {
  DEMO_CATALOG,
  DEMO_CATALOG_ITEM,
  DEMO_NOW,
  DEMO_PARAMETERS,
  DEMO_PAYER,
  demoQuote,
} from "./fixtures/scenario.ts";

function quote(overrides: Record<string, unknown> = {}) {
  const { buyerSessionId: _session, ...wire } = demoQuote();
  return parseQuote({ ...wire, ...overrides });
}

const proposal: ProposalSelection = {
  catalogItemId: DEMO_CATALOG_ITEM.catalogItemId,
  parameters: DEMO_PARAMETERS,
  maxAmount: 100_000n,
};
const build = (q = quote(), p = proposal) =>
  buildResearchRequest({ catalog: DEMO_CATALOG, proposal: p, quote: q, payer: DEMO_PAYER.address, now: DEMO_NOW });

describe("buildResearchRequest", () => {
  it("takes the resource and payment target from the catalog and price from the quote", () => {
    const request = build();
    assert.equal(request.resourceUrl, DEMO_CATALOG_ITEM.resourceUrl);
    assert.equal(request.payTo, DEMO_CATALOG_ITEM.payTo);
    assert.equal(request.amount, "50000");
    assert.equal(request.payer, DEMO_PAYER.address.toLowerCase());
    assert.equal(request.validAfter, DEMO_NOW - 30);
    assert.equal(request.validBefore, DEMO_NOW + 300);
  });

  it("caps the authorization window at quote expiry", () => {
    assert.equal(build(quote({ expiresAt: DEMO_NOW + 60 })).validBefore, DEMO_NOW + 60);
  });

  const rejected: Array<[string, () => unknown]> = [
    ["a non-allowlisted item", () => build(quote(), { ...proposal, catalogItemId: "unknown" })],
    ["a quote for another resource", () => build(quote({ resourceUrl: "https://evil.example/evidence/resolution-source" }))],
    ["a quote for another recipient", () => build(quote({ payTo: "0x9999999999999999999999999999999999999999" }))],
    ["a quote for another token", () => build(quote({ token: "0x3600000000000000000000000000000000000001" }))],
    ["a quote for another chain", () => build(quote({ chainId: 1 }))],
    ["a quote for another merchant", () => build(quote({ merchantId: "other" }))],
    ["quoted parameters that differ from the proposal", () => build(quote({ parameters: { ...DEMO_PARAMETERS, contractId: "other" } }))],
    ["a price above the catalog ceiling", () => build(quote({ amount: "100001" }), { ...proposal, maxAmount: 10_000_000n })],
    ["a price above the proposal ceiling", () => build(quote(), { ...proposal, maxAmount: 49_999n })],
    ["an expired quote", () => build(quote({ expiresAt: DEMO_NOW }))],
    ["proposal parameters with unknown fields", () => build(quote(), { ...proposal, parameters: { ...DEMO_PARAMETERS, extra: 1 } })],
  ];
  for (const [label, run] of rejected) {
    it(`rejects ${label}`, () => assert.throws(run, ResearchRequestError));
  }
});

describe("prepareAuthorization", () => {
  it("uses a fresh salt for a new purchase and reuses it for a retry", () => {
    const store = new InMemoryAuthorizationStore();
    const request = build();
    let drawn = 0;
    const saltSource = () => {
      drawn += 1;
      return `0x${drawn.toString(16).padStart(64, "0")}` as const;
    };

    const first = prepareAuthorization(request, store, saltSource);
    const retry = prepareAuthorization(request, store, saltSource);
    assert.equal(first.reused, false);
    assert.equal(retry.reused, true);
    assert.equal(drawn, 1);
    assert.equal(retry.record.nonce, first.record.nonce);
    assert.equal(retry.bindingHeader, first.bindingHeader);
    assert.deepEqual(parseBindingHeader(first.bindingHeader), {
      purchaseId: request.purchaseId,
      quoteId: request.quoteId,
      salt: first.record.salt,
    });
  });

  it("refuses a second authorization for the same purchase with a different request", () => {
    const store = new InMemoryAuthorizationStore();
    prepareAuthorization(build(), store);
    const changed = buildResearchRequest({
      catalog: DEMO_CATALOG,
      proposal,
      quote: quote(),
      payer: DEMO_PAYER.address,
      now: DEMO_NOW + 5,
    });
    assert.throws(() => prepareAuthorization(changed, store), /already has an authorization/);
  });
});
