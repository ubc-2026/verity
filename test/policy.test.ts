import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { assessPolicy, MISSION_BUDGET } from "../src/payments/policy.ts";
import { catalogById } from "../src/payments/catalog.ts";
import { approvalTypedData } from "../src/payments/policy.ts";
import { BuyerService } from "../src/payments/purchase.ts";
import { PaymentStore } from "../src/payments/store.ts";
import { computeRequestHash } from "../src/payments/researchRequest.ts";
import { parseQuote } from "../src/payments/quote.ts";
import { DEMO_NOW, DEMO_OWNER, DEMO_OTHER_SIGNER, DEMO_PAYER } from "./fixtures/scenario.ts";

const catalog = catalogById();
const merchants = ["verity-demo-merchant"];
const items = [...catalog.keys()];

function assess(amount: bigint, extra: Partial<Parameters<typeof assessPolicy>[0]> = {}) {
  return assessPolicy({
    amount,
    now: DEMO_NOW,
    expiresAt: DEMO_NOW + 600,
    merchantId: "verity-demo-merchant",
    catalogItemId: "resolution-source-excerpt-v1",
    groupKey: "demo-contract-001:resolution_source",
    materialUnresolvedGap: false,
    paused: false,
    allowlistedMerchants: merchants,
    allowlistedItems: items,
    reservedKeys: [],
    spentKeys: [],
    committedBaseUnits: 0n,
    budget: MISSION_BUDGET,
    ...extra,
  });
}

describe("spending policy", () => {
  it("auto-approves the demo quote of 0.05 USDC", () => {
    assert.deepEqual(assess(50_000n), { decision: "allow", tier: "auto" });
  });

  it("requires a material gap between 0.11 and 0.50 USDC", () => {
    const blocked = assess(200_000n);
    assert.equal(blocked.decision, "reject");
    const allowed = assess(200_000n, { materialUnresolvedGap: true });
    assert.deepEqual(allowed, { decision: "allow", tier: "gap" });
  });

  it("requires the owner between 0.51 and 2.00 USDC and rejects anything above", () => {
    assert.equal(assess(800_000n).decision, "needs_approval");
    assert.equal(assess(2_000_000n).decision, "needs_approval");
    const over = assess(2_000_001n);
    assert.equal(over.decision, "reject");
    if (over.decision === "reject") assert.match(over.reason, /2\.00/);
  });

  it("rejects a paused service, an unknown merchant, a duplicate gap, and a blown budget", () => {
    assert.equal(assess(50_000n, { paused: true }).decision, "reject");
    assert.equal(assess(50_000n, { merchantId: "someone-else" }).decision, "reject");
    assert.equal(assess(50_000n, { spentKeys: ["demo-contract-001:resolution_source"] }).decision, "reject");
    const budget = assess(50_000n, { committedBaseUnits: MISSION_BUDGET });
    assert.equal(budget.decision, "reject");
    if (budget.decision === "reject") assert.match(budget.reason, /budget/);
  });

  it("holds the budget until the owner signs, then refuses a second use of that approval", async () => {
    const item = catalog.get("cat-filing-packet-v1");
    assert.ok(item);
    const quoteFor = (purchaseId: string, contractId: string) =>
      parseQuote({
        quoteId: `quote-${purchaseId}`,
        purchaseId,
        merchantId: item.merchantId,
        catalogItemId: item.catalogItemId,
        method: "POST",
        resourceUrl: item.resourceUrl,
        parameters: { contractId, evidenceType: "regulatory_filing" },
        contentType: item.contentType,
        expectedContentHash: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        chainId: item.chainId,
        token: item.token,
        payTo: item.payTo,
        amount: item.price.toString(10),
        expiresAt: DEMO_NOW + 600,
      });
    const accepted = (contractId: string) => ({
      selection: { catalogItemId: "cat-filing-packet-v1", parameters: { contractId, evidenceType: "regulatory_filing" }, maxAmount: 2_000_000n },
      groupKey: `${contractId}:GAP-FILING`,
      catalogParameters: {},
      materialUnresolvedGap: true as const,
    });
    const store = new PaymentStore();
    const buyer = new BuyerService({
      store,
      catalog,
      owner: DEMO_OWNER.address,
      signer: DEMO_PAYER,
      tokenDomain: { name: "USDC", version: "2" },
      missionId: "mission-approval",
    });
    const quote = quoteFor("purchase-filing-001", "demo-contract-001");
    const base = { accepted: accepted("demo-contract-001"), purchaseId: "purchase-filing-001", quote, now: DEMO_NOW };

    const waiting = await buyer.purchase(base);
    assert.equal(waiting.status, "awaiting_approval");
    assert.equal(store.committedSpend("mission-approval"), 800_000n);
    assert.equal(store.get("purchase-filing-001")?.signature, null);
    if (waiting.status !== "awaiting_approval") return;
    assert.match(waiting.explanation.text, /needs your wallet signature/);

    const wrong = await buyer.purchase({ ...base, ownerSignature: await DEMO_OTHER_SIGNER.signTypedData(waiting.approval) });
    assert.equal(wrong.status, "rejected");
    assert.equal(store.get("purchase-filing-001")?.status, "awaiting_approval");
    assert.equal(store.committedSpend("mission-approval"), 800_000n);

    const approval = await DEMO_OWNER.signTypedData(approvalTypedData(waiting.request, computeRequestHash(waiting.request)));
    const ready = await buyer.purchase({ ...base, ownerSignature: approval });
    assert.equal(ready.status, "authorized");

    await assert.rejects(
      store.recordOwnerApproval({ purchaseId: "purchase-filing-001", signature: approval, owner: DEMO_OWNER.address, now: DEMO_NOW }),
      /not awaiting owner approval/,
    );

    // The same signature cannot approve a different purchase: it binds the purchase ID and request hash.
    const other = { accepted: accepted("demo-contract-002"), purchaseId: "purchase-filing-002", quote: quoteFor("purchase-filing-002", "demo-contract-002"), now: DEMO_NOW };
    assert.equal((await buyer.purchase(other)).status, "awaiting_approval");
    const reused = await buyer.purchase({ ...other, ownerSignature: approval });
    assert.equal(reused.status, "rejected");
    if (reused.status === "rejected") assert.match(reused.reason, /does not match the enrolled wallet/);
  });
});
