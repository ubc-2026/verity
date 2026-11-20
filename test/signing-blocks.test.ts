import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { ARC_TESTNET } from "../src/payments/arc.ts";
import { buildResearchRequest } from "../src/payments/buyer.ts";
import { approvalTypedData } from "../src/payments/policy.ts";
import { authorizeStoredPurchase, type PaymentSigner } from "../src/payments/paymentService.ts";
import { BuyerService } from "../src/payments/purchase.ts";
import { parseQuote } from "../src/payments/quote.ts";
import { BLOCKED_STATE_STATUS, PaymentStore, PolicyError, signingBlockFor } from "../src/payments/store.ts";
import { DEMO_CATALOG, DEMO_CATALOG_ITEM, DEMO_NOW, DEMO_OWNER, DEMO_PARAMETERS, DEMO_PAYER, demoQuote } from "./fixtures/scenario.ts";

const dir = mkdtempSync(join(tmpdir(), "verity-blocks-"));
after(() => rmSync(dir, { recursive: true, force: true }));

function countingSigner() {
  let calls = 0;
  const signer: PaymentSigner = {
    address: DEMO_PAYER.address,
    signTypedData: async (args) => {
      calls += 1;
      return DEMO_PAYER.signTypedData(args);
    },
  };
  return { signer, calls: () => calls };
}

function autoRequest(purchaseId: string) {
  const { buyerSessionId: _session, ...wire } = demoQuote();
  return buildResearchRequest({
    catalog: DEMO_CATALOG,
    proposal: { catalogItemId: DEMO_CATALOG_ITEM.catalogItemId, parameters: { ...DEMO_PARAMETERS }, maxAmount: 2_000_000n },
    quote: parseQuote({ ...wire, purchaseId, quoteId: `quote-${purchaseId}` }),
    purchaseId,
    payer: DEMO_PAYER.address,
    now: DEMO_NOW,
  });
}

function filingQuote(purchaseId: string) {
  const item = DEMO_CATALOG.get("cat-filing-packet-v1")!;
  return parseQuote({
    quoteId: `quote-${purchaseId}`,
    purchaseId,
    merchantId: item.merchantId,
    catalogItemId: item.catalogItemId,
    method: "POST",
    resourceUrl: item.resourceUrl,
    parameters: { contractId: `contract-${purchaseId}`, evidenceType: "regulatory_filing" },
    contentType: item.contentType,
    expectedContentHash: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    chainId: item.chainId,
    token: item.token,
    payTo: item.payTo,
    amount: item.price.toString(10),
    expiresAt: DEMO_NOW + 600,
  });
}

function reserveFiling(store: PaymentStore, purchaseId: string) {
  const quote = filingQuote(purchaseId);
  const request = buildResearchRequest({
    catalog: DEMO_CATALOG,
    proposal: { catalogItemId: quote.catalogItemId, parameters: quote.parameters, maxAmount: 2_000_000n },
    quote,
    purchaseId,
    payer: DEMO_PAYER.address,
    now: DEMO_NOW,
  });
  store.reserveAndRecord({ missionId: "m", request, now: DEMO_NOW, materialUnresolvedGap: true });
  assert.equal(store.get(purchaseId)!.status, "awaiting_approval");
  return quote;
}

const sign = (store: PaymentStore, purchaseId: string, signer: PaymentSigner, now = DEMO_NOW) =>
  authorizeStoredPurchase({ store, purchaseId, signer, tokenDomain: ARC_TESTNET.usdcDomain, now });

describe("signing is refused for every blocked state", () => {
  it("keeps both status vocabularies and maps each name onto a blocked authorization status", () => {
    assert.deepEqual(BLOCKED_STATE_STATUS, { denied: "denied", timed_out: "denied", rejected: "rejected", expired: "expired" });
    assert.equal(signingBlockFor("denied", [{ outcome: "denied" }]), "denied");
    assert.equal(signingBlockFor("denied", [{ outcome: "timed_out" }]), "timed_out");
    assert.equal(signingBlockFor("rejected"), "rejected");
    assert.equal(signingBlockFor("expired"), "expired");
    assert.equal(signingBlockFor("prepared", [{ outcome: "verbal_yes" }, { outcome: "approved" }]), null);
  });

  it("signs an allowed fixture purchase and an owner-approved purchase", async () => {
    const allowed = new PaymentStore();
    const auto = countingSigner();
    const request = autoRequest("p-auto");
    allowed.reserveAndRecord({ missionId: "m", request, now: DEMO_NOW });
    const paid = await sign(allowed, "p-auto", auto.signer);
    assert.equal(auto.calls(), 1);
    assert.equal(paid.record.status, "signed");
    assert.equal(paid.reused, false);

    const store = new PaymentStore();
    const quote = reserveFiling(store, "p-approved");
    const owner = countingSigner();
    const buyer = new BuyerService({
      store,
      catalog: DEMO_CATALOG,
      owner: DEMO_OWNER.address,
      signer: owner.signer,
      tokenDomain: ARC_TESTNET.usdcDomain,
      missionId: "m",
    });
    const accepted = {
      selection: { catalogItemId: quote.catalogItemId, parameters: quote.parameters, maxAmount: 2_000_000n },
      groupKey: "filing",
      catalogParameters: {},
      materialUnresolvedGap: true as const,
    };
    const waiting = await buyer.purchase({ accepted, purchaseId: "p-approved", quote, now: DEMO_NOW });
    assert.equal(waiting.status, "awaiting_approval");
    assert.equal(owner.calls(), 0);
    if (waiting.status !== "awaiting_approval") return;
    const signature = await DEMO_OWNER.signTypedData(approvalTypedData(waiting.request, waiting.requestHash));
    const ready = await buyer.purchase({ accepted, purchaseId: "p-approved", quote, now: DEMO_NOW, ownerSignature: signature });
    assert.equal(ready.status, "authorized");
    assert.equal(owner.calls(), 1);
    if (ready.status === "authorized") assert.ok(ready.payment.authorization.signature);
    allowed.close();
    store.close();
  });

  it("refuses to sign a denied purchase and a timed-out purchase", async () => {
    for (const outcome of ["denied", "timed_out"] as const) {
      const store = new PaymentStore();
      const purchaseId = `p-${outcome}`;
      reserveFiling(store, purchaseId);
      store.denyAwaitingApproval({ purchaseId, outcome, channel: outcome === "timed_out" ? "timeout" : "voice_call", now: DEMO_NOW });
      assert.equal(store.get(purchaseId)!.status, BLOCKED_STATE_STATUS[outcome]);
      assert.equal(signingBlockFor(store.get(purchaseId)!.status, store.approvalDecisions(purchaseId)), outcome);
      const signer = countingSigner();
      await assert.rejects(sign(store, purchaseId, signer.signer), /denied or timed out and can never be signed/);
      assert.equal(signer.calls(), 0);
      assert.equal(store.get(purchaseId)!.signature, null);
      store.close();
    }
  });

  it("refuses to sign a rejected purchase and an expired purchase", async () => {
    const rejected = new PaymentStore();
    reserveFiling(rejected, "p-rejected");
    rejected.recordOwnerRejection({ purchaseId: "p-rejected", reason: "no", now: DEMO_NOW });
    assert.equal(signingBlockFor(rejected.get("p-rejected")!.status), "rejected");
    const rejectedSigner = countingSigner();
    await assert.rejects(sign(rejected, "p-rejected", rejectedSigner.signer), PolicyError);
    assert.equal(rejectedSigner.calls(), 0);

    const expired = new PaymentStore();
    expired.reserveAndRecord({ missionId: "m", request: autoRequest("p-expired"), now: DEMO_NOW });
    assert.equal(expired.expire("p-expired", DEMO_NOW), true);
    assert.equal(signingBlockFor(expired.get("p-expired")!.status), "expired");
    const expiredSigner = countingSigner();
    await assert.rejects(sign(expired, "p-expired", expiredSigner.signer, DEMO_NOW), /is expired and cannot be signed/);
    assert.equal(expiredSigner.calls(), 0);
    rejected.close();
    expired.close();
  });

  it("keeps a pause across a restart and still signs after resume", async () => {
    const path = join(dir, "pause.sqlite");
    const first = new PaymentStore(path);
    const buyer = new BuyerService({
      store: first,
      catalog: DEMO_CATALOG,
      owner: DEMO_OWNER.address,
      signer: DEMO_PAYER,
      tokenDomain: ARC_TESTNET.usdcDomain,
      missionId: "m",
    });
    first.reserveAndRecord({ missionId: "m", request: autoRequest("p-pause"), now: DEMO_NOW });
    buyer.pause(DEMO_NOW, "incident");
    const other = new BuyerService({
      store: first,
      catalog: DEMO_CATALOG,
      owner: DEMO_OWNER.address,
      signer: DEMO_PAYER,
      tokenDomain: ARC_TESTNET.usdcDomain,
      missionId: "m",
    });
    assert.equal(other.paused, true, "pause lives in the store, not on one buyer");
    first.close();

    const reopened = new PaymentStore(path);
    const resumed = new BuyerService({
      store: reopened,
      catalog: DEMO_CATALOG,
      owner: DEMO_OWNER.address,
      signer: DEMO_PAYER,
      tokenDomain: ARC_TESTNET.usdcDomain,
      missionId: "m",
    });
    assert.equal(resumed.paused, true);
    const signer = countingSigner();
    await assert.rejects(sign(reopened, "p-pause", signer.signer), /paused/);
    assert.equal(signer.calls(), 0);
    resumed.resume(DEMO_NOW);
    assert.equal(resumed.paused, false);
    const paid = await sign(reopened, "p-pause", signer.signer);
    assert.equal(signer.calls(), 1);
    assert.equal(paid.record.status, "signed");
    reopened.close();
  });
});
