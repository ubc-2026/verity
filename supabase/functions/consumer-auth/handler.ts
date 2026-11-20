import { timingSafeEqual } from "node:crypto";

const PKCE = "__Host-verity-pkce";
const SESSION = "__Host-verity-session";
const REGISTRATION = "__Host-verity-registration";
const REGISTRATION_TTL = 300;
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const TOKEN = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const START_BODY_LIMIT = 4096;
const GITHUB_TICKET = "verity-github-ticket";
const GITHUB_TICKET_TTL = 120;
const TICKET = /^[0-9a-f]{32}~[A-Za-z0-9_-]{43}$/;
const PROVIDERS = new Set(["google", "github"]);
const encoder = new TextEncoder();
const endpoint = "/functions/v1/consumer-auth";

export interface ConsumerAuthConfig {
  siteOrigin: string;
  projectUrl: string;
  publishableKey: string;
  edgeKey: string;
  cookieKey: string;
  turnstileSecret: string;
  registration?: {
    clientId: string;
    verifyIdentity(credential: string, nonce: string): Promise<string | undefined>;
    allowSignup(subject: string): Promise<void>;
  };
  /**
   * GitHub has no ID token to check before the account exists, so a GitHub signup is allowed by a proof that
   * the Before-User-Created hook matches on the client address Supabase Auth sees. Records that proof and
   * returns false when the ticket was already used.
   */
  githubSignup?: {
    allowSignup(ticketId: string, clientIp: string): Promise<boolean>;
  };
}

/** The visitor's address as the Supabase gateway reports it: the first X-Forwarded-For entry. */
export function clientAddress(req: Request): string | undefined {
  const first = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "";
  if (/^(?:\d{1,3}\.){3}\d{1,3}$/.test(first) && first.split(".").every((part) => Number(part) <= 255)) return first;
  if (first.length <= 45 && /^[0-9a-f:.]+$/i.test(first) && first.includes(":")) return first.toLowerCase();
  return undefined;
}

function fields(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function reply(status: number, data?: object): Response {
  return new Response(data ? JSON.stringify(data) : null, {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
    },
  });
}

function cookie(response: Response, name: string, value: string, seconds: number) {
  response.headers.append("set-cookie", `${name}=${value}; Path=/; Max-Age=${seconds}; Secure; HttpOnly; SameSite=Lax`);
}

function readCookie(req: Request, name: string): string | undefined {
  const cookies = req.headers.get("cookie")?.split(";").map((part) => part.trim()) ?? [];
  const named = cookies.filter((part) => part.startsWith(`${name}=`));
  return named.length === 1 ? named[0]!.slice(name.length + 1) : undefined;
}

async function readJson(req: Request, limit: number): Promise<Record<string, unknown> | undefined> {
  if (req.headers.get("content-type")?.split(";")[0]?.trim() !== "application/json" || !req.body) return;
  const reader = req.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytes = 0;
  let text = "";
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > limit) {
        await reader.cancel();
        return;
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
    return fields(JSON.parse(text + decoder.decode()));
  } catch {
    return;
  } finally {
    reader.releaseLock();
  }
}

function challengeFrom(input: Record<string, unknown> | undefined) {
  const challenge = input?.challenge;
  return typeof challenge === "string" && challenge.length > 0 && challenge.length <= 2048 ? challenge : undefined;
}

export function createConsumerAuth(config: ConsumerAuthConfig, send: typeof fetch = fetch) {
  const site = new URL(config.siteOrigin);
  const project = new URL(config.projectUrl);
  if (site.protocol !== "https:" || site.origin !== config.siteOrigin ||
      project.protocol !== "https:" || project.origin !== config.projectUrl ||
      !/^[a-z0-9]{20}\.supabase\.co$/.test(project.hostname) ||
      !/^[0-9a-f]{64}$/.test(config.edgeKey) || !/^[0-9a-f]{64}$/.test(config.cookieKey)
      || config.edgeKey === config.cookieKey || !/^sb_publishable_[A-Za-z0-9_-]+$/.test(config.publishableKey)
      || !config.turnstileSecret) {
    throw new Error("Invalid consumer authentication configuration");
  }
  const ingressKey = encoder.encode(config.edgeKey);
  const cookieKey = crypto.subtle.importKey(
    "raw", encoder.encode(config.cookieKey), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"],
  );
  const callback = new URL("/auth/callback", site);

  async function sealCookie(name: string, value: string, seconds: number) {
    const expires = Math.floor(Date.now() / 1000) + seconds;
    const payload = `${value}.${expires}`;
    const mac = await crypto.subtle.sign("HMAC", await cookieKey, encoder.encode(`${name}:${payload}`));
    return `${payload}.${hex(new Uint8Array(mac))}`;
  }

  async function openCookie(req: Request, name: string, pattern: RegExp): Promise<string | undefined> {
    return openSealed(name, readCookie(req, name), pattern);
  }

  async function openSealed(name: string, raw: string | null | undefined, pattern: RegExp): Promise<string | undefined> {
    if (!raw || raw.length > 3100) return;
    const parts = raw.split(".");
    const digest = parts.pop();
    const expires = parts.pop();
    const value = parts.join(".");
    if (!expires || !digest || !pattern.test(value) || !/^\d{1,12}$/.test(expires) ||
        !/^[0-9a-f]{64}$/.test(digest) || Number(expires) <= Date.now() / 1000) return;
    const bytes = Uint8Array.from(digest.match(/../g)!, (part) => parseInt(part, 16));
    const verified = await crypto.subtle.verify("HMAC", await cookieKey, bytes, encoder.encode(`${name}:${value}.${expires}`));
    return verified ? value : undefined;
  }

  async function auth(path: string, options: RequestInit = {}, token?: string) {
    return send(new URL(`/auth/v1/${path}`, project), {
      ...options,
      headers: {
        apikey: config.publishableKey,
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(options.body ? { "content-type": "application/json" } : {}),
      },
      redirect: "error",
      signal: AbortSignal.timeout(7000),
    });
  }

  function finish(signedIn: boolean) {
    const response = reply(303);
    response.headers.set("location", signedIn ? "/" : "/?signin=failed");
    cookie(response, PKCE, "", 0);
    return response;
  }

  async function verifyHuman(challenge: string) {
    const result = await send("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      body: new URLSearchParams({ secret: config.turnstileSecret, response: challenge }),
      signal: AbortSignal.timeout(7000),
      redirect: "error",
    });
    if (!result.ok) return 503;
    const checked = fields(await result.json());
    return checked.success === true && checked.hostname === site.hostname && checked.action === "verity_signin" ? 200 : 403;
  }

  function storeSession(response: Response, value: unknown) {
    const session = fields(value);
    const user = fields(session.user);
    if (typeof session.access_token !== "string" || session.access_token.length > 3000 || !TOKEN.test(session.access_token)
        || typeof session.expires_in !== "number" || !Number.isInteger(session.expires_in) || session.expires_in <= 0
        || user.role !== "authenticated" || user.is_anonymous === true) return;
    // Keep provider and refresh tokens out of the browser session.
    const lifetime = Math.min(session.expires_in, 1800);
    const token = session.access_token;
    return sealCookie(SESSION, token, lifetime).then((sealed) => cookie(response, SESSION, sealed, lifetime));
  }

  // The browser opens this route on the Supabase origin, so Supabase Auth later sees the same client address.
  // It needs no edge key: the sealed ticket proves that /start passed the Turnstile check in the last two minutes.
  async function continueToGitHub(req: Request): Promise<Response> {
    const fail = () => {
      const response = reply(303);
      response.headers.set("location", new URL("/?signin=failed", site).href);
      return response;
    };
    if (!config.githubSignup) return fail();
    const url = new URL(req.url);
    if ([...url.searchParams.keys()].join() !== "ticket") return fail();
    const ticket = await openSealed(GITHUB_TICKET, url.searchParams.get("ticket"), TICKET);
    const ip = clientAddress(req);
    if (!ticket || !ip) return fail();
    const [ticketId, pkceChallenge] = ticket.split("~") as [string, string];
    if (!(await config.githubSignup.allowSignup(ticketId, ip))) return fail();
    const authorize = new URL("/auth/v1/authorize", project);
    authorize.search = new URLSearchParams({
      provider: "github", redirect_to: callback.href, code_challenge: pkceChallenge, code_challenge_method: "s256",
    }).toString();
    const response = reply(303);
    response.headers.set("location", authorize.href);
    return response;
  }

  return async (req: Request): Promise<Response> => {
    const direct = new URL(req.url).pathname.replace(/^\/functions\/v1(?=\/)/, "");
    if (req.method === "GET" && direct === "/consumer-auth/github") {
      try {
        return await continueToGitHub(req);
      } catch {
        const response = reply(303);
        response.headers.set("location", new URL("/?signin=failed", site).href);
        return response;
      }
    }
    const ingress = req.headers.get("x-verity-edge-key");
    if (!ingress || !/^[0-9a-f]{64}$/.test(ingress) || !timingSafeEqual(encoder.encode(ingress), ingressKey)) {
      return reply(404, { error: "not_found" });
    }
    const url = new URL(req.url);
    const path = url.pathname.startsWith(endpoint + "/")
      ? url.pathname.slice(endpoint.length)
      : url.pathname.replace(/^\/consumer-auth(?=\/)/, "");
    const operation = `${req.method} ${path}`;
    if (req.method === "POST" && req.headers.get("origin") !== site.origin) return reply(403, { error: "origin_denied" });

    try {
      if (operation === "GET /signup-context" && config.registration) {
        const verifier = hex(crypto.getRandomValues(new Uint8Array(32)));
        const nonce = hex(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(verifier))));
        const response = reply(200, { clientId: config.registration.clientId, nonce });
        cookie(response, REGISTRATION, await sealCookie(REGISTRATION, verifier, REGISTRATION_TTL), REGISTRATION_TTL);
        return response;
      }

      if (operation === "POST /signup" && config.registration) {
        const input = await readJson(req, 8192);
        const challenge = challengeFrom(input);
        const credential = input?.credential;
        const verifier = await openCookie(req, REGISTRATION, /^[0-9a-f]{64}$/);
        if (!input || Object.keys(input).length !== 2 || !challenge || !verifier ||
            typeof credential !== "string" || credential.length > 6000 || !TOKEN.test(credential)) {
          return reply(400, { error: "invalid_signup" });
        }
        const status = await verifyHuman(challenge);
        if (status !== 200) return reply(status, { error: status === 403 ? "challenge_denied" : "signin_unavailable" });
        const nonce = hex(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(verifier))));
        const subject = await config.registration.verifyIdentity(credential, nonce);
        if (!subject) return reply(403, { error: "signin_denied" });
        await config.registration.allowSignup(subject);
        const result = await auth("token?grant_type=id_token", {
          method: "POST",
          body: JSON.stringify({ provider: "google", id_token: credential, nonce: verifier }),
        });
        if (!result.ok) return reply(403, { error: "signin_denied" });
        const response = reply(200, { signedIn: true });
        const saved = storeSession(response, await result.json());
        if (!saved) return reply(403, { error: "signin_denied" });
        await saved;
        cookie(response, REGISTRATION, "", 0);
        return response;
      }

      if (operation === "POST /start") {
        const input = await readJson(req, START_BODY_LIMIT);
        const challenge = challengeFrom(input);
        const provider = input?.provider ?? "google";
        const keys = input ? Object.keys(input) : [];
        if (!input || !challenge || !keys.every((key) => key === "challenge" || key === "provider") ||
            typeof provider !== "string" || !PROVIDERS.has(provider) || (provider === "github" && !config.githubSignup)) {
          return reply(400, { error: "invalid_challenge" });
        }
        const status = await verifyHuman(challenge);
        if (status !== 200) return reply(status, { error: status === 403 ? "challenge_denied" : "signin_unavailable" });
        const verifier = hex(crypto.getRandomValues(new Uint8Array(32)));
        const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(verifier)));
        const pkceChallenge = btoa(String.fromCharCode(...digest)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
        let next: URL;
        if (provider === "github") {
          const ticketId = hex(crypto.getRandomValues(new Uint8Array(16)));
          next = new URL(endpoint + "/github", project);
          next.search = new URLSearchParams({
            ticket: await sealCookie(GITHUB_TICKET, `${ticketId}~${pkceChallenge}`, GITHUB_TICKET_TTL),
          }).toString();
        } else {
          next = new URL("/auth/v1/authorize", project);
          next.search = new URLSearchParams({
            provider: "google", redirect_to: callback.href, code_challenge: pkceChallenge, code_challenge_method: "s256",
          }).toString();
        }
        const response = reply(200, { url: next.href });
        cookie(response, PKCE, await sealCookie(PKCE, verifier, 600), 600);
        return response;
      }

      if (operation === "GET /callback") {
        const code = url.searchParams.get("code");
        if (!code || !UUID.test(code) || url.searchParams.has("error")) return finish(false);
        const verifier = await openCookie(req, PKCE, /^[0-9a-f]{64}$/);
        if (!verifier) return finish(false);
        const result = await auth("token?grant_type=pkce", {
          method: "POST",
          body: JSON.stringify({ auth_code: code, code_verifier: verifier }),
        });
        if (!result.ok) return finish(false);
        const response = finish(true);
        const saved = storeSession(response, await result.json());
        if (!saved) return finish(false);
        await saved;
        return response;
      }

      const validToken = await openCookie(req, SESSION, TOKEN);
      if (operation === "GET /session") {
        if (!validToken) return reply(401, { error: "sign_in_required" });
        const result = await auth("user", {}, validToken);
        if (result.status === 401 || result.status === 403) return reply(401, { error: "sign_in_required" });
        if (!result.ok) return reply(503, { error: "signin_unavailable" });
        const user = fields(await result.json());
        if (typeof user.id !== "string" || !UUID.test(user.id) || user.role !== "authenticated" || user.is_anonymous === true) {
          return reply(401, { error: "sign_in_required" });
        }
        return reply(200, { accountId: user.id });
      }

      if (operation === "POST /logout") {
        const result = validToken ? await auth("logout?scope=local", { method: "POST" }, validToken).catch(() => null) : undefined;
        const failed = result === null || (result && !result.ok && result.status !== 401 && result.status !== 403);
        const response = failed ? reply(503, { error: "logout_service_unavailable" }) : reply(204);
        cookie(response, SESSION, "", 0);
        cookie(response, PKCE, "", 0);
        return response;
      }

      return reply(404, { error: "not_found" });
    } catch {
      if (operation === "GET /callback") return finish(false);
      return reply(503, { error: "signin_unavailable" });
    }
  };
}
