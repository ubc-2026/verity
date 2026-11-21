// The page's member-pass lookup (site/src/gemini.js): a slow /auth/ai-pass must never hold up an AI call.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Script, createContext } from "node:vm";

const src = readFileSync(new URL("../site/src/gemini.js", import.meta.url), "utf8");
const start = src.indexOf("const AITS=");
const marker = "if(pass)h['x-verity-pass']=pass;return h;}";
const HELPERS = src.slice(start, src.indexOf(marker) + marker.length);
const ENDPOINT = "https://verity-gemini.example.workers.dev/review";

// A minimal browser: Turnstile is already loaded and answers at once; /auth/ai-pass answers as each test says.
function page({ wait = 40, pass }, prelude) {
  const requests = [];
  const document = {
    createElement: () => ({ style: {}, remove() {} }),
    getElementById: () => null,
    head: { appendChild() {} },
    body: { appendChild() {} },
  };
  const window = {
    turnstile: { render: (_box, opts) => (queueMicrotask(() => opts.callback("ts-token")), 1), remove() {} },
  };
  const fetch = (url, init = {}) => {
    requests.push({ url: String(url), init });
    if (String(url) === "/auth/ai-pass") return pass(init);
    return Promise.resolve(Response.json({ items: [] }));
  };
  const ctx = createContext({ document, window, fetch, setTimeout, clearTimeout, Promise, Object, Error, Date, AbortController, Response });
  new Script(`${prelude ?? `${HELPERS};AITS.wait=1000;AIPASS.wait=${wait};`}
    globalThis.callAi=async()=>{const h=await aiHeaders({'content-type':'application/json'});await fetch(${JSON.stringify(ENDPOINT)},{method:'POST',headers:h,body:'{}'});return h;};
    globalThis.AIPASS=AIPASS;`).runInContext(ctx);
  return { ctx, requests, aiCalls: () => requests.filter((r) => r.url === ENDPOINT) };
}

const never = () => new Promise(() => {});
const passFor = (seconds, pass = "v1.member") => ({ pass, expiresAt: Math.floor(Date.now() / 1000) + seconds });

describe("site member pass", () => {
  it("a stalled /auth/ai-pass that ignores abort: the AI request still goes out within the deadline, as a guest", async () => {
    const p = page({ wait: 40, pass: never });
    const t0 = Date.now();
    const headers = await p.ctx.callAi();
    assert.ok(Date.now() - t0 < 500, `took ${Date.now() - t0} ms`);
    assert.equal(p.aiCalls().length, 1, "the AI request was sent");
    assert.equal(headers["cf-turnstile-response"], "ts-token");
    assert.equal(headers["x-verity-pass"], undefined, "no pass, so the Worker applies the guest allowance");
  });

  it("the deadline aborts the stalled lookup; the next call asks again", async () => {
    let aborted = 0;
    const p = page({ wait: 30, pass: (init) => new Promise((_ok, no) => init.signal.addEventListener("abort", () => { aborted += 1; no(new Error("aborted")); })) });
    await p.ctx.callAi();
    await p.ctx.callAi();
    assert.equal(aborted, 2, "each stalled request is cancelled");
    assert.equal(p.requests.filter((r) => r.url === "/auth/ai-pass").length, 2, "nothing is cached from a timeout");
    assert.equal(p.aiCalls().length, 2);
  });

  it("a signed-in visitor's pass is sent with the session cookie, fetched fresh for each call", async () => {
    const p = page({ pass: () => Promise.resolve(Response.json(passFor(600, "v1.member"))) });
    assert.equal((await p.ctx.callAi())["x-verity-pass"], "v1.member");
    assert.equal((await p.ctx.callAi())["x-verity-pass"], "v1.member");
    assert.equal(p.requests.filter((r) => r.url === "/auth/ai-pass").length, 2);
    assert.equal(p.requests[0].init.credentials, "same-origin");
  });

  it("switching account in another tab: the very next call is charged to the new account", async () => {
    // The session cookie is shared by all tabs, so /auth/ai-pass answers for whoever is signed in now.
    let signedIn = "A";
    const p = page({ pass: () => Promise.resolve(Response.json(passFor(600, "v1.account-" + signedIn))) });
    assert.equal((await p.ctx.callAi())["x-verity-pass"], "v1.account-A");
    signedIn = "B"; // another tab signs out of A and into B; this tab gets no event
    assert.equal((await p.ctx.callAi())["x-verity-pass"], "v1.account-B");
    assert.equal(p.aiCalls().at(-1).init.headers["x-verity-pass"], "v1.account-B", "the AI request carries B's pass");
  });

  it("signing in after a guest call: the very next call gets the member allowance", async () => {
    let signedIn = false;
    const p = page({ pass: () => Promise.resolve(signedIn ? Response.json(passFor(600, "v1.member")) : new Response("{}", { status: 401 })) });
    assert.equal((await p.ctx.callAi())["x-verity-pass"], undefined);
    signedIn = true;
    assert.equal((await p.ctx.callAi())["x-verity-pass"], "v1.member");
  });

  it("signing out in another tab: the next call goes out as a guest", async () => {
    let signedIn = true;
    const p = page({ pass: () => Promise.resolve(signedIn ? Response.json(passFor(600, "v1.member")) : new Response("{}", { status: 401 })) });
    assert.equal((await p.ctx.callAi())["x-verity-pass"], "v1.member");
    signedIn = false;
    assert.equal((await p.ctx.callAi())["x-verity-pass"], undefined);
  });

  it("a pass that answers after the deadline is ignored", async () => {
    const p = page({ wait: 20, pass: () => new Promise((ok) => setTimeout(() => ok(Response.json(passFor(600))), 80)) });
    assert.equal((await p.ctx.callAi())["x-verity-pass"], undefined);
  });

  it("research requests carry the member pass and Turnstile token, in the source and in the published build", async () => {
    // A rebuild from an older copy once dropped the pass from research calls and from dist. Run the real
    // fetchResearch from each copy against a stubbed fetch and check the headers on the outgoing request.
    const news = readFileSync(new URL("../site/src/news.js", import.meta.url), "utf8");
    const dist = readFileSync(new URL("../site/dist/index.html", import.meta.url), "utf8");
    const slice = (text, from, to) => {
      const a = text.indexOf(from), b = text.indexOf(to, a);
      assert.ok(a >= 0 && b > a, `found ${from}`);
      return text.slice(a, b + to.length);
    };
    const research = (text) => slice(text, "async function fetchResearch(", "return j.items||[];}");
    for (const [name, helpers, fetchResearch] of [
      ["src", HELPERS, research(news)],
      ["dist", slice(dist, "const AITS=", marker), research(dist)],
    ]) {
      const p = page({ pass: () => Promise.resolve(Response.json(passFor(600, "v1.member"))) }, `${helpers};AITS.wait=1000;AIPASS.wait=40;`);
      new Script(`const GAI={endpoint:${JSON.stringify(ENDPOINT)}};${fetchResearch};globalThis.fetchResearch=fetchResearch;`).runInContext(p.ctx);
      await p.ctx.fetchResearch("bitcoin", 7);
      const sent = p.requests.filter((r) => r.url.startsWith(ENDPOINT.replace(/\/review$/, "/research")));
      assert.equal(sent.length, 1, `${name}: one research request`);
      assert.equal(sent[0].init.headers["x-verity-pass"], "v1.member", `${name}: research carries the member pass`);
      assert.equal(sent[0].init.headers["cf-turnstile-response"], "ts-token", `${name}: research carries the Turnstile token`);
    }
  });

  it("review/ask and forecast build their request headers with aiHeaders, in the source and in the published build", () => {
    const dist = readFileSync(new URL("../site/dist/index.html", import.meta.url), "utf8");
    for (const [name, text] of [["gemini.js", src], ["dist/index.html", dist]]) {
      assert.ok(text.includes(marker), `${name} adds x-verity-pass`);
      assert.equal((text.match(/headers:await aiHeaders\(/g) || []).length, 2, `${name}: review/ask and forecast pass aiHeaders to fetch`);
    }
  });

  it("guests (401) and broken answers fall back to the guest allowance", async () => {
    for (const answer of [new Response("{}", { status: 401 }), new Response("not json"), Response.json({ pass: 7 }), Response.json(passFor(-5))]) {
      const p = page({ pass: () => Promise.resolve(answer) });
      const headers = await p.ctx.callAi();
      assert.equal(headers["x-verity-pass"], undefined);
      assert.equal(p.aiCalls().length, 1);
    }
  });
});
