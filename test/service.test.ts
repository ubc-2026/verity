import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Hex } from "viem";
import { BINDING_HEADER } from "../src/payments/binding.ts";
import { catalogById } from "../src/payments/catalog.ts";
import { acceptDelivery, RECEIPT_HEADER, type DeliveryAcceptanceStore } from "../src/payments/deliveryReceipt.ts";
import { acceptPurchaseProposal } from "../src/payments/proposal.ts";
import { BuyerService } from "../src/payments/purchase.ts";
import { parseQuote } from "../src/payments/quote.ts";
import { encodePaymentHeader, listen, PAYMENT_HEADER } from "../src/payments/server.ts";
import { MerchantService } from "../src/payments/service.ts";
import { PaymentStore } from "../src/payments/store.ts";
import { NYC_PURCHASE_PROPOSAL } from "./fixtures/nycProposal.ts";
import { DEMO_MERCHANT_CONFIG, DEMO_MERCHANT_SIGNER, DEMO_NOW, DEMO_OWNER, DEMO_PAYER } from "./fixtures/scenario.ts";

const TOKEN = "test-buyer-session-token-0001";
const TX: Hex = `0x${"ab".repeat(32)}`;

async function setup() {
  let settles = 0;
  const merchant = new MerchantService({
    config: DEMO_MERCHANT_CONFIG,
    signer: DEMO_MERCHANT_SIGNER,
    settlement: { settle: async () => (settles++, { txHash: TX }) },
    now: () => DEMO_NOW,
    sessions: { [TOKEN]: "session-a" },
  });
  const server = await listen(merchant, { origin: DEMO_MERCHANT_CONFIG.origin });
  const base = `http://127.0.0.1:${server.port}`;
  const store = new PaymentStore();
  const buyer = new BuyerService({ store, catalog: catalogById(), owner: DEMO_OWNER.address, signer: DEMO_PAYER, tokenDomain: { name: "USDC", version: "2" }, missionId: "m" });
  const accepted = acceptPurchaseProposal(NYC_PURCHASE_PROPOSAL, catalogById());
  const post = (path: string, body: string, headers: Record<string, string> = {}) =>
    fetch(`${base}${path}`, { method: "POST", headers: { authorization: `Bearer ${TOKEN}`, ...headers }, body });

  const quoteBody = (purchaseId: string, extra: Record<string, unknown> = {}) =>
    JSON.stringify({ catalogItemId: accepted.selection.catalogItemId, purchaseId, parameters: accepted.selection.parameters, catalogParameters: accepted.catalogParameters, ...extra });

  async function authorized(purchaseId = "purchase-svc-001") {
    const response = await post("/quotes", quoteBody(purchaseId));
    assert.equal(response.status, 402);
    const quote = parseQuote(((await response.json()) as { quote: unknown }).quote);
    const result = await buyer.purchase({ accepted, purchaseId, quote, now: DEMO_NOW });
    assert.equal(result.status, "authorized");
    if (result.status !== "authorized") throw new Error("not authorized");
    return result;
  }
  function paidHeaders(result: Awaited<ReturnType<typeof authorized>>) {
    return {
      [BINDING_HEADER]: result.payment.bindingHeader,
      [PAYMENT_HEADER]: encodePaymentHeader({ chainId: result.request.chainId, token: result.request.token, authorization: result.payment.authorization }),
    };
  }
  const recorded: unknown[] = [];
  const sink: DeliveryAcceptanceStore = { recordVerifiedDelivery: (args) => (recorded.push(args), { kind: "delivered_payment_unconfirmed", purchaseId: args.receipt.purchaseId }) };
  return {
    post, quoteBody, authorized, paidHeaders, store, sink, recorded, settles: () => settles,
    close: async () => (await server.close(), merchant.close()),
  };
}

describe("merchant HTTP route", () => {
  it("quotes only to an authenticated session and echoes the buyer's purchase ID", async () => {
    const t = await setup();
    try {
      const anonymous = await fetch(`${(await t.post("/catalog", "")).url.replace("/catalog", "")}/quotes`, { method: "POST", body: t.quoteBody("purchase-anon") });
      assert.equal(anonymous.status, 401);
      const response = await t.post("/quotes", t.quoteBody("purchase-echo-1"));
      assert.equal(response.status, 402);
      assert.equal(((await response.json()) as { quote: { purchaseId: string } }).quote.purchaseId, "purchase-echo-1");
      const empty = await t.post("/quotes", t.quoteBody("purchase-echo-2", { catalogParameters: { station: "Central Park, NY (CLINYC)", date: "" } }));
      assert.equal(empty.status, 400);
      const other = await t.post("/quotes", t.quoteBody("purchase-echo-3", { catalogParameters: { station: "Central Park, NY (CLINYC)", date: "2026-11-19" } }));
      assert.equal(other.status, 400);
    } finally {
      await t.close();
    }
  });

  it("delivers once through the durable handler; a retry replays the receipt without settling again", async () => {
    const t = await setup();
    try {
      const result = await t.authorized();
      const body = JSON.stringify(result.request.parameters);
      const first = await t.post("/evidence/nws-cli-settlement", body, t.paidHeaders(result));
      assert.equal(first.status, 200);
      const bytes = new Uint8Array(await first.arrayBuffer());
      const accepted = await acceptDelivery({
        response: { body: bytes, receiptHeader: first.headers.get(RECEIPT_HEADER) ?? undefined },
        trusted: { merchantId: DEMO_MERCHANT_CONFIG.merchantId, receiptSigner: DEMO_MERCHANT_SIGNER.address },
        request: t.store.get("purchase-svc-001")!.request,
        store: t.sink,
        now: DEMO_NOW,
      });
      assert.equal(accepted.accepted, true);
      const retry = await t.post("/evidence/nws-cli-settlement", body, t.paidHeaders(result));
      assert.equal(retry.status, 200);
      assert.equal(retry.headers.get(RECEIPT_HEADER), first.headers.get(RECEIPT_HEADER));
      assert.equal(t.settles(), 1);
    } finally {
      await t.close();
    }
  });

  it("rejects a changed URL, a changed body, a missing session, and a missing payment header without settling", async () => {
    const t = await setup();
    try {
      const result = await t.authorized();
      const body = JSON.stringify(result.request.parameters);
      assert.equal((await t.post("/evidence/resolution-source", body, t.paidHeaders(result))).status, 402);
      const changed = JSON.stringify({ ...result.request.parameters, contractId: "fx-other" });
      assert.equal((await t.post("/evidence/nws-cli-settlement", changed, t.paidHeaders(result))).status, 402);
      const noSession = await fetch((await t.post("/catalog", "")).url.replace("/catalog", "/evidence/nws-cli-settlement"), {
        method: "POST",
        headers: t.paidHeaders(result),
        body,
      });
      assert.equal(noSession.status, 401);
      assert.equal((await t.post("/evidence/nws-cli-settlement", body, { [BINDING_HEADER]: result.payment.bindingHeader })).status, 400);
      assert.equal(t.settles(), 0);
    } finally {
      await t.close();
    }
  });
});
