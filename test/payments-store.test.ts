import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { hashDomain, recoverTypedDataAddress } from "viem";
import { ARC_TESTNET, TRANSFER_WITH_AUTHORIZATION_TYPES } from "../src/payments/arc.ts";
import { buildResearchRequest } from "../src/payments/buyer.ts";
import { verifyPaidRequest } from "../src/payments/merchant.ts";
import { authorizeStoredPurchase, type PaymentSigner } from "../src/payments/paymentService.ts";
import { parseQuote } from "../src/payments/quote.ts";
import { parseResearchRequest, ResearchRequestError } from "../src/payments/researchRequest.ts";
import { PaymentStore, PolicyError } from "../src/payments/store.ts";
import {
  DEMO_CATALOG,
  DEMO_CATALOG_ITEM,
  DEMO_CONTENT_HASH,
  DEMO_MERCHANT_CONFIG,
  DEMO_NOW,
  DEMO_PARAMETERS,
  DEMO_PAYER,
  demoQuote,
} from "./fixtures/scenario.ts";

const dir = mkdtempSync(join(tmpdir(), "verity-store-"));
after(() => rmSync(dir, { recursive: true, force: true }));

function demoRequest(overrides: Record<string, unknown> = {}) {
  const { buyerSessionId: _s, ...wire } = demoQuote();
  return buildResearchRequest({
    catalog: DEMO_CATALOG,
    proposal: {
      catalogItemId: DEMO_CATALOG_ITEM.catalogItemId,
      parameters: overrides.parameters ?? DEMO_PARAMETERS,
      maxAmount: 2_000_000n,
    },
    quote: parseQuote({ ...wire, ...overrides }),
    purchaseId: String(overrides.purchaseId ?? wire.purchaseId),
    payer: DEMO_PAYER.address,
    now: DEMO_NOW,
  });
}

/** Counts signatures and records whether the authorization was durable at signing time. */
function countingSigner(store: PaymentStore, purchaseId: string) {
  const calls: Array<{ durableBeforeSign: boolean }> = [];
  const signer: PaymentSigner = {
    address: DEMO_PAYER.address,
    async signTypedData(args) {
      const stored = store.get(purchaseId);
      calls.push({ durableBeforeSign: stored?.nonce === args.message.nonce && store.reservation(purchaseId)?.status === "held" });
      return DEMO_PAYER.signTypedData(args);
    },
  };
  return { signer, calls };
}

describe("Arc Testnet USDC domain", () => {
  it("matches the DOMAIN_SEPARATOR read from the live contract", () => {
    const separator = hashDomain({
      domain: { ...ARC_TESTNET.usdcDomain, chainId: BigInt(ARC_TESTNET.chainId), verifyingContract: ARC_TESTNET.usdc },
      types: {
        EIP712Domain: [
          { name: "name", type: "string" },
          { name: "version", type: "string" },
          { name: "chainId", type: "uint256" },
          { name: "verifyingContract", type: "address" },
        ],
      },
    });
    assert.equal(separator, ARC_TESTNET.domainSeparator);
  });
});

describe("PaymentStore and authorizeStoredPurchase", () => {
  it("persists purchase, reservation, and authorization before signing", async () => {
    const store = new PaymentStore();
    const request = demoRequest();
    const { record, reused } = store.reserveAndRecord({ missionId: "mission-1", request, now: DEMO_NOW });
    assert.equal(reused, false);
    assert.equal(record.status, "prepared");
    assert.equal(record.signature, null);
    assert.deepEqual(store.reservation(request.purchaseId), { amount: 50_000n, status: "held" });

    const { signer, calls } = countingSigner(store, request.purchaseId);
    const paid = await authorizeStoredPurchase({ store, purchaseId: request.purchaseId, signer, tokenDomain: ARC_TESTNET.usdcDomain, now: DEMO_NOW });
    assert.deepEqual(calls, [{ durableBeforeSign: true }]);
    assert.equal(paid.record.status, "signed");
    assert.equal(paid.authorization.nonce, record.nonce);

    const signer2 = await recoverTypedDataAddress({
      domain: { ...ARC_TESTNET.usdcDomain, chainId: request.chainId, verifyingContract: request.token },
      types: TRANSFER_WITH_AUTHORIZATION_TYPES,
      primaryType: "TransferWithAuthorization",
      message: {
        from: request.payer,
        to: request.payTo,
        value: 50_000n,
        validAfter: BigInt(request.validAfter),
        validBefore: BigInt(request.validBefore),
        nonce: record.nonce,
      },
      signature: paid.authorization.signature,
    });
    assert.equal(signer2.toLowerCase(), request.payer);
  });

  it("refuses to sign a purchase that was never reserved", async () => {
    const store = new PaymentStore();
    const { signer, calls } = countingSigner(store, "nope");
    await assert.rejects(
      authorizeStoredPurchase({ store, purchaseId: "nope", signer, tokenDomain: ARC_TESTNET.usdcDomain, now: DEMO_NOW }),
      /reserve before signing/,
    );
    assert.equal(calls.length, 0);
  });

  it("reuses the original authorization on retry, including after a restart", async () => {
    const path = join(dir, "retry.sqlite");
    const request = demoRequest();

    const first = new PaymentStore(path);
    first.reserveAndRecord({ missionId: "mission-1", request, now: DEMO_NOW });
    const a = countingSigner(first, request.purchaseId);
    const original = await authorizeStoredPurchase({ store: first, purchaseId: request.purchaseId, signer: a.signer, tokenDomain: ARC_TESTNET.usdcDomain, now: DEMO_NOW });
    first.close();

    const reopened = new PaymentStore(path);
    const again = reopened.reserveAndRecord({ missionId: "mission-1", request, now: DEMO_NOW + 10 });
    assert.equal(again.reused, true);
    const b = countingSigner(reopened, request.purchaseId);
    const retry = await authorizeStoredPurchase({ store: reopened, purchaseId: request.purchaseId, signer: b.signer, tokenDomain: ARC_TESTNET.usdcDomain, now: DEMO_NOW + 10 });

    assert.equal(retry.reused, true);
    assert.equal(b.calls.length, 0, "no second signature");
    assert.equal(retry.authorization.nonce, original.authorization.nonce);
    assert.equal(retry.authorization.signature, original.authorization.signature);
    assert.equal(retry.bindingHeader, original.bindingHeader);
    assert.equal(reopened.committedSpend("mission-1"), 50_000n, "reservation not doubled");
    reopened.close();
  });

  it("refuses a different request under the same purchase ID", () => {
    const store = new PaymentStore();
    store.reserveAndRecord({ missionId: "mission-1", request: demoRequest(), now: DEMO_NOW });
    const changed = parseResearchRequest({ ...demoRequest(), validBefore: demoRequest().validBefore + 1 });
    assert.throws(() => store.reserveAndRecord({ missionId: "mission-1", request: changed, now: DEMO_NOW }), ResearchRequestError);
  });

  it("refuses a second purchase for the same contract and evidence gap", () => {
    const store = new PaymentStore();
    store.reserveAndRecord({ missionId: "mission-1", request: demoRequest(), now: DEMO_NOW });
    const split = demoRequest({ purchaseId: "purchase-demo-002", quoteId: "quote-demo-002" });
    assert.throws(() => store.reserveAndRecord({ missionId: "mission-1", request: split, now: DEMO_NOW }), /duplicate purchase/);
    assert.equal(store.committedSpend("mission-1"), 50_000n);
  });

  it("enforces the mission budget across outstanding reservations", () => {
    const store = new PaymentStore(":memory:", {
      missionBudget: 120_000n,
      minAmount: 10_000n,
      autoApproveMax: 100_000n,
      gapMax: 500_000n,
      purchaseCap: 2_000_000n,
    });
    const reserve = (n: number) =>
      store.reserveAndRecord({
        missionId: "mission-1",
        request: demoRequest({
          purchaseId: `purchase-${n}`,
          quoteId: `quote-${n}`,
          parameters: { ...DEMO_PARAMETERS, contractId: `contract-${n}` },
        }),
        now: DEMO_NOW,
      });
    reserve(1);
    reserve(2);
    assert.throws(() => reserve(3), PolicyError);
    assert.equal(store.committedSpend("mission-1"), 100_000n);
  });

  it("applies the tiers: gap tier needs a material gap, owner tier waits for approval, cap and minimum refuse", async () => {
    const store = new PaymentStore();
    // Built directly: the buyer's catalog ceiling would already stop these amounts for this item.
    const gap = parseResearchRequest({ ...demoRequest(), amount: "100001" });
    assert.throws(() => store.reserveAndRecord({ missionId: "m", request: gap, now: DEMO_NOW }), PolicyError);
    assert.equal(store.reserveAndRecord({ missionId: "m", request: gap, now: DEMO_NOW, materialUnresolvedGap: true }).record.status, "prepared");

    const owner = parseResearchRequest({
      ...demoRequest({ purchaseId: "purchase-owner", quoteId: "quote-owner", parameters: { ...DEMO_PARAMETERS, contractId: "c-owner" } }),
      amount: "800000",
    });
    assert.equal(store.reserveAndRecord({ missionId: "m", request: owner, now: DEMO_NOW }).record.status, "awaiting_approval");
    await assert.rejects(
      authorizeStoredPurchase({ store, purchaseId: "purchase-owner", signer: DEMO_PAYER, tokenDomain: ARC_TESTNET.usdcDomain, now: DEMO_NOW }),
      /needs owner approval/,
    );

    const cap = parseResearchRequest({ ...demoRequest({ purchaseId: "purchase-cap", quoteId: "quote-cap" }), amount: "2000001" });
    assert.throws(() => store.reserveAndRecord({ missionId: "m2", request: cap, now: DEMO_NOW }), PolicyError);
    const under = demoRequest({ purchaseId: "purchase-under", quoteId: "quote-under", amount: "9999" });
    assert.throws(() => store.reserveAndRecord({ missionId: "m3", request: under, now: DEMO_NOW }), PolicyError);
  });

  it("feeds a stored authorization through merchant verification", async () => {
    const store = new PaymentStore();
    const request = demoRequest();
    store.reserveAndRecord({ missionId: "mission-1", request, now: DEMO_NOW });
    const paid = await authorizeStoredPurchase({ store, purchaseId: request.purchaseId, signer: DEMO_PAYER, tokenDomain: ARC_TESTNET.usdcDomain, now: DEMO_NOW });
    const verified = await verifyPaidRequest(
      {
        method: "POST",
        target: "/evidence/resolution-source",
        body: new TextEncoder().encode(JSON.stringify(DEMO_PARAMETERS)),
        bindingHeader: paid.bindingHeader,
        buyerSessionId: "session-demo-001",
        chainId: request.chainId,
        token: request.token,
        authorization: paid.authorization,
      },
      {
        config: DEMO_MERCHANT_CONFIG,
        loadQuote: () => demoQuote(),
        hasArtifact: (h) => h === DEMO_CONTENT_HASH,
        now: () => DEMO_NOW,
      },
    );
    assert.equal(verified.ok, true, JSON.stringify(verified));
  });
});
