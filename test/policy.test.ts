import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { assessPolicy, MISSION_BUDGET } from "../src/payments/policy.ts";
import { catalogById } from "../src/payments/catalog.ts";
import { approvalTypedData, PaymentService } from "../src/payments/purchase.ts";
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
    const quote = parseQuote({
      quoteId: "quote-filing-001",
      purchaseId: "purchase-filing-001",
      merchantId: item.merchantId,
      catalogItemId: item.catalogItemId,
      method: "POST",
      resourceUrl: item.resourceUrl,
      parameters: { contractId: "demo-contract-001", evidenceType: "regulatory_filing" },
      contentType: item.contentType,
      expectedContentHash: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      chainId: item.chainId,
      token: item.token,
      payTo: item.payTo,
      amount: item.price.toString(10),
      expiresAt: DEMO_NOW + 600,
    });
    const payments = new PaymentService({ catalog, owner: DEMO_OWNER.address });
    const selection = {
      catalogItemId: "cat-filing-packet-v1",
      parameters: { contractId: "demo-contract-001", evidenceType: "regulatory_filing" },
      maxAmount: 2_000_000n,
    };
    const waiting = await payments.begin({
      selection,
      groupKey: "demo-contract-001:GAP-FILING",
      quote,
      payer: DEMO_PAYER.address,
      now: DEMO_NOW,
      materialUnresolvedGap: true,
    });
    assert.equal(waiting.status, "awaiting_approval");
    assert.equal(payments.budget.committed(), 800_000n);
    if (waiting.status !== "awaiting_approval") return;

    const wrong = await payments.begin({
      selection,
      groupKey: "demo-contract-001:GAP-FILING",
      quote,
      payer: DEMO_PAYER.address,
      now: DEMO_NOW,
      materialUnresolvedGap: true,
      ownerSignature: await DEMO_OTHER_SIGNER.signTypedData(approvalTypedData(waiting.request, waiting.requestHash)),
    });
    assert.equal(wrong.status, "rejected");
    assert.equal(payments.budget.committed(), 800_000n);

    const ready = await payments.begin({
      selection,
      groupKey: "demo-contract-001:GAP-FILING",
      quote,
      payer: DEMO_PAYER.address,
      now: DEMO_NOW,
      materialUnresolvedGap: true,
      ownerSignature: await DEMO_OWNER.signTypedData(approvalTypedData(waiting.request, computeRequestHash(waiting.request))),
    });
    assert.equal(ready.status, "ready");
    payments.confirm("demo-contract-001:GAP-FILING");

    const again = await payments.begin({
      selection,
      groupKey: "demo-contract-001:GAP-FILING",
      quote,
      payer: DEMO_PAYER.address,
      now: DEMO_NOW,
      materialUnresolvedGap: true,
      ownerSignature: await DEMO_OWNER.signTypedData(approvalTypedData(waiting.request, waiting.requestHash)),
    });
    assert.equal(again.status, "rejected");
    if (again.status === "rejected") assert.match(again.decision.reason, /duplicate|already used/);
  });
});
