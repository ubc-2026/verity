import postgres from "postgres";
import { proxyConsumerAuth } from "./consumer-auth.ts";
import { privateResearchRuns } from "./private-research-runs.mjs";
import { researchSignInPilot } from "./research-signin-pilot.mjs";

function json(status, data) {
  return Response.json(data, { status, headers: {
    "Cache-Control": "private, no-store",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
  } });
}

export function createWebsiteAccount({ proxyAuth = proxyConsumerAuth, connect = postgres } = {}) {
  // The website's trusted analysis handler can call this when a run completes.
  // The browser never provides the account ID or direct database credentials.
  async function withVerifiedRuns(request, env, operation) {
    const url = new URL(request.url);
    if (url.origin !== env.VERITY_AUTH_SITE_ORIGIN) return json(404, { error: "not_found" });
    const headers = new Headers();
    for (const name of ["cookie", "cf-connecting-ip"]) {
      const value = request.headers.get(name);
      if (value) headers.set(name, value);
    }
    try {
      const session = await proxyAuth(new Request(new URL("/auth/session", url), { headers }), env);
      if (!session) return json(503, { error: "signin_unavailable" });
      if (session.status === 401 || session.status === 429) return session;
      if (!session.ok) return json(503, { error: "signin_unavailable" });
      const { accountId } = await session.json();
      const connection = env.VERITY_PRIVATE_RUNS_DB?.connectionString;
      if (!connection) return json(503, { error: "research_storage_unavailable" });
      const sql = connect(connection, { max: 1, connect_timeout: 5, fetch_types: false });
      try {
        const runs = privateResearchRuns(sql, accountId);
        return json(200, { data: await operation(runs) });
      } finally {
        await sql.end({ timeout: 1 });
      }
    } catch {
      return json(503, { error: "research_storage_unavailable" });
    }
  }

  async function handleRequest(request, env) {
    const { origin, pathname, search } = new URL(request.url);
    if (origin !== env.VERITY_AUTH_SITE_ORIGIN) return json(404, { error: "not_found" });
    const publicSignup = env.VERITY_PUBLIC_SIGNUP === "true";
    if (pathname === "/auth/pilot" && request.method === "GET" && !search) {
      return publicSignup
        ? new Response(null, { status: 302, headers: { location: "/auth/sign-in", "cache-control": "no-store" } })
        : researchSignInPilot(env);
    }
    if (pathname === "/auth/sign-in" && request.method === "GET" && !search &&
        (publicSignup || env.VERITY_PUBLIC_SIGNUP === "preview")) return researchSignInPilot(env, true);
    if (pathname === "/auth/config" && request.method === "GET" && !search) {
      const turnstileSiteKey = env.VERITY_AUTH_TURNSTILE_SITE_KEY;
      if (!/^[A-Za-z0-9_-]{10,80}$/.test(turnstileSiteKey ?? "") || !env.VERITY_AUTH_EDGE_URL ||
          !env.VERITY_AUTH_EDGE_KEY || !env.VERITY_AUTH_RATE_LIMIT || !env.VERITY_PRIVATE_RUNS_DB) {
        return json(503, { error: "signin_unavailable" });
      }
      return json(200, { turnstileSiteKey });
    }
    if (pathname.startsWith("/auth/")) return await proxyAuth(request, env) ?? json(404, { error: "not_found" });
    if (pathname === "/api/account/runs" && !search) {
      if (request.method !== "GET") return json(405, { error: "method_not_allowed" });
      return withVerifiedRuns(request, env, (runs) => runs.list());
    }
    return json(404, { error: "not_found" });
  }

  return { fetch: handleRequest, withVerifiedRuns };
}

const websiteAccount = createWebsiteAccount();
export const withVerifiedRuns = websiteAccount.withVerifiedRuns;
export default { fetch: websiteAccount.fetch };
