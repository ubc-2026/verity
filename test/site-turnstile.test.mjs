// The page's Turnstile helper (site/src/gemini.js): a stalled script load must not block later AI calls.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Script, createContext } from "node:vm";

const src = readFileSync(new URL("../site/src/gemini.js", import.meta.url), "utf8");
const start = src.indexOf("const AITS=");
const end = src.indexOf("return AITS.q=AITS.q.catch(()=>{}).then(run);}") + "return AITS.q=AITS.q.catch(()=>{}).then(run);}".length;
const HELPER = src.slice(start, end);

// A minimal browser: scripts never load unless the test fires onload; turnstile.render answers as told.
function page({ wait = 30 } = {}) {
  const scripts = [];
  const byId = {};
  const widgets = { rendered: 0, removed: 0, mode: "token" };
  const element = (tag) => ({
    tag, style: {}, removed: false,
    remove() { this.removed = true; },
  });
  const document = {
    createElement: (tag) => element(tag),
    getElementById: (id) => byId[id] || null,
    head: { appendChild: (el) => scripts.push(el) },
    body: { appendChild: (el) => { byId[el.id] = el; } },
  };
  const window = {};
  const turnstile = {
    render(_box, opts) {
      widgets.rendered += 1;
      if (widgets.mode === "token") queueMicrotask(() => opts.callback("tok-" + widgets.rendered));
      return widgets.rendered;
    },
    remove() { widgets.removed += 1; },
  };
  const ctx = createContext({ document, window, setTimeout, clearTimeout, Promise, Object, Error });
  new Script(HELPER + `;AITS.wait=${wait};globalThis.aiToken=aiToken;globalThis.AITS=AITS;`).runInContext(ctx);
  const loadScript = (i) => { window.turnstile = turnstile; scripts[i].onload(); };
  return { ctx, scripts, widgets, window, loadScript };
}

describe("site Turnstile helper", () => {
  it("a stalled first load times out, drops the loader, and a retry succeeds without reloading", async () => {
    const p = page();
    await assert.rejects(p.ctx.aiToken(), /timed out/);
    assert.equal(p.scripts.length, 1);
    assert.equal(p.scripts[0].removed, true, "the stalled script element is removed");
    assert.equal(p.ctx.AITS.load, null, "the pending loader is no longer cached");

    const retry = p.ctx.aiToken();
    await new Promise((r) => setImmediate(r));
    assert.equal(p.scripts.length, 2, "the retry starts a fresh script load");
    p.loadScript(1);
    assert.equal(await retry, "tok-1");
    assert.equal(p.widgets.removed, 1, "the widget is cleaned up after use");
  });

  it("calls queued behind a stalled load each fail within the deadline instead of hanging", async () => {
    const p = page({ wait: 20 });
    const t0 = Date.now();
    const results = await Promise.allSettled([p.ctx.aiToken(), p.ctx.aiToken(), p.ctx.aiToken()]);
    assert.deepEqual(results.map((r) => r.status), ["rejected", "rejected", "rejected"]);
    assert.ok(Date.now() - t0 < 1000, "all three settle quickly");
    assert.ok(p.scripts.every((s) => s.removed), "every stalled script is removed");
  });

  it("time spent queued counts: a call made during a stall settles within one deadline of the click", async () => {
    const p = page({ wait: 80 });
    const t0 = Date.now();
    const calls = [p.ctx.aiToken(), p.ctx.aiToken(), p.ctx.aiToken()].map((c) => c.then(() => "ok", () => Date.now() - t0));
    const waited = await Promise.all(calls);
    for (const ms of waited) assert.ok(ms < 160, `settled after ${ms} ms; a per-attempt timer would take up to 240 ms`);
  });

  it("a widget that never answers times out and is removed; the next call reuses the loaded script", async () => {
    const p = page();
    p.window.turnstile = undefined;
    const first = p.ctx.aiToken();
    await new Promise((r) => setImmediate(r));
    p.widgets.mode = "silent";
    p.loadScript(0);
    await assert.rejects(first, /timed out/);
    assert.equal(p.widgets.removed, 1);
    assert.equal(p.scripts[0].removed, false, "a script that loaded is kept");

    p.widgets.mode = "token";
    assert.equal(await p.ctx.aiToken(), "tok-2");
    assert.equal(p.scripts.length, 1, "no second script load");
  });

  it("stops the deadline once Cloudflare shows an interactive challenge", async () => {
    const p = page({ wait: 20 });
    p.window.turnstile = {
      render(_box, opts) {
        opts["before-interactive-callback"]();
        setTimeout(() => opts.callback("solved"), 60);
        return 1;
      },
      remove() {},
    };
    assert.equal(await p.ctx.aiToken(), "solved");
  });
});
