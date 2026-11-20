export interface ConsumerAuthWorkerEnv {
  VERITY_AUTH_SITE_ORIGIN: string;
  VERITY_AUTH_EDGE_URL: string;
  VERITY_AUTH_EDGE_KEY: string;
  VERITY_AUTH_RATE_LIMIT: RateLimit;
  /**
   * Separate, higher limit for GET /auth/session. Every page load asks for the session, and visitors on one
   * network (a campus or office) share an address, so the sign-in limit would show them as signed out.
   * Without this binding the session check falls back to VERITY_AUTH_RATE_LIMIT.
   */
  VERITY_AUTH_SESSION_RATE_LIMIT?: RateLimit;
}

type RateLimit = { limit(options: { key: string }): Promise<{ success: boolean }> };

// Read-only requests that are safe to send twice. /auth/callback is a GET too, but its code works only once.
const RETRYABLE = new Set(["/auth/session", "/auth/signup-context"]);
const RETRY_STATUS = new Set([502, 503, 504]);

const routes = new Map([
  ["/auth/start", "POST"], ["/auth/callback", "GET"], ["/auth/session", "GET"], ["/auth/logout", "POST"],
  ["/auth/signup-context", "GET"], ["/auth/signup", "POST"],
]);
const encoder = new TextEncoder();
const accountCookie = /^__Host-verity-(pkce|session|registration)=/;

function failure(status: number, error: string) {
  return new Response(JSON.stringify({ error }), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

/** Call from the same-origin website Worker before any static or API fallback. */
export async function proxyConsumerAuth(request: Request, env: ConsumerAuthWorkerEnv, send: typeof fetch = fetch) {
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/auth/")) return null;
  const method = routes.get(url.pathname);
  if (!method || request.method !== method || url.origin !== env.VERITY_AUTH_SITE_ORIGIN) {
    return failure(404, "not_found");
  }
  if (method === "POST" && request.headers.get("origin") !== url.origin) return failure(403, "origin_denied");
  const bodyLimit = url.pathname === "/auth/signup" ? 8192 : 4096;
  if (Number(request.headers.get("content-length")) > bodyLimit) return failure(413, "body_too_large");

  const ip = request.headers.get("cf-connecting-ip");
  if (!ip || !/^[0-9a-f]{64}$/.test(env.VERITY_AUTH_EDGE_KEY)) return failure(503, "signin_unavailable");
  try {
    const target = new URL(env.VERITY_AUTH_EDGE_URL);
    if (target.protocol !== "https:" || !/^[a-z0-9]{20}\.supabase\.co$/.test(target.host) ||
        target.pathname !== "/functions/v1/consumer-auth" || target.search || target.hash || target.username || target.password) {
      return failure(503, "signin_unavailable");
    }
    const key = await crypto.subtle.importKey(
      "raw", encoder.encode(env.VERITY_AUTH_EDGE_KEY), { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
    );
    const rateKey = await crypto.subtle.sign("HMAC", key, encoder.encode(`verity-auth-rate:${url.pathname}:${ip}`));
    const limiter = url.pathname === "/auth/session" && env.VERITY_AUTH_SESSION_RATE_LIMIT
      ? env.VERITY_AUTH_SESSION_RATE_LIMIT
      : env.VERITY_AUTH_RATE_LIMIT;
    const result = await limiter.limit({ key: btoa(String.fromCharCode(...new Uint8Array(rateKey))) });
    if (!result.success) return failure(429, "try_again_later");

    target.pathname += url.pathname.slice("/auth".length);
    if (url.pathname === "/auth/callback") {
      const code = url.searchParams.get("code");
      if (code && code.length <= 128) target.searchParams.set("code", code);
      if (url.searchParams.has("error")) target.searchParams.set("error", "signin_failed");
    }
    const headers = new Headers({ "x-verity-edge-key": env.VERITY_AUTH_EDGE_KEY });
    const cookies = request.headers.get("cookie")?.split(";").map((part) => part.trim())
      .filter((part) => accountCookie.test(part));
    if (cookies?.length) headers.set("cookie", cookies.join("; "));
    if (method === "POST") {
      headers.set("origin", url.origin);
      const contentType = request.headers.get("content-type");
      if (contentType) headers.set("content-type", contentType);
    }
    const call = () => send(target, {
      method, headers, body: url.pathname === "/auth/start" || url.pathname === "/auth/signup" ? request.body : undefined,
      redirect: "manual", signal: AbortSignal.timeout(url.pathname === "/auth/signup" ? 22000 : 10000),
    });
    let upstream: Response;
    if (RETRYABLE.has(url.pathname)) {
      // The Edge Function restarts between bursts of traffic. A request that lands during a restart fails once,
      // so a read-only check gets one more try instead of telling a signed-in visitor that sign-in is down.
      const first = await call().catch(() => undefined);
      if (first && !RETRY_STATUS.has(first.status)) {
        upstream = first;
      } else {
        await first?.body?.cancel();
        await new Promise((resolve) => setTimeout(resolve, 250));
        upstream = await call();
      }
    } else {
      upstream = await call();
    }
    const safeHeaders = new Headers({
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
      "content-type": "application/json; charset=utf-8",
    });
    const location = upstream.headers.get("location");
    if (location === "/" || location === "/?signin=failed") safeHeaders.set("location", location);
    const responseHeaders = upstream.headers as Headers & { getAll?: (name: "Set-Cookie") => string[] };
    for (const cookie of responseHeaders.getAll?.("Set-Cookie") ?? responseHeaders.getSetCookie()) {
      if (accountCookie.test(cookie)) safeHeaders.append("set-cookie", cookie);
    }
    return new Response(upstream.body, { status: upstream.status, headers: safeHeaders });
  } catch {
    return failure(503, "signin_unavailable");
  }
}
