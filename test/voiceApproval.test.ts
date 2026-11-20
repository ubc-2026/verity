import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { catalogById } from "../src/payments/catalog.ts";
import { approvalTypedData } from "../src/payments/policy.ts";
import { BuyerService } from "../src/payments/purchase.ts";
import { parseQuote } from "../src/payments/quote.ts";
import { computeRequestHash } from "../src/payments/researchRequest.ts";
import { PaymentStore } from "../src/payments/store.ts";
import {
  ElevenLabsOwnerCaller,
  elevenLabsConfigFromEnv,
  ownerCallerFromEnv,
  generateApprovalCode,
  type OwnerCaller,
  type OwnerCallResult,
} from "../src/payments/voiceApproval.ts";
import { DEMO_NOW, DEMO_OWNER, DEMO_PAYER } from "./fixtures/scenario.ts";

const catalog = catalogById();
const item = catalog.get("cat-filing-packet-v1")!;
const PURCHASE = "purchase-voice-001";

function setup(caller: OwnerCaller | undefined) {
  const quote = parseQuote({
    quoteId: `quote-${PURCHASE}`,
    purchaseId: PURCHASE,
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
  const store = new PaymentStore();
  const buyer = new BuyerService({
    store,
    catalog,
    owner: DEMO_OWNER.address,
    signer: DEMO_PAYER,
    tokenDomain: { name: "USDC", version: "2" },
    missionId: "mission-voice",
    ...(caller ? { ownerCaller: caller } : {}),
  });
  const accepted = {
    selection: { catalogItemId: item.catalogItemId, parameters: { contractId: "demo-contract-001", evidenceType: "regulatory_filing" }, maxAmount: 2_000_000n },
    groupKey: "demo-contract-001:GAP-FILING",
    catalogParameters: {},
    materialUnresolvedGap: true as const,
  };
  return { store, buyer, input: { accepted, purchaseId: PURCHASE, quote, now: DEMO_NOW } };
}

/** A caller that reads back whatever digits `spoken` returns, given the code the owner was shown. */
function codeCaller(spoken: (shown: string) => string | null, verbal: "yes" | "no" = "yes") {
  let shown = "";
  const caller: OwnerCaller = { async call() { return { verbal, conversationId: "conv-code", spokenCode: spoken(shown) }; } };
  return { caller, codeCheck: { show: ({ code }: { code: string }) => void (shown = code) } };
}

function fakeCaller(result: OwnerCallResult | Error) {
  const calls: { summary: string }[] = [];
  const caller: OwnerCaller = {
    async call(args) {
      calls.push({ summary: args.summary });
      if (result instanceof Error) throw result;
      return result;
    },
  };
  return { caller, calls };
}

describe("voice-based spending approvals", () => {
  it("a spoken yes alone never releases funds: the purchase stays unsigned until the wallet signs", async () => {
    const { caller, calls } = fakeCaller({ verbal: "yes", conversationId: "conv-1" });
    const { store, buyer, input } = setup(caller);

    const waiting = await buyer.purchase(input);
    assert.equal(waiting.status, "awaiting_approval");
    assert.equal(calls.length, 1);
    assert.match(calls[0]!.summary, /cat-filing-packet-v1/);
    assert.match(calls[0]!.summary, /demo-contract-001/);
    assert.equal(store.get(PURCHASE)?.status, "awaiting_approval");
    assert.equal(store.get(PURCHASE)?.signature, null);
    assert.equal(store.committedSpend("mission-voice"), 800_000n);
    assert.deepEqual(store.approvalDecisions(PURCHASE).map((d) => d.outcome), ["verbal_yes"]);

    // Asking again does not place a second call.
    await buyer.purchase(input);
    assert.equal(calls.length, 1);

    if (waiting.status !== "awaiting_approval") return;
    const signature = await DEMO_OWNER.signTypedData(approvalTypedData(waiting.request, computeRequestHash(waiting.request)));
    const ready = await buyer.purchase({ ...input, ownerSignature: signature });
    assert.equal(ready.status, "authorized");
    assert.deepEqual(store.approvalDecisions(PURCHASE).map((d) => d.outcome), ["verbal_yes", "approved"]);
  });

  it("a spoken no denies the purchase, releases the budget and refuses a later signature", async () => {
    const { caller } = fakeCaller({ verbal: "no", conversationId: "conv-2" });
    const { store, buyer, input } = setup(caller);

    const result = await buyer.purchase(input);
    assert.equal(result.status, "rejected");
    assert.equal(store.get(PURCHASE)?.status, "denied");
    assert.equal(store.committedSpend("mission-voice"), 0n);
    const [decision] = store.approvalDecisions(PURCHASE);
    assert.equal(decision?.outcome, "denied");
    assert.equal(decision?.conversationId, "conv-2");

    const signature = await DEMO_OWNER.signTypedData(
      approvalTypedData(store.get(PURCHASE)!.request, store.get(PURCHASE)!.requestHash),
    );
    const late = await buyer.purchase({ ...input, ownerSignature: signature });
    assert.equal(late.status, "rejected");
    assert.equal(store.get(PURCHASE)?.signature, null);
    await assert.rejects(
      store.recordOwnerApproval({ purchaseId: PURCHASE, signature, owner: DEMO_OWNER.address, now: DEMO_NOW }),
      /not awaiting owner approval/,
    );
  });

  it("no answer, a failed call, or an unclear answer is a timeout, and timeout is deny", async () => {
    for (const result of [{ verbal: "no_answer", conversationId: "conv-3" } as const, new Error("HTTP 500")]) {
      const { caller } = fakeCaller(result);
      const { store, buyer, input } = setup(caller);
      const outcome = await buyer.purchase(input);
      assert.equal(outcome.status, "rejected");
      assert.equal(store.get(PURCHASE)?.status, "denied");
      assert.equal(store.committedSpend("mission-voice"), 0n);
      assert.equal(store.approvalDecisions(PURCHASE)[0]?.outcome, "timed_out");
    }
  });

  it("denies an approval that is still waiting when the request expires", async () => {
    const { store, buyer, input } = setup(undefined);
    assert.equal((await buyer.purchase(input)).status, "awaiting_approval");
    const record = store.get(PURCHASE)!;
    assert.deepEqual(store.denyExpiredApprovals(record.request.validBefore - 1), []);
    assert.deepEqual(store.denyExpiredApprovals(record.request.validBefore), [PURCHASE]);
    assert.equal(store.get(PURCHASE)?.status, "denied");
    assert.equal(store.approvalDecisions(PURCHASE)[0]?.outcome, "timed_out");
  });

  it("without a caller the flow is unchanged: explanation text only, no decision logged", async () => {
    const { store, buyer, input } = setup(undefined);
    assert.equal((await buyer.purchase(input)).status, "awaiting_approval");
    assert.deepEqual(store.approvalDecisions(PURCHASE), []);
  });
});

describe("one-time spoken code (stranger answers the phone)", () => {
  async function run(spoken: (shown: string) => string | null, verbal: "yes" | "no" = "yes") {
    const { caller, codeCheck } = codeCaller(spoken, verbal);
    const { store, buyer, input } = setup(caller);
    const buyerWithCode = new BuyerService({
      store, catalog, owner: DEMO_OWNER.address, signer: DEMO_PAYER, tokenDomain: { name: "USDC", version: "2" },
      missionId: "mission-voice", ownerCaller: caller, ownerCodeDisplay: codeCheck.show,
    });
    void buyer;
    const result = await buyerWithCode.purchase(input);
    return { store, result };
  }

  it("a yes with the right code is accepted but still needs the wallet signature", async () => {
    const { store, result } = await run((shown) => shown);
    assert.equal(result.status, "awaiting_approval");
    assert.deepEqual(store.approvalDecisions(PURCHASE).map((d) => d.outcome), ["verbal_yes"]);
  });

  it("accepts digits read with spaces or dashes", async () => {
    const { result } = await run((shown) => shown.split("").join(" - "));
    assert.equal(result.status, "awaiting_approval");
  });

  it("a yes with the wrong code is a denial, and the budget is released", async () => {
    const { store, result } = await run((shown) => (shown === "0000" ? "1111" : "0000"));
    assert.equal(result.status, "rejected");
    assert.equal(store.get(PURCHASE)?.status, "denied");
    assert.equal(store.committedSpend("mission-voice"), 0n);
    const [decision] = store.approvalDecisions(PURCHASE);
    assert.equal(decision?.outcome, "denied");
    assert.match(decision?.detail ?? "", /did not match/);
    assert.doesNotMatch(decision?.detail ?? "", /\d{4}/); // the code itself is never logged
  });

  it("a yes with no code given is a denial", async () => {
    const { store, result } = await run(() => null);
    assert.equal(result.status, "rejected");
    assert.match(store.approvalDecisions(PURCHASE)[0]?.detail ?? "", /no one-time code/);
  });

  it("a code of the wrong length is a denial", async () => {
    const { result } = await run((shown) => shown.slice(0, 3));
    assert.equal(result.status, "rejected");
  });

  it("the code is generated fresh per request and is four digits", () => {
    const seen = new Set(Array.from({ length: 40 }, () => generateApprovalCode()));
    assert.ok([...seen].every((c) => /^\d{4}$/.test(c)));
    assert.ok(seen.size > 5);
  });

  it("the ElevenLabs caller reads the spoken code field", async () => {
    const config = { apiKey: "k", agentId: "a", agentPhoneNumberId: "p", ownerPhoneNumber: "+1" };
    const fetch = async (url: string) =>
      url.endsWith("/outbound-call")
        ? { ok: true, status: 200, json: async () => ({ success: true, conversation_id: "c" }) }
        : { ok: true, status: 200, json: async () => ({ status: "done", analysis: { data_collection_results: { owner_decision: { value: "yes" }, spoken_code: { value: "4821" } } } }) };
    let now = 0;
    const result = await new ElevenLabsOwnerCaller({ config, fetch, sleep: async (ms) => void (now += ms), clock: () => now, pollMs: 1000 }).call({ purchaseId: PURCHASE, summary: "x", timeoutMs: 60_000 });
    assert.equal(result.spokenCode, "4821");
  });
});

describe("code registration for the live check", () => {
  it("registers the code before the call and shows it to the owner", async () => {
    const order: string[] = [];
    const caller: OwnerCaller = { async call() { order.push("call"); return { verbal: "yes", conversationId: "c", spokenCode: registered }; } };
    let registered = "";
    const { store, input } = setup(caller);
    const buyer = new BuyerService({
      store, catalog, owner: DEMO_OWNER.address, signer: DEMO_PAYER, tokenDomain: { name: "USDC", version: "2" }, missionId: "mission-voice",
      ownerCaller: caller,
      ownerCodeRegister: ({ code }) => void (order.push("register"), (registered = code)),
      ownerCodeDisplay: () => void order.push("show"),
    });
    assert.equal((await buyer.purchase(input)).status, "awaiting_approval");
    assert.deepEqual(order, ["register", "show", "call"]);
  });

  it("fails closed: no call is placed if registration fails", async () => {
    let called = false;
    const caller: OwnerCaller = { async call() { called = true; return { verbal: "yes", conversationId: "c", spokenCode: "0000" }; } };
    const { store, input } = setup(caller);
    const buyer = new BuyerService({
      store, catalog, owner: DEMO_OWNER.address, signer: DEMO_PAYER, tokenDomain: { name: "USDC", version: "2" }, missionId: "mission-voice",
      ownerCaller: caller,
      ownerCodeRegister: () => { throw new Error("worker down"); },
      ownerCodeDisplay: () => {},
    });
    const result = await buyer.purchase(input);
    assert.equal(result.status, "rejected");
    assert.equal(called, false);
    assert.equal(store.get(PURCHASE)?.status, "denied");
    assert.match(store.approvalDecisions(PURCHASE)[0]?.detail ?? "", /could not register/);
  });

  it("fails closed: no call is placed if the code cannot be shown", async () => {
    let called = false;
    const caller: OwnerCaller = { async call() { called = true; return { verbal: "yes", conversationId: "c", spokenCode: "0000" }; } };
    const { store, input } = setup(caller);
    const buyer = new BuyerService({
      store, catalog, owner: DEMO_OWNER.address, signer: DEMO_PAYER, tokenDomain: { name: "USDC", version: "2" }, missionId: "mission-voice",
      ownerCaller: caller,
      ownerCodeDisplay: () => { throw new Error("screen gone"); },
    });
    const result = await buyer.purchase(input);
    assert.equal(result.status, "rejected");
    assert.equal(called, false);
    assert.equal(store.get(PURCHASE)?.status, "denied");
    assert.equal(store.committedSpend("mission-voice"), 0n);
    assert.match(store.approvalDecisions(PURCHASE)[0]?.detail ?? "", /could not show/);
  });

  it("the client sends only an HMAC of the code", async () => {
    const { VoiceChallengeClient, codeMac } = await import("../src/payments/voiceChallenge.ts");
    let sent: { url: string; headers: Record<string, string>; body: string } | undefined;
    const client = new VoiceChallengeClient({
      config: { baseUrl: "https://v.example/", adminSecret: "s3cret" },
      fetch: async (url, init) => { sent = { url, headers: init.headers, body: init.body }; return { ok: true, status: 200 }; },
    });
    await client.register({ purchaseId: "p9", code: "4821" });
    assert.equal(sent?.url, "https://v.example/challenge");
    assert.equal(sent?.headers["x-voice-admin-secret"], "s3cret");
    assert.doesNotMatch(sent?.body ?? "", /4821/);
    assert.equal(JSON.parse(sent!.body).code_mac, codeMac("s3cret", "p9", "4821"));
    const failing = new VoiceChallengeClient({ config: { baseUrl: "https://v.example", adminSecret: "s" }, fetch: async () => ({ ok: false, status: 500 }) });
    await assert.rejects(failing.register({ purchaseId: "p9", code: "1" }), /HTTP 500/);
  });
});

describe("ElevenLabs owner caller", () => {
  const config = { apiKey: "k", agentId: "agent", agentPhoneNumberId: "phnum", ownerPhoneNumber: "+15550100" };

  function fakeFetch(conversations: unknown[], start: unknown = { success: true, conversation_id: "conv-x" }) {
    const requests: { url: string; method: string | undefined; body: string | undefined }[] = [];
    let polled = 0;
    const fetch = async (url: string, init?: { method?: string; body?: string }) => {
      requests.push({ url, method: init?.method, body: init?.body });
      if (url.endsWith("/outbound-call")) return { ok: true, status: 200, json: async () => start };
      const body = conversations[Math.min(polled++, conversations.length - 1)];
      return { ok: true, status: 200, json: async () => body };
    };
    return { fetch, requests };
  }
  const done = (value: unknown) => ({ status: "done", analysis: { data_collection_results: { owner_decision: { value } } } });
  const run = (conversations: unknown[], start?: unknown, timeoutMs = 60_000) => {
    const { fetch, requests } = fakeFetch(conversations, start);
    let now = 0;
    const caller = new ElevenLabsOwnerCaller({ config, fetch, sleep: async (ms) => void (now += ms), clock: () => now, pollMs: 1000 });
    return { requests, result: caller.call({ purchaseId: PURCHASE, summary: "buy X", timeoutMs }) };
  };

  it("places the call with the summary as a dynamic variable and reads a yes", async () => {
    const { requests, result } = run([{ status: "in-progress" }, done("yes")]);
    assert.deepEqual(await result, { verbal: "yes", conversationId: "conv-x", spokenCode: null });
    const body = JSON.parse(requests[0]!.body!);
    assert.equal(body.to_number, "+15550100");
    assert.equal(body.conversation_initiation_client_data.dynamic_variables.purchase_summary, "buy X");
  });

  it("uses the SIP trunk endpoint when the number is a SIP trunk", async () => {
    const { fetch, requests } = fakeFetch([done("yes")]);
    let now = 0;
    const caller = new ElevenLabsOwnerCaller({ config: { ...config, phoneProvider: "sip_trunk" }, fetch, sleep: async (ms) => void (now += ms), clock: () => now, pollMs: 1000 });
    await caller.call({ purchaseId: PURCHASE, summary: "buy X", timeoutMs: 60_000 });
    assert.match(requests[0]!.url, /\/v1\/convai\/sip-trunk\/outbound-call$/);
    assert.equal(elevenLabsConfigFromEnv({ ELEVENLABS_API_KEY: "k", ELEVENLABS_AGENT_ID: "a", ELEVENLABS_PHONE_NUMBER_ID: "p", OWNER_PHONE_NUMBER: "+1", ELEVENLABS_PHONE_PROVIDER: "sip_trunk" })?.phoneProvider, "sip_trunk");
  });

  it("reads a no, and treats anything else as no answer", async () => {
    assert.equal((await run([done("No ")].slice(0)).result).verbal, "no");
    assert.equal((await run([done("maybe")]).result).verbal, "no_answer");
    assert.equal((await run([done(undefined)]).result).verbal, "no_answer");
    assert.equal((await run([{ status: "failed" }]).result).verbal, "no_answer");
  });

  it("keeps waiting when one poll throws or returns a bad body", async () => {
    let polled = 0;
    const fetch = async (url: string) => {
      if (url.endsWith("/outbound-call")) return { ok: true, status: 200, json: async () => ({ success: true, conversation_id: "conv-x" }) };
      polled += 1;
      if (polled === 1) throw new Error("socket reset");
      if (polled === 2) return { ok: true, status: 200, json: async () => { throw new SyntaxError("bad json"); } };
      return { ok: true, status: 200, json: async () => done("yes") };
    };
    let now = 0;
    const caller = new ElevenLabsOwnerCaller({ config, fetch, sleep: async (ms) => void (now += ms), clock: () => now, pollMs: 1000 });
    assert.equal((await caller.call({ purchaseId: PURCHASE, summary: "buy X", timeoutMs: 60_000 })).verbal, "yes");
    assert.equal(polled, 3);
  });

  it("does not sleep past the deadline", async () => {
    const sleeps: number[] = [];
    const { fetch } = fakeFetch([{ status: "in-progress" }]);
    let now = 0;
    const caller = new ElevenLabsOwnerCaller({ config, fetch, sleep: async (ms) => void (sleeps.push(ms), (now += ms)), clock: () => now, pollMs: 4000 });
    await caller.call({ purchaseId: PURCHASE, summary: "buy X", timeoutMs: 10_000 });
    assert.equal(sleeps.reduce((a, b) => a + b, 0), 10_000);
  });

  it("gives up at the timeout when the call never finishes", async () => {
    assert.equal((await run([{ status: "in-progress" }], undefined, 5_000).result).verbal, "no_answer");
  });

  it("fails when the call cannot be started", async () => {
    await assert.rejects(run([], { success: false }).result, /did not start/);
  });

  it("builds a caller only when the environment is complete", () => {
    assert.equal(ownerCallerFromEnv({}), undefined);
    const env = { ELEVENLABS_API_KEY: "k", ELEVENLABS_AGENT_ID: "a", ELEVENLABS_PHONE_NUMBER_ID: "p", OWNER_PHONE_NUMBER: "+1" };
    assert.ok(ownerCallerFromEnv(env) instanceof ElevenLabsOwnerCaller);
  });

  it("reads config from env only when every value is present", () => {
    assert.equal(elevenLabsConfigFromEnv({ ELEVENLABS_API_KEY: "k" }), undefined);
    assert.deepEqual(
      elevenLabsConfigFromEnv({ ELEVENLABS_API_KEY: "k", ELEVENLABS_AGENT_ID: "a", ELEVENLABS_PHONE_NUMBER_ID: "p", OWNER_PHONE_NUMBER: "+1" }),
      { apiKey: "k", agentId: "a", agentPhoneNumberId: "p", ownerPhoneNumber: "+1" },
    );
  });
});
