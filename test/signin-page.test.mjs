import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Script } from "node:vm";
import { researchSignInPilot } from "../cloudflare/website-account/src/research-signin-pilot.mjs";

const PROJECT = "https://abcdefghijklmnopqrst.supabase.co";

describe("sign-in page", () => {
  const env = { VERITY_AUTH_EDGE_URL: `${PROJECT}/functions/v1/consumer-auth` };

  it("shows the GitHub button only when GitHub signup is turned on", async () => {
    const off = await researchSignInPilot(env, true).text();
    assert.doesNotMatch(off, /id="github-sign-in"/);
    const on = await researchSignInPilot({ ...env, VERITY_AUTH_GITHUB_SIGNUP: "true" }, true).text();
    assert.match(on, /id="github-sign-in"/);
    assert.match(on, /Continue with GitHub/);
    const pilot = await researchSignInPilot({ ...env, VERITY_AUTH_GITHUB_SIGNUP: "true" }, false).text();
    assert.doesNotMatch(pilot, /id="github-sign-in"/, "the invite-only pilot stays Google-only");
  });

  it("keeps a strict nonce policy and the security headers", () => {
    const response = researchSignInPilot({ ...env, VERITY_AUTH_GITHUB_SIGNUP: "true" }, true);
    const csp = response.headers.get("content-security-policy");
    assert.match(csp, /default-src 'none'/);
    assert.match(csp, /script-src 'nonce-[A-Za-z0-9+/=]+' 'strict-dynamic' https:\/\/challenges\.cloudflare\.com;/);
    assert.match(csp, /frame-ancestors 'none'/);
    assert.match(csp, /form-action 'none'/);
    assert.match(csp, /object-src 'none'/);
    assert.doesNotMatch(csp, /unsafe-inline|unsafe-eval/);
    assert.equal(response.headers.get("x-frame-options"), "DENY");
    assert.equal(response.headers.get("referrer-policy"), "no-referrer");
    assert.equal(response.headers.get("cache-control"), "private, no-store");
    assert.match(response.headers.get("strict-transport-security"), /^max-age=\d+$/);
    assert.match(response.headers.get("permissions-policy"), /camera=\(\)/);
  });

  it("puts the nonce on every script and style and ships parseable browser code", async () => {
    const response = researchSignInPilot({ ...env, VERITY_AUTH_GITHUB_SIGNUP: "true" }, true);
    const nonce = /'nonce-([^']+)'/.exec(response.headers.get("content-security-policy"))[1];
    const html = await response.text();
    for (const tag of html.match(/<(script|style)\b[^>]*>/g)) assert.ok(tag.includes(`nonce="${nonce}"`), tag);
    assert.doesNotMatch(html, /\sstyle="/, "no inline style attributes");
    const script = /<script nonce="[^"]+">([\s\S]*)<\/script>/.exec(html)[1];
    assert.doesNotThrow(() => new Script(script), "the browser code parses");
  });

  it("only follows a GitHub ticket link on the configured Supabase origin", async () => {
    const html = await researchSignInPilot({ ...env, VERITY_AUTH_GITHUB_SIGNUP: "true" }, true).text();
    assert.match(html, /data-auth-origin="https:\/\/abcdefghijklmnopqrst\.supabase\.co"/);
    assert.match(html, /next\.pathname === "\/functions\/v1\/consumer-auth\/github"/);
  });
});
