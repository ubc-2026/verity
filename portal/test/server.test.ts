import assert from "node:assert/strict";
import test from "node:test";
import { PortalServer } from "../src/server.ts";
import { PortalStore } from "../src/store.ts";

const readToken = "read-token-for-tests";
const writeToken = "write-token-for-tests";
const site = "https://verityresearch.us";

async function start(allowedOrigins?: string[]) {
  const server = new PortalServer({ store: new PortalStore(":memory:", 1), readToken, writeToken, allowedOrigins });
  await server.listen(0);
  return { server, url: `http://127.0.0.1:${server.address().port}` };
}

test("a listed origin may read with the read token; others get no CORS headers", async () => {
  const { server, url } = await start([site]);
  try {
    const listed = await fetch(`${url}/purchases`, { headers: { origin: site, authorization: `Bearer ${readToken}` } });
    assert.equal(listed.status, 200);
    assert.equal(listed.headers.get("access-control-allow-origin"), site);
    const other = await fetch(`${url}/purchases`, { headers: { origin: "https://evil.example", authorization: `Bearer ${readToken}` } });
    assert.equal(other.headers.get("access-control-allow-origin"), null);
    const noToken = await fetch(`${url}/activity`, { headers: { origin: site } });
    assert.equal(noToken.status, 401, "CORS does not replace the read token");
  } finally {
    await server.close();
  }
});

test("preflight allows GET from a listed origin only, and never a write", async () => {
  const { server, url } = await start([site]);
  try {
    const ok = await fetch(`${url}/activity`, {
      method: "OPTIONS",
      headers: { origin: site, "access-control-request-method": "GET", "access-control-request-headers": "authorization", "access-control-request-private-network": "true" },
    });
    assert.equal(ok.status, 204);
    assert.equal(ok.headers.get("access-control-allow-origin"), site);
    assert.equal(ok.headers.get("access-control-allow-methods"), "GET");
    assert.equal(ok.headers.get("access-control-allow-private-network"), "true");
    const write = await fetch(`${url}/purchases`, { method: "OPTIONS", headers: { origin: site, "access-control-request-method": "POST" } });
    assert.equal(write.status, 403);
    const stranger = await fetch(`${url}/activity`, { method: "OPTIONS", headers: { origin: "https://evil.example", "access-control-request-method": "GET" } });
    assert.equal(stranger.status, 403);
    const post = await fetch(`${url}/purchases`, { method: "POST", headers: { origin: site, authorization: `Bearer ${writeToken}`, "content-type": "application/json" }, body: "{}" });
    assert.equal(post.headers.get("access-control-allow-origin"), null, "a write response never carries CORS headers");
  } finally {
    await server.close();
  }
});

test("with no allowed origins the portal stays same-origin", async () => {
  const { server, url } = await start();
  try {
    const res = await fetch(`${url}/purchases`, { headers: { origin: site, authorization: `Bearer ${readToken}` } });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("access-control-allow-origin"), null);
  } finally {
    await server.close();
  }
});
