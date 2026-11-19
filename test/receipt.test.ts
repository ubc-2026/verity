import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { RESEARCH_RESOURCES } from "../src/payments/catalog.ts";
import { hashContent, ResearchRequestError } from "../src/payments/researchRequest.ts";
import { sealDelivery, verifyDelivery } from "../src/payments/receipt.ts";
import { ARC_TESTNET_CHAIN_ID, DEMO_MERCHANT_SIGNER } from "./fixtures/scenario.ts";

const honest = RESEARCH_RESOURCES[0]!;
const other = RESEARCH_RESOURCES[2]!;

describe("delivery receipts", () => {
  it("signs the quoted bytes and rejects a swapped document", async () => {
    const expected = hashContent(honest.body);
    const sealed = await sealDelivery(
      {
        body: honest.body,
        expectedContentHash: expected,
        purchaseId: "purchase-demo-001",
        quoteId: "quote-demo-001",
        requestHash: expected,
        nonce: expected,
        resourceUrl: honest.item.resourceUrl,
        chainId: ARC_TESTNET_CHAIN_ID,
      },
      DEMO_MERCHANT_SIGNER,
    );
    const ok = await verifyDelivery({
      body: honest.body,
      receipt: sealed.receipt,
      signature: sealed.signature,
      merchant: DEMO_MERCHANT_SIGNER.address,
      chainId: ARC_TESTNET_CHAIN_ID,
      expectedContentHash: expected,
      requestHash: expected,
    });
    assert.equal(ok.ok, true);

    const swapped = await verifyDelivery({
      body: other.body,
      receipt: sealed.receipt,
      signature: sealed.signature,
      merchant: DEMO_MERCHANT_SIGNER.address,
      chainId: ARC_TESTNET_CHAIN_ID,
      expectedContentHash: expected,
      requestHash: expected,
    });
    assert.equal(swapped.ok, false);
    if (!swapped.ok) assert.equal(swapped.reason, "wrong_resource");
  });

  it("refuses to sign bytes that are not the quoted document", async () => {
    await assert.rejects(
      () =>
        sealDelivery(
          {
            body: other.body,
            expectedContentHash: hashContent(honest.body),
            purchaseId: "purchase-demo-001",
            quoteId: "quote-demo-001",
            requestHash: hashContent(honest.body),
            nonce: hashContent(honest.body),
            resourceUrl: honest.item.resourceUrl,
            chainId: ARC_TESTNET_CHAIN_ID,
          },
          DEMO_MERCHANT_SIGNER,
        ),
      ResearchRequestError,
    );
  });
});
