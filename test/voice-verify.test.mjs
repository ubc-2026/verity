import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { describe, it } from "node:test";
import { handle, MAX_ATTEMPTS, TTL_SECONDS } from "../voice-verify/worker.mjs";

const ADMIN = "admin-secret-for-tests";
const TOOL = "tool-secret-for-tests";
const mac = (purchaseId, code) => createHmac("sha256", ADMIN).update(`${purchaseId}:${code}`).digest("hex");

function fakeKv() {
  const map = new Map();
  return {
    map,
    async get(key) { return map.get(key) ?? null; },
    async put(key, value) { map.set(key, value); },
    async delete(key) { map.delete(key); },
  };
}

function setup() {
  const env = { VOICE_ADMIN_SECRET: ADMIN, VOICE_TOOL_SECRET: TOOL, VOICE_CHALLENGES: fakeKv() };
  let clock = 1_000_000;
  const call = async (path, body, headers = {}) => {
    const response = await handle(new Request(`https://v.example${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) }), env, () => clock);
    return { status: response.status, body: await response.json() };
  };
  const register = (purchaseId, code) => call("/challenge", { purchase_id: purchaseId, code_mac: mac(purchaseId, code) }, { "x-voice-admin-secret": ADMIN });
  const verify = (purchaseId, code, secret = TOOL) => call("/verify", { purchase_id: purchaseId, code }, { "x-voice-tool-secret": secret });
  return { env, register, verify, advance: (ms) => (clock += ms) };
}

describe("voice-verify worker", () => {
  it("verifies the right code once and then forgets it", async () => {
    const { register, verify, env } = setup();
    assert.equal((await register("p1", "5048")).status, 200);
    const ok = await verify("p1", "5048");
    assert.deepEqual(ok.body, { verified: true, attempts_left: 0, status: "verified" });
    assert.equal(env.VOICE_CHALLENGES.map.size, 0);
    assert.equal((await verify("p1", "5048")).body.verified, false); // single use
  });

  it("accepts digits spoken with spaces or dashes", async () => {
    const { register, verify } = setup();
    await register("p1", "5048");
    assert.equal((await verify("p1", "5 0 4 8")).body.verified, true);
  });

  it("rejects a wrong code and counts the attempt", async () => {
    const { register, verify } = setup();
    await register("p1", "5048");
    const first = await verify("p1", "5038");
    assert.deepEqual(first.body, { verified: false, attempts_left: MAX_ATTEMPTS - 1, status: "wrong_code" });
    assert.equal((await verify("p1", "5048")).body.verified, true); // the right code still works within the limit
  });

  it("locks after three wrong attempts, even for the right code", async () => {
    const { register, verify } = setup();
    await register("p1", "5048");
    for (let i = 0; i < MAX_ATTEMPTS; i++) assert.equal((await verify("p1", "0000")).body.verified, false);
    assert.deepEqual((await verify("p1", "5048")).body, { verified: false, attempts_left: 0, status: "locked" });
  });

  it("expires after the TTL", async () => {
    const { register, verify, advance } = setup();
    await register("p1", "5048");
    advance(TTL_SECONDS * 1000 + 1);
    assert.equal((await verify("p1", "5048")).body.status, "no_active_code");
  });

  it("refuses an unknown purchase, and a code of the wrong length", async () => {
    const { register, verify } = setup();
    assert.equal((await verify("nope", "5048")).body.status, "no_active_code");
    await register("p1", "5048");
    assert.equal((await verify("p1", "504")).body.verified, false);
  });

  it("will not let a second registration reset the attempts", async () => {
    const { register } = setup();
    assert.equal((await register("p1", "5048")).status, 200);
    assert.equal((await register("p1", "1111")).status, 409);
  });

  it("requires the right secret on each route", async () => {
    const { register, verify, env } = setup();
    assert.equal((await register("p1", "5048")).status, 200);
    assert.equal((await verify("p1", "5048", "wrong")).status, 401);
    assert.equal((await verify("p1", "5048", ADMIN)).status, 401); // the admin secret is not the tool secret
    const noSecret = await handle(new Request("https://v.example/challenge", { method: "POST", body: JSON.stringify({ purchase_id: "p2", code_mac: mac("p2", "1234") }) }), env);
    assert.equal(noSecret.status, 401);
  });

  it("never returns the code or the stored MAC", async () => {
    const { register, verify } = setup();
    await register("p1", "5048");
    const wrong = JSON.stringify((await verify("p1", "5038")).body);
    assert.doesNotMatch(wrong, /5048|[0-9a-f]{64}/);
  });

  it("rejects malformed input", async () => {
    const { verify, call } = (() => { const s = setup(); return { verify: s.verify, call: s }; })();
    assert.equal((await verify("bad id with spaces", "5048")).status, 400);
    assert.equal(call.env.VOICE_CHALLENGES.map.size, 0);
  });
});
