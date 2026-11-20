import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { ARC_TESTNET } from "../src/payments/arc.ts";
import { buildResearchRequest } from "../src/payments/buyer.ts";
import { authorizeStoredPurchase } from "../src/payments/paymentService.ts";
import { parseQuote } from "../src/payments/quote.ts";
import { DEMO_POLICY, PaymentStore, PolicyError } from "../src/payments/store.ts";
import { DEMO_CATALOG, DEMO_CATALOG_ITEM, DEMO_NOW, DEMO_PARAMETERS, DEMO_PAYER, demoQuote } from "./fixtures/scenario.ts";

const dir = mkdtempSync(join(tmpdir(), "verity-controls-"));
after(() => rmSync(dir, { recursive: true, force: true }));

function request(purchaseId: string, amount = "50000", evidenceType = DEMO_PARAMETERS.evidenceType) {
  const { buyerSessionId: _s, ...wire } = demoQuote();
  const parameters = { ...DEMO_PARAMETERS, evidenceType };
  return buildResearchRequest({
    catalog: DEMO_CATALOG,
    proposal: { catalogItemId: DEMO_CATALOG_ITEM.catalogItemId, parameters, maxAmount: 2_000_000n },
    quote: parseQuote({ ...wire, purchaseId, quoteId: `quote-${purchaseId}`, amount, parameters }),
    purchaseId,
    payer: DEMO_PAYER.address,
    now: DEMO_NOW,
  });
}
const sign = (store: PaymentStore, purchaseId: string, now = DEMO_NOW) =>
  authorizeStoredPurchase({ store, purchaseId, signer: DEMO_PAYER, tokenDomain: ARC_TESTNET.usdcDomain, now });

describe("payment controls", () => {
  it("keeps the pause switch across a restart and refuses to reserve or sign while paused", async () => {
    const path = join(dir, "pause.sqlite");
    const first = new PaymentStore(path);
    first.reserveAndRecord({ missionId: "m", request: request("p-1"), now: DEMO_NOW });
    first.setPaused(true, DEMO_NOW, "incident");
    first.close();
    const store = new PaymentStore(path);
    assert.equal(store.isPaused(), true);
    assert.throws(() => store.reserveAndRecord({ missionId: "m", request: request("p-2", "50000", "other_type"), now: DEMO_NOW }), /paused/);
    await assert.rejects(sign(store, "p-1"), /paused/);
    store.setPaused(false, DEMO_NOW);
    await sign(store, "p-1");
    store.close();
  });

  it("an owner rejection releases the held reservation and the purchase can never be signed", async () => {
    // Owner tier starts above 0.01 USDC here, so the 0.05 USDC demo item waits for approval.
    const store = new PaymentStore(":memory:", { ...DEMO_POLICY, autoApproveMax: 10_000n, gapMax: 10_000n });
    store.reserveAndRecord({ missionId: "m", request: request("p-big"), now: DEMO_NOW, materialUnresolvedGap: true });
    assert.equal(store.get("p-big")!.status, "awaiting_approval");
    assert.equal(store.budget("m").held, 50_000n);
    store.recordOwnerRejection({ purchaseId: "p-big", reason: "no", now: DEMO_NOW });
    assert.deepEqual([store.get("p-big")!.status, store.budget("m").held, store.budget("m").released], ["rejected", 0n, 50_000n]);
    await assert.rejects(sign(store, "p-big"), PolicyError);
    assert.throws(() => store.recordOwnerRejection({ purchaseId: "p-big", reason: "again", now: DEMO_NOW }), /not awaiting/);
  });

  it("held funds count against the budget until released by expiry", () => {
    const store = new PaymentStore(":memory:", { ...DEMO_POLICY, missionBudget: 80_000n });
    const first = request("p-a");
    store.reserveAndRecord({ missionId: "m", request: first, now: DEMO_NOW });
    assert.throws(() => store.reserveAndRecord({ missionId: "m", request: request("p-b", "50000", "other_type"), now: DEMO_NOW }), /mission budget exceeded/);
    assert.deepEqual(store.expireStale(first.validBefore - 1), []);
    assert.deepEqual(store.expireStale(first.validBefore), ["p-a"]);
    assert.equal(store.budget("m").held, 0n);
    store.reserveAndRecord({ missionId: "m", request: request("p-b", "50000", "other_type"), now: DEMO_NOW });
  });

  it("never expires a signed authorization; its outcome is reconciled on chain", async () => {
    const store = new PaymentStore(":memory:");
    const req = request("p-s");
    store.reserveAndRecord({ missionId: "m", request: req, now: DEMO_NOW });
    await sign(store, "p-s");
    assert.deepEqual(store.expireStale(req.validBefore + 10), []);
    assert.equal(store.get("p-s")!.status, "signed");
    assert.equal(store.budget("m").held, 50_000n);
  });

  it("refuses to sign once the authorization window has closed", async () => {
    const store = new PaymentStore(":memory:");
    const req = request("p-late");
    store.reserveAndRecord({ missionId: "m", request: req, now: DEMO_NOW });
    await assert.rejects(sign(store, "p-late", req.validBefore), /expired before signing/);
    assert.equal(store.get("p-late")!.status, "expired");
    assert.equal(store.budget("m").held, 0n);
  });
});
