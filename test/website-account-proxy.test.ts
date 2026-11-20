import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { proxyConsumerAuth, type ConsumerAuthWorkerEnv } from "../cloudflare/website-account/src/consumer-auth.ts";

const SITE = "https://verityresearch.us";
const EDGE = "https://abcdefghijklmnopqrst.supabase.co/functions/v1/consumer-auth";

function limiter(allow = true) {
  const keys: string[] = [];
  return { keys, limit: async ({ key }: { key: string }) => (keys.push(key), { success: allow }) };
}

function env(extra: Partial<ConsumerAuthWorkerEnv> = {}) {
  return {
    VERITY_AUTH_SITE_ORIGIN: SITE,
    VERITY_AUTH_EDGE_URL: EDGE,
    VERITY_AUTH_EDGE_KEY: "a".repeat(64),
    VERITY_AUTH_RATE_LIMIT: limiter(),
    ...extra,
  } satisfies ConsumerAuthWorkerEnv;
}

function get(path: string) {
  return new Request(`${SITE}${path}`, { headers: { "cf-connecting-ip": "203.0.113.9", cookie: "__Host-verity-session=x" } });
}

// Plays back one outcome per upstream call: a status code, or "throw" for a network error.
function upstream(outcomes: Array<number | "throw">) {
  const calls: string[] = [];
  const send = (async (url: string | URL | Request) => {
    calls.push(String(url));
    const next = outcomes.shift() ?? 200;
    if (next === "throw") throw new TypeError("connection reset");
    return new Response(JSON.stringify(next === 200 ? { accountId: "acct" } : { error: "x" }), { status: next });
  }) as typeof fetch;
  return { send, calls };
}

describe("website-account auth proxy", () => {
  it("retries a session check once when the Edge Function is restarting", async () => {
    for (const first of ["throw", 502, 503, 504] as const) {
      const { send, calls } = upstream([first, 200]);
      const response = await proxyConsumerAuth(get("/auth/session"), env(), send);
      assert.equal(response?.status, 200, `after ${first}`);
      assert.equal(calls.length, 2);
      assert.equal(calls[0], `${EDGE}/session`);
    }
  });

  it("gives up after the second failure and reports sign-in as unavailable", async () => {
    const thrown = upstream(["throw", "throw"]);
    assert.equal((await proxyConsumerAuth(get("/auth/session"), env(), thrown.send))?.status, 503);
    assert.equal(thrown.calls.length, 2);
    const failed = upstream([503, 503]);
    assert.equal((await proxyConsumerAuth(get("/auth/session"), env(), failed.send))?.status, 503);
    assert.equal(failed.calls.length, 2);
  });

  it("does not retry answers that are final", async () => {
    for (const status of [200, 401, 404, 500]) {
      const { send, calls } = upstream([status]);
      assert.equal((await proxyConsumerAuth(get("/auth/session"), env(), send))?.status, status);
      assert.equal(calls.length, 1, `status ${status}`);
    }
  });

  it("never sends the one-time callback code twice", async () => {
    const { send, calls } = upstream(["throw", 200]);
    const response = await proxyConsumerAuth(get("/auth/callback?code=0b8f2c1e-4d3a-4b5c-9e6f-7a8b9c0d1e2f"), env(), send);
    assert.equal(response?.status, 503);
    assert.equal(calls.length, 1);
  });

  it("uses the session limit for /auth/session and the sign-in limit for everything else", async () => {
    const signIn = limiter();
    const session = limiter();
    const e = env({ VERITY_AUTH_RATE_LIMIT: signIn, VERITY_AUTH_SESSION_RATE_LIMIT: session });
    await proxyConsumerAuth(get("/auth/session"), e, upstream([200]).send);
    await proxyConsumerAuth(get("/auth/signup-context"), e, upstream([200]).send);
    assert.equal(session.keys.length, 1);
    assert.equal(signIn.keys.length, 1);
    assert.notEqual(session.keys[0], signIn.keys[0], "the key still includes the path");
  });

  it("falls back to the sign-in limit when the session binding is missing, and still returns 429", async () => {
    const signIn = limiter(false);
    const { send, calls } = upstream([200]);
    assert.equal((await proxyConsumerAuth(get("/auth/session"), env({ VERITY_AUTH_RATE_LIMIT: signIn }), send))?.status, 429);
    assert.equal(signIn.keys.length, 1);
    assert.equal(calls.length, 0);
  });
});
