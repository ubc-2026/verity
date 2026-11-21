// /auth/ai-pass on verity-website-account: only a verified sign-in session gets a pass for the AI Worker.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { AI_PASS_TTL_SECONDS, createWebsiteAccount } from "../cloudflare/website-account/src/website-account.mjs";
import { readMemberPass } from "../worker/worker.mjs";

const SITE = "https://verityresearch.us";
const KEY = "k".repeat(48);
const ACCOUNT = "0b7e4c1a-1111-4222-8333-944445555666";

function account(sessionStatus = 200, body = { accountId: ACCOUNT }) {
  const seen = [];
  const proxyAuth = async (request) => {
    const path = new URL(request.url).pathname;
    if (path !== "/auth/session") return null; // like proxyConsumerAuth: unknown /auth paths are not proxied
    seen.push({ path, cookie: request.headers.get("cookie") });
    return sessionStatus === null ? null : Response.json(body, { status: sessionStatus });
  };
  return { seen, worker: createWebsiteAccount({ proxyAuth, connect: () => { throw new Error("no database here"); } }) };
}

const env = (extra = {}) => ({ VERITY_AUTH_SITE_ORIGIN: SITE, AI_PASS_KEY: KEY, ...extra });
const get = (path = "/auth/ai-pass", init = {}) => new Request(SITE + path, { headers: { cookie: "__Host-verity_session=abc" }, ...init });

describe("website-account /auth/ai-pass", () => {
  it("a signed-in visitor gets a 10-minute pass that the AI Worker accepts", async () => {
    const { seen, worker } = account();
    const before = Math.floor(Date.now() / 1000);
    const r = await worker.fetch(get(), env());
    assert.equal(r.status, 200);
    assert.equal(r.headers.get("cache-control"), "private, no-store");
    const { pass, expiresAt } = await r.json();
    assert.ok(expiresAt >= before + AI_PASS_TTL_SECONDS && expiresAt <= before + AI_PASS_TTL_SECONDS + 2);
    assert.ok(!pass.includes(ACCOUNT) && !pass.includes("0b7e4c1a"), "the pass never carries the account ID");
    assert.ok(await readMemberPass(pass, { AI_PASS_KEY: KEY }), "verity-gemini verifies it with the same key");
    assert.deepEqual(seen, [{ path: "/auth/session", cookie: "__Host-verity_session=abc" }], "checked through the session route with the cookie");
  });

  it("the same account always maps to the same member key; different accounts don't", async () => {
    const one = async (id) => (await (await account(200, { accountId: id }).worker.fetch(get(), env())).json()).pass.split(".")[1];
    assert.equal(await one(ACCOUNT), await one(ACCOUNT));
    assert.notEqual(await one(ACCOUNT), await one("ffffffff-1111-4222-8333-944445555666"));
  });

  it("no session, a rate-limited session, or a broken session answer gets no pass", async () => {
    assert.equal((await account(401, { error: "signed_out" }).worker.fetch(get(), env())).status, 401);
    assert.equal((await account(429, { error: "rate_limited" }).worker.fetch(get(), env())).status, 429);
    assert.equal((await account(502).worker.fetch(get(), env())).status, 503);
    assert.equal((await account(null).worker.fetch(get(), env())).status, 503);
    assert.equal((await account(200, {}).worker.fetch(get(), env())).status, 503, "a session answer without an account ID");
  });

  it("fails closed without a usable AI_PASS_KEY, before checking the session", async () => {
    for (const AI_PASS_KEY of [undefined, "", "short-key"]) {
      const { seen, worker } = account();
      const r = await worker.fetch(get(), env({ AI_PASS_KEY }));
      assert.equal(r.status, 503);
      assert.deepEqual(await r.json(), { error: "ai_pass_unavailable" });
      assert.equal(seen.length, 0);
    }
  });

  it("only GET on the exact path, from the site origin", async () => {
    const { worker } = account();
    assert.equal((await worker.fetch(get("/auth/ai-pass", { method: "POST" }), env())).status, 405);
    assert.equal((await worker.fetch(get("/auth/ai-pass?x=1"), env())).status, 404);
    assert.equal((await worker.fetch(new Request("https://evil.example/auth/ai-pass"), env())).status, 404);
  });
});
