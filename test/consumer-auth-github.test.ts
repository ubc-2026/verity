import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { clientAddress, createConsumerAuth } from "../supabase/functions/consumer-auth/handler.ts";

const SITE = "https://verityresearch.us";
const PROJECT = "https://abcdefghijklmnopqrst.supabase.co";
const EDGE_KEY = "a".repeat(64);
const base = {
  siteOrigin: SITE,
  projectUrl: PROJECT,
  publishableKey: "sb_publishable_test",
  edgeKey: EDGE_KEY,
  cookieKey: "b".repeat(64),
  turnstileSecret: "turnstile-secret",
};

function turnstile(outcome = { success: true, hostname: "verityresearch.us", action: "verity_signin" }) {
  return (async (url: string | URL | Request) => {
    assert.equal(String(url), "https://challenges.cloudflare.com/turnstile/v0/siteverify");
    return new Response(JSON.stringify(outcome), { status: 200 });
  }) as typeof fetch;
}

function start(body: unknown, headers: Record<string, string> = {}) {
  return new Request(`${PROJECT}/functions/v1/consumer-auth/start`, {
    method: "POST",
    headers: { "x-verity-edge-key": EDGE_KEY, origin: SITE, "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

function follow(url: string, ip = "203.0.113.7") {
  return new Request(url, { headers: { "x-forwarded-for": `${ip}, 10.0.0.1` } });
}

function setup(
  allow: (ticketId: string, ip: string) => Promise<boolean> = async () => true,
  close: (ticketId: string) => Promise<void> = async () => {},
  send: typeof fetch = turnstile(),
) {
  const calls: Array<{ ticketId: string; ip: string }> = [];
  const closed: string[] = [];
  const handler = createConsumerAuth({
    ...base,
    githubSignup: {
      async allowSignup(ticketId, ip) {
        calls.push({ ticketId, ip });
        return allow(ticketId, ip);
      },
      async closeProof(ticketId) {
        closed.push(ticketId);
        return close(ticketId);
      },
    },
  }, send);
  return { handler, calls, closed };
}

// Turnstile passes, and the PKCE code exchange returns a normal signed-in session.
function signInServices(exchanges: string[] = []) {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    const target = String(url);
    if (target === "https://challenges.cloudflare.com/turnstile/v0/siteverify") {
      return new Response(JSON.stringify({ success: true, hostname: "verityresearch.us", action: "verity_signin" }));
    }
    assert.equal(target, `${PROJECT}/auth/v1/token?grant_type=pkce`);
    exchanges.push(String(init?.body));
    return new Response(JSON.stringify({ access_token: "aaa.bbb.ccc", expires_in: 3600, user: { role: "authenticated" } }));
  }) as typeof fetch;
}

function callback(cookie: string) {
  const value = cookie.split(";")[0]!;
  return new Request(`${PROJECT}/functions/v1/consumer-auth/callback?code=0b8f2c1e-4d3a-4b5c-9e6f-7a8b9c0d1e2f`, {
    headers: { "x-verity-edge-key": EDGE_KEY, cookie: value },
  });
}

async function githubTicketUrl(handler: (req: Request) => Promise<Response>) {
  const response = await handler(start({ challenge: "ok", provider: "github" }));
  assert.equal(response.status, 200);
  const { url } = (await response.json()) as { url: string };
  return { url, cookie: response.headers.get("set-cookie") ?? "" };
}

describe("consumer-auth GitHub signup", () => {
  it("returns a single-parameter ticket link on the Supabase origin after the security check", async () => {
    const { handler } = setup();
    const { url, cookie } = await githubTicketUrl(handler);
    const next = new URL(url);
    assert.equal(next.origin, PROJECT);
    assert.equal(next.pathname, "/functions/v1/consumer-auth/github");
    assert.deepEqual([...next.searchParams.keys()], ["ticket"]);
    assert.match(next.searchParams.get("ticket")!, /^[0-9a-f]{32}~[A-Za-z0-9_-]{43}\.\d{1,12}\.[0-9a-f]{64}$/);
    assert.match(cookie, /^__Host-verity-pkce=[0-9a-f]{64}~[0-9a-f]{32}\.\d+\.[0-9a-f]{64}; Path=\/; Max-Age=600; Secure; HttpOnly; SameSite=Lax$/);
  });

  it("records the proof for the gateway client address and continues to GitHub with the PKCE challenge", async () => {
    const { handler, calls } = setup();
    const { url, cookie } = await githubTicketUrl(handler);
    const response = await handler(follow(url));
    assert.equal(response.status, 303);
    const authorize = new URL(response.headers.get("location")!);
    assert.equal(authorize.origin + authorize.pathname, `${PROJECT}/auth/v1/authorize`);
    assert.equal(authorize.searchParams.get("provider"), "github");
    assert.equal(authorize.searchParams.get("redirect_to"), `${SITE}/auth/callback`);
    assert.equal(authorize.searchParams.get("code_challenge_method"), "s256");
    const verifier = cookie.split("=")[1]!.split(".")[0]!.split("~")[0]!;
    const expected = createHash("sha256").update(verifier).digest("base64url");
    assert.equal(authorize.searchParams.get("code_challenge"), expected, "GitHub flow is bound to the PKCE cookie");
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.ip, "203.0.113.7");
    assert.match(calls[0]!.ticketId, /^[0-9a-f]{32}$/);
  });

  it("needs no edge key on the ticket route but still needs it everywhere else", async () => {
    const { handler } = setup();
    const { url } = await githubTicketUrl(handler);
    assert.equal((await handler(follow(url))).status, 303);
    const session = await handler(new Request(`${PROJECT}/functions/v1/consumer-auth/session`));
    assert.equal(session.status, 404);
  });

  it("sends the visitor back when the ticket was already used", async () => {
    const used = new Set<string>();
    const { handler } = setup(async (ticketId) => !used.has(ticketId) && Boolean(used.add(ticketId)));
    const { url } = await githubTicketUrl(handler);
    assert.match((await handler(follow(url))).headers.get("location")!, /\/auth\/v1\/authorize\?/);
    assert.equal((await handler(follow(url))).headers.get("location"), `${SITE}/?signin=failed`);
  });

  it("rejects a tampered, extended or expired ticket without recording a proof", async () => {
    const { handler, calls } = setup();
    const { url } = await githubTicketUrl(handler);
    const tampered = new URL(url);
    const ticket = tampered.searchParams.get("ticket")!;
    tampered.searchParams.set("ticket", (ticket[0] === "a" ? "b" : "a") + ticket.slice(1));
    assert.equal((await handler(follow(tampered.href))).headers.get("location"), `${SITE}/?signin=failed`);
    const extra = new URL(url);
    extra.searchParams.set("redirect_to", "https://evil.example");
    assert.equal((await handler(follow(extra.href))).headers.get("location"), `${SITE}/?signin=failed`);
    const realNow = Date.now;
    try {
      Date.now = () => realNow() + 121_000;
      assert.equal((await handler(follow(url))).headers.get("location"), `${SITE}/?signin=failed`);
    } finally {
      Date.now = realNow;
    }
    assert.equal(calls.length, 0);
  });

  it("refuses a request without a usable client address", async () => {
    const { handler, calls } = setup();
    const { url } = await githubTicketUrl(handler);
    assert.equal((await handler(follow(url, "not-an-ip"))).headers.get("location"), `${SITE}/?signin=failed`);
    assert.equal(calls.length, 0);
  });

  it("validates the start body and keeps Google as the default", async () => {
    const { handler } = setup();
    assert.equal((await handler(start({ challenge: "ok", provider: "gitlab" }))).status, 400);
    assert.equal((await handler(start({ challenge: "ok", provider: "github", extra: 1 }))).status, 400);
    assert.equal((await handler(start({ provider: "github" }))).status, 400);
    const google = await handler(start({ challenge: "ok" }));
    const next = new URL(((await google.json()) as { url: string }).url);
    assert.equal(next.pathname, "/auth/v1/authorize");
    assert.equal(next.searchParams.get("provider"), "google");
  });

  it("closes the proof on the callback, for a new account and for a returning sign-in alike", async () => {
    const exchanges: string[] = [];
    const { handler, calls, closed } = setup(undefined, undefined, signInServices(exchanges));
    const { url, cookie } = await githubTicketUrl(handler);
    await handler(follow(url));
    const response = await handler(callback(cookie));
    assert.equal(response.status, 303);
    assert.equal(response.headers.get("location"), "/");
    assert.deepEqual(closed, [calls[0]!.ticketId], "the same ticket that recorded the proof is closed");
    const verifier = cookie.split("=")[1]!.split(".")[0]!.split("~")[0]!;
    assert.deepEqual(JSON.parse(exchanges[0]!).code_verifier, verifier, "only the verifier goes to Supabase");
    assert.doesNotMatch(exchanges[0]!, /~/);
  });

  it("still signs in when closing the proof fails", async () => {
    const { handler, closed } = setup(undefined, async () => { throw new Error("db down"); }, signInServices());
    const { url, cookie } = await githubTicketUrl(handler);
    await handler(follow(url));
    const response = await handler(callback(cookie));
    assert.equal(response.headers.get("location"), "/");
    assert.equal(closed.length, 1);
  });

  it("does not try to close a proof after a Google sign-in, and accepts a cookie set before this change", async () => {
    const { handler, closed } = setup(undefined, undefined, signInServices());
    const google = await handler(start({ challenge: "ok" }));
    const cookie = google.headers.get("set-cookie") ?? "";
    assert.match(cookie, /^__Host-verity-pkce=[0-9a-f]{64}\.\d+\.[0-9a-f]{64};/, "the Google cookie keeps its old shape");
    assert.equal((await handler(callback(cookie))).headers.get("location"), "/");
    assert.equal(closed.length, 0);
  });

  it("rejects a PKCE cookie whose ticket part was changed", async () => {
    const { handler, closed } = setup(undefined, undefined, signInServices());
    const { cookie } = await githubTicketUrl(handler);
    const forged = cookie.replace(/~([0-9a-f])/, (_, c: string) => `~${c === "a" ? "b" : "a"}`);
    assert.equal((await handler(callback(forged))).headers.get("location"), "/?signin=failed");
    assert.equal(closed.length, 0);
  });

  it("refuses GitHub when it is turned off and when the security check fails", async () => {
    const off = createConsumerAuth(base, turnstile());
    assert.equal((await off(start({ challenge: "ok", provider: "github" }))).status, 400);
    const denied = createConsumerAuth({ ...base, githubSignup: { allowSignup: async () => true, closeProof: async () => {} } },
      turnstile({ success: true, hostname: "evil.example", action: "verity_signin" }));
    assert.equal((await denied(start({ challenge: "ok", provider: "github" }))).status, 403);
  });
});

describe("clientAddress", () => {
  const at = (value: string) => clientAddress(new Request("https://x.test/", { headers: { "x-forwarded-for": value } }));
  it("takes the first forwarded address and checks its shape", () => {
    assert.equal(at("198.51.100.4, 10.0.0.1"), "198.51.100.4");
    assert.equal(at("2001:DB8::1"), "2001:db8::1");
    assert.equal(at("256.1.1.1"), undefined);
    assert.equal(at("evil.example"), undefined);
    assert.equal(at(""), undefined);
  });
});
