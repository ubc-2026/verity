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
function page({ wait = 40, pass }) {
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
    return Promise.resolve(new Response("{}", { status: 200 }));
  };
  const ctx = createContext({ document, window, fetch, setTimeout, clearTimeout, Promise, Object, Error, Date, AbortController, Response });
  new Script(`${HELPERS};AITS.wait=1000;AIPASS.wait=${wait};
    globalThis.callAi=async()=>{const h=await aiHeaders({'content-type':'application/json'});await fetch(${JSON.stringify(ENDPOINT)},{method:'POST',headers:h,body:'{}'});return h;};
    globalThis.AIPASS=AIPASS;`).runInContext(ctx);
  return { ctx, requests, aiCalls: () => requests.filter((r) => r.url === ENDPOINT) };
}

const never = () => new Promise(() => {});
const passFor = (seconds) => ({ pass: "v1.member", expiresAt: Math.floor(Date.now() / 1000) + seconds });

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

  it("the deadline aborts the lookup, and a timed-out lookup is not retried for a minute", async () => {
    let aborted = false;
    const p = page({ wait: 30, pass: (init) => new Promise((_ok, no) => init.signal.addEventListener("abort", () => { aborted = true; no(new Error("aborted")); })) });
    await p.ctx.callAi();
    assert.equal(aborted, true, "the stalled request is cancelled");
    await p.ctx.callAi();
    assert.equal(p.requests.filter((r) => r.url === "/auth/ai-pass").length, 1, "the second call skips the lookup");
    assert.equal(p.aiCalls().length, 2);
  });

  it("a signed-in visitor's pass is sent and reused until a minute before it expires", async () => {
    const p = page({ pass: () => Promise.resolve(Response.json(passFor(600))) });
    assert.equal((await p.ctx.callAi())["x-verity-pass"], "v1.member");
    assert.equal((await p.ctx.callAi())["x-verity-pass"], "v1.member");
    assert.equal(p.requests.filter((r) => r.url === "/auth/ai-pass").length, 1);
    assert.equal(p.requests[0].init.credentials, "same-origin");
  });

  it("a pass that answers after the deadline is ignored for this call", async () => {
    const p = page({ wait: 20, pass: () => new Promise((ok) => setTimeout(() => ok(Response.json(passFor(600))), 80)) });
    assert.equal((await p.ctx.callAi())["x-verity-pass"], undefined);
    assert.equal(p.ctx.AIPASS.v, null);
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
