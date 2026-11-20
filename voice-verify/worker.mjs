/**
 * Live one-time-code check for the Verity approval call.
 *
 * Verity registers a challenge for a purchase BEFORE it places the call. It sends only an HMAC of the code, so the
 * code itself never reaches this Worker. The ElevenLabs agent calls /verify mid-call with the digits the person spoke.
 * The answer is only "verified" or not, plus attempts left. The expected code is never returned.
 *
 *   POST /challenge   header x-voice-admin-secret   { purchase_id, code_mac }   (Verity -> Worker)
 *   POST /verify      header x-voice-tool-secret    { purchase_id, code }        (ElevenLabs agent -> Worker)
 *   GET  /healthz
 *
 * A challenge lives 5 minutes, allows 3 attempts, and is single-use. KV is not atomic, so attempts are counted
 * before the comparison and the agent is the only caller (it is behind a secret and speaks one turn at a time).
 */
export const MAX_ATTEMPTS = 3;
export const TTL_SECONDS = 300;

const PURCHASE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MAC = /^[0-9a-f]{64}$/;
const enc = new TextEncoder();

const json = (status, body) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

async function hmacHex(secret, message) {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(message)));
  return [...sig].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Compares secrets through a keyed hash so length and content do not leak through timing. */
async function secretOk(given, expected) {
  if (!expected || !given) return false;
  return safeEqual(await hmacHex("voice-verify-auth", given), await hmacHex("voice-verify-auth", expected));
}

async function readJson(request) {
  try {
    const text = await request.text();
    if (text.length > 2048) return undefined;
    const value = JSON.parse(text);
    return value && typeof value === "object" && !Array.isArray(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

export async function handle(request, env, now = () => Date.now()) {
  const url = new URL(request.url);
  if (request.method === "GET" && url.pathname === "/healthz") return json(200, { ok: true });
  if (request.method !== "POST") return json(404, { error: "not_found" });

  if (url.pathname === "/challenge") {
    if (!(await secretOk(request.headers.get("x-voice-admin-secret"), env.VOICE_ADMIN_SECRET))) return json(401, { error: "unauthorized" });
    const body = await readJson(request);
    if (!body || typeof body.purchase_id !== "string" || !PURCHASE_ID.test(body.purchase_id) || typeof body.code_mac !== "string" || !MAC.test(body.code_mac)) {
      return json(400, { error: "bad_request" });
    }
    const key = `challenge:${body.purchase_id}`;
    if (await env.VOICE_CHALLENGES.get(key)) return json(409, { error: "challenge_exists" });
    await env.VOICE_CHALLENGES.put(key, JSON.stringify({ mac: body.code_mac, attempts: 0, expiresAt: now() + TTL_SECONDS * 1000 }), { expirationTtl: TTL_SECONDS });
    return json(200, { ok: true, expires_in: TTL_SECONDS });
  }

  if (url.pathname === "/verify") {
    if (!(await secretOk(request.headers.get("x-voice-tool-secret"), env.VOICE_TOOL_SECRET))) return json(401, { error: "unauthorized" });
    const body = await readJson(request);
    if (!body || typeof body.purchase_id !== "string" || !PURCHASE_ID.test(body.purchase_id) || typeof body.code !== "string" || body.code.length > 64) {
      return json(400, { error: "bad_request" });
    }
    const key = `challenge:${body.purchase_id}`;
    const raw = await env.VOICE_CHALLENGES.get(key);
    const record = raw ? JSON.parse(raw) : undefined;
    if (!record || record.expiresAt <= now()) return json(200, { verified: false, attempts_left: 0, status: "no_active_code" });
    if (record.attempts >= MAX_ATTEMPTS) return json(200, { verified: false, attempts_left: 0, status: "locked" });

    // Count the attempt before comparing, so a failed or interrupted check cannot be retried for free.
    record.attempts += 1;
    const remaining = Math.max(0, Math.ceil((record.expiresAt - now()) / 1000));
    const digits = body.code.replace(/\D/g, "");
    const ok = digits.length === 4 && safeEqual(await hmacHex(env.VOICE_ADMIN_SECRET, `${body.purchase_id}:${digits}`), record.mac);
    if (ok) {
      await env.VOICE_CHALLENGES.delete(key);
      return json(200, { verified: true, attempts_left: 0, status: "verified" });
    }
    await env.VOICE_CHALLENGES.put(key, JSON.stringify(record), { expirationTtl: Math.max(60, remaining) });
    const left = MAX_ATTEMPTS - record.attempts;
    return json(200, { verified: false, attempts_left: left, status: left > 0 ? "wrong_code" : "locked" });
  }

  return json(404, { error: "not_found" });
}

export default { fetch: (request, env) => handle(request, env) };
