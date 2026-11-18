import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { catalogById } from "../src/payments/catalog.ts";
import { PaymentService } from "../src/payments/purchase.ts";
import { listen } from "../src/payments/server.ts";
import { MerchantService, savedQuoteWire } from "../src/payments/service.ts";
import { parseQuote } from "../src/payments/quote.ts";
import type { PaidRequest } from "../src/payments/merchant.ts";
import {
  DEMO_CATALOG_ITEM,
  DEMO_MERCHANT_CONFIG,
  DEMO_MERCHANT_SIGNER,
  DEMO_NOW,
  DEMO_OWNER,
  DEMO_PARAMETERS,
  DEMO_PAYER,
  signTransferWithAuthorization,
} from "./fixtures/scenario.ts";

function merchant() {
  return new MerchantService({ config: DEMO_MERCHANT_CONFIG, signer: DEMO_MERCHANT_SIGNER, now: () => DEMO_NOW });
}

async function paid(service: MerchantService, purchaseId: string, catalogItemId = DEMO_CATALOG_ITEM.catalogItemId): Promise<PaidRequest> {
  const item = catalogById().get(catalogItemId);
  assert.ok(item);
  const saved = service.issueQuote({
    catalogItemId,
    purchaseId,
    buyerSessionId: "session-demo-001",
    parameters: { contractId: "demo-contract-001", evidenceType: item.evidenceType },
  });
  const payments = new PaymentService({ catalog: catalogById(), owner: DEMO_OWNER.address });
  const begun = await payments.begin({
    selection: {
      catalogItemId,
      parameters: { contractId: "demo-contract-001", evidenceType: item.evidenceType },
      maxAmount: item.maxAmount,
    },
    groupKey: `${purchaseId}:gap`,
    quote: parseQuote(savedQuoteWire(saved)),
    payer: DEMO_PAYER.address,
    now: DEMO_NOW,
    materialUnresolvedGap: true,
  });
  assert.equal(begun.status, "ready");
  if (begun.status !== "ready") throw new Error("purchase was not ready");
  return {
    method: "POST",
    target: new URL(item.resourceUrl).pathname,
    body: new TextEncoder().encode(JSON.stringify({ contractId: "demo-contract-001", evidenceType: item.evidenceType })),
    bindingHeader: begun.prepared.bindingHeader,
    buyerSessionId: "session-demo-001",
    chainId: begun.request.chainId,
    token: begun.request.token,
    authorization: {
      from: begun.request.payer,
      to: begun.request.payTo,
      value: begun.request.amount,
      validAfter: String(begun.request.validAfter),
      validBefore: String(begun.request.validBefore),
      nonce: begun.prepared.record.nonce,
      signature: await signTransferWithAuthorization(begun.request, begun.prepared.record.nonce),
    },
  };
}

describe("mock merchant", () => {
  it("verifies one purchase and rejects a replay, a swapped document, and a changed URL", async () => {
    const service = merchant();
    const honest = await paid(service, "purchase-honest-001");
    const verified = await service.verify(honest);
    assert.equal(verified.outcome, "verified", JSON.stringify(verified));
    assert.equal(verified.checks.requestHash.ok, true);
    assert.equal(verified.checks.amount.ok, true);
    assert.equal(verified.checks.merchant.ok, true);
    assert.equal(verified.checks.authorization.ok, true);
    assert.equal(verified.checks.nonce.ok, true);
    assert.equal(verified.checks.resource.ok, true);
    assert.match(verified.delivery?.body ?? "", /Cutoff policy excerpt/);

    const replay = await service.attackDuplicate(honest);
    assert.equal(replay.outcome, "rejected");
    assert.equal(replay.reason, "nonce_replay");

    const other = await paid(service, "purchase-swap-001");
    const swapped = await service.attackWrongResource(other, "cat-filing-packet-v1");
    assert.equal(swapped.outcome, "rejected");
    assert.equal(swapped.reason, "wrong_resource");
    assert.equal(swapped.delivery, null);

    const moved = await paid(service, "purchase-url-001");
    const changed = await service.attackChangedUrl(moved, "/evidence/other");
    assert.equal(changed.outcome, "rejected");
    assert.equal(changed.checks.requestHash.ok, false);

    const statuses = service.ledger.entries().map((entry) => `${entry.purchaseId}:${entry.status}`);
    assert.ok(statuses.includes("purchase-honest-001:reconciled"));
    assert.ok(statuses.includes("purchase-honest-001:duplicate"));
    assert.ok(statuses.includes("purchase-swap-001:mismatch"));
    assert.ok(statuses.includes("purchase-url-001:mismatch"));
  });

  it("serves the same report over HTTP", async () => {
    const service = merchant();
    const http = await listen(service);
    try {
      const payment = await paid(service, "purchase-http-001");
      const response = await fetch(`http://127.0.0.1:${http.port}/verify`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...payment,
          body: DEMO_PARAMETERS,
          token: payment.token,
        }),
      });
      const report = (await response.json()) as { outcome: string };
      assert.equal(response.status, 200);
      assert.equal(report.outcome, "verified");
    } finally {
      await http.close();
    }
  });
});
