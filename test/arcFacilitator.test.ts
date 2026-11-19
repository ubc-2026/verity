import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Hex } from "viem";
import { SelfHostedArcFacilitator, SettlementError, type ArcChain, type SettlementReceipt } from "../src/payments/arcFacilitator.ts";
import { buildResearchRequest } from "../src/payments/buyer.ts";
import type { Eip3009Authorization, VerifyResult } from "../src/payments/merchant.ts";
import { parseQuote } from "../src/payments/quote.ts";
import { commitResearchRequest } from "../src/payments/researchRequest.ts";
import { DEMO_CATALOG, DEMO_CATALOG_ITEM, DEMO_NOW, DEMO_PARAMETERS, DEMO_PAYER, demoQuote } from "./fixtures/scenario.ts";

const TX: Hex = `0x${"ab".repeat(32)}`;

function verifiedFixture() {
  const { buyerSessionId: _s, ...wire } = demoQuote();
  const request = buildResearchRequest({
    catalog: DEMO_CATALOG,
    proposal: { catalogItemId: DEMO_CATALOG_ITEM.catalogItemId, parameters: DEMO_PARAMETERS, maxAmount: 100_000n },
    quote: parseQuote(wire),
    payer: DEMO_PAYER.address,
    now: DEMO_NOW,
  });
  const { requestHash, nonce } = commitResearchRequest(request, `0x${"01".repeat(32)}`);
  const verified: Extract<VerifyResult, { ok: true }> = { ok: true, request, requestHash, nonce };
  const auth: Eip3009Authorization = {
    from: request.payer,
    to: request.payTo,
    value: request.amount,
    validAfter: String(request.validAfter),
    validBefore: String(request.validBefore),
    nonce,
    signature: `0x${"00".repeat(65)}`,
  };
  return { verified, auth };
}

function fakeChain(overrides: Partial<ArcChain> & { receipt?: Partial<SettlementReceipt> } = {}) {
  const submissions: Eip3009Authorization[] = [];
  const chain: ArcChain = {
    chainId: async () => 5042002,
    authorizationUsed: async () => false,
    submitTransferWithAuthorization: async (auth) => {
      submissions.push(auth);
      return TX;
    },
    waitForReceipt: async () => ({
      txHash: TX,
      blockNumber: 1n,
      status: "success",
      gasUsed: 1n,
      authorizationUsedLog: true,
      transferLog: true,
      ...overrides.receipt,
    }),
    ...overrides,
  };
  return { chain, submissions };
}

describe("SelfHostedArcFacilitator", () => {
  it("submits once and reports the tx hash before waiting for the receipt", async () => {
    const { verified, auth } = verifiedFixture();
    const { chain, submissions } = fakeChain();
    const seen: Hex[] = [];
    const receipt = await new SelfHostedArcFacilitator(chain, (h) => seen.push(h)).settle(verified, auth);
    assert.equal(submissions.length, 1);
    assert.deepEqual(seen, [TX]);
    assert.equal(receipt.txHash, TX);
  });

  it("does not submit when the nonce is already used on chain", async () => {
    const { verified, auth } = verifiedFixture();
    const { chain, submissions } = fakeChain({ authorizationUsed: async () => true });
    await assert.rejects(new SelfHostedArcFacilitator(chain).settle(verified, auth), /already used/);
    assert.equal(submissions.length, 0);
  });

  it("does not submit on the wrong chain or with a nonce that differs from verification", async () => {
    const { verified, auth } = verifiedFixture();
    const wrongChain = fakeChain({ chainId: async () => 1 });
    await assert.rejects(new SelfHostedArcFacilitator(wrongChain.chain).settle(verified, auth), SettlementError);
    const wrongNonce = fakeChain();
    await assert.rejects(
      new SelfHostedArcFacilitator(wrongNonce.chain).settle(verified, { ...auth, nonce: `0x${"22".repeat(32)}` }),
      /differs/,
    );
    assert.equal(wrongChain.submissions.length + wrongNonce.submissions.length, 0);
  });

  it("flags receipts whose logs do not match, keeping the tx hash", async () => {
    const { verified, auth } = verifiedFixture();
    const { chain } = fakeChain({ receipt: { transferLog: false } });
    await assert.rejects(new SelfHostedArcFacilitator(chain).settle(verified, auth), (error: SettlementError) => {
      assert.match(error.message, /logs do not match/);
      assert.equal(error.txHash, TX);
      return true;
    });
  });

  it("reports an unknown outcome with the tx hash when the receipt wait fails", async () => {
    const { verified, auth } = verifiedFixture();
    const { chain } = fakeChain({ waitForReceipt: async () => Promise.reject(new Error("timeout")) });
    await assert.rejects(new SelfHostedArcFacilitator(chain).settle(verified, auth), (error: SettlementError) => {
      assert.match(error.message, /outcome unknown/);
      assert.equal(error.txHash, TX);
      assert.equal(error.pending, true);
      return true;
    });
  });

  it("resumes a submitted transfer by tx hash without submitting again", async () => {
    const { verified, auth } = verifiedFixture();
    const waited: Hex[] = [];
    const { chain, submissions } = fakeChain({
      waitForReceipt: async (txHash) => {
        waited.push(txHash);
        return { txHash, blockNumber: 1n, status: "success", gasUsed: 1n, authorizationUsedLog: true, transferLog: true };
      },
    });
    const receipt = await new SelfHostedArcFacilitator(chain).resume(verified, auth, TX);
    assert.equal(receipt.txHash, TX);
    assert.deepEqual(waited, [TX]);
    assert.equal(submissions.length, 0);
  });

  it("marks a reverted transfer as failed, not pending", async () => {
    const { verified, auth } = verifiedFixture();
    const { chain } = fakeChain({ receipt: { status: "reverted" } });
    await assert.rejects(new SelfHostedArcFacilitator(chain).resume(verified, auth, TX), (error: SettlementError) => {
      assert.equal(error.txHash, TX);
      assert.equal(error.pending, false);
      return true;
    });
  });
});
