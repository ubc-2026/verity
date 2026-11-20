const turnstileOrigin = "https://challenges.cloudflare.com";
const googleOrigin = "https://accounts.google.com";

// Keep browser code as text so the Worker bundler cannot inject server-side helpers.
const pilotScript = String.raw`(() => {
  const status = document.getElementById("status");
  const signIn = document.getElementById("sign-in");
  const googleButton = document.getElementById("google-sign-in");
  const signOut = document.getElementById("sign-out");
  const check = document.getElementById("check-session");
  const challenge = document.getElementById("challenge");
  const issuer = document.body.dataset.authOrigin;
  const nonce = document.currentScript.nonce;
  let token;
  let widget;
  let loadingWidget = false;
  let awaitingGoogle = false;
  let initializingGoogle = false;
  let googleReady = false;
  let submitting = false;

  function showChallenge(value) {
    token = value;
    signIn.disabled = !value;
    if (googleButton) {
      googleButton.hidden = !value;
      if (value) void prepareGoogle();
    }
  }

  function resetChallenge() {
    showChallenge(undefined);
    if (widget !== undefined) window.turnstile.reset(widget);
  }

  function jsonRequest(path, data) {
    return fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
      redirect: "error",
    });
  }

  async function completeGoogle({ credential }) {
    if (!token || submitting || typeof credential !== "string") return;
    submitting = true;
    const completedChallenge = token;
    showChallenge(undefined);
    status.textContent = "Signing in…";
    try {
      const response = await jsonRequest("/auth/signup", { challenge: completedChallenge, credential });
      if (!response.ok) throw new Error("Could not sign in");
      location.replace("/");
    } catch {
      status.textContent = "Could not sign in. Complete a fresh security check and try again.";
    } finally {
      submitting = false;
      resetChallenge();
    }
  }

  async function prepareGoogle() {
    if (googleReady || initializingGoogle) return;
    initializingGoogle = true;
    try {
      const response = await fetch("/auth/signup-context", { cache: "no-store", redirect: "error" });
      if (!response.ok) throw new Error("Sign-in configuration unavailable");
      const { clientId, nonce: googleNonce } = await response.json();
      if (!/^[A-Za-z0-9-]+\.apps\.googleusercontent\.com$/.test(clientId ?? "") ||
          !/^[0-9a-f]{64}$/.test(googleNonce ?? "")) throw new Error("Invalid Google configuration");
      await new Promise((resolve, reject) => {
        const script = document.createElement("script");
        script.nonce = nonce;
        script.src = "https://accounts.google.com/gsi/client";
        script.onload = resolve;
        script.onerror = () => { script.remove(); reject(new Error("Google sign-in could not load")); };
        document.head.append(script);
      });
      google.accounts.id.initialize({ client_id: clientId, nonce: googleNonce, callback: completeGoogle, ux_mode: "popup" });
      google.accounts.id.renderButton(googleButton, { theme: "filled_black", text: "continue_with", size: "large" });
      googleReady = true;
    } catch {
      status.textContent = "Google sign-in could not load. Reload this page to try again.";
    } finally {
      initializingGoogle = false;
    }
  }

  async function loadWidget() {
    if (loadingWidget || widget !== undefined) return;
    loadingWidget = true;
    try {
      const config = await fetch("/auth/config", { cache: "no-store", redirect: "error" });
      if (!config.ok) throw new Error("Sign-in configuration unavailable");
      const { turnstileSiteKey } = await config.json();
      if (!/^[A-Za-z0-9_-]{10,80}$/.test(turnstileSiteKey ?? "")) throw new Error("Invalid widget configuration");
      const script = document.createElement("script");
      script.nonce = nonce;
      script.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit&onload=verityPilotWidgetReady";
      window.verityPilotWidgetReady = () => {
        delete window.verityPilotWidgetReady;
        widget = window.turnstile.render(challenge, {
          sitekey: turnstileSiteKey,
          action: "verity_signin",
          callback: showChallenge,
          "expired-callback": () => showChallenge(undefined),
          "error-callback": () => {
            showChallenge(undefined);
            status.textContent = "The security check could not load. Reload this page to try again.";
          },
        });
        loadingWidget = false;
      };
      script.onerror = () => {
        delete window.verityPilotWidgetReady;
        script.remove();
        loadingWidget = false;
        status.textContent = "The security check could not load. Reload this page to try again.";
      };
      document.head.append(script);
    } catch {
      loadingWidget = false;
      status.textContent = "Sign-in is temporarily unavailable. Try again shortly.";
    }
  }

  async function checkSession() {
    check.disabled = true;
    try {
      const session = await fetch("/auth/session", { cache: "no-store", redirect: "error" });
      if (session.status === 401) {
        signIn.hidden = Boolean(googleButton);
        signOut.hidden = true;
        challenge.hidden = false;
        status.textContent = awaitingGoogle
          ? "Finish signing in on the Google tab. If you closed it, you can try again here."
          : "Signed out. Complete the security check to continue.";
        await loadWidget();
        return;
      }
      if (!session.ok) throw new Error("Could not check session");
      awaitingGoogle = false;
      signIn.hidden = true;
      if (googleButton) googleButton.hidden = true;
      signOut.hidden = false;
      challenge.hidden = true;
      const reports = await fetch("/api/account/runs", { cache: "no-store", redirect: "error" });
      if (!reports.ok) {
        status.textContent = "Signed in. Saved research is temporarily unavailable.";
        return;
      }
      const { data } = await reports.json();
      status.textContent = Array.isArray(data)
        ? "Signed in. Private research loaded (" + data.length + " saved runs)."
        : "Signed in. The saved research response was unexpected.";
    } catch {
      status.textContent = "Could not check sign-in. Try again shortly.";
    } finally {
      check.disabled = false;
    }
  }

  signIn.addEventListener("click", async () => {
    if (!token || signIn.disabled) return;
    const completedChallenge = token;
    showChallenge(undefined);
    const loginTab = window.open("about:blank", "_blank");
    if (loginTab) loginTab.opener = null;
    try {
      const response = await jsonRequest("/auth/start", { challenge: completedChallenge });
      if (!response.ok) throw new Error("Could not start sign-in");
      const next = new URL((await response.json()).url);
      if (next.origin !== issuer || next.username || next.password || next.hash || next.pathname !== "/auth/v1/authorize" ||
          next.searchParams.get("provider") !== "google" ||
          next.searchParams.get("redirect_to") !== location.origin + "/auth/callback") {
        throw new Error("Unexpected sign-in destination");
      }
      if (loginTab && !loginTab.closed) {
        loginTab.location.replace(next.href);
        awaitingGoogle = true;
        status.textContent = "After completing Google sign-in, return to this tab.";
      } else {
        location.assign(next.href);
      }
      resetChallenge();
    } catch {
      loginTab?.close();
      status.textContent = "Could not start sign-in. Complete a fresh security check and try again.";
      resetChallenge();
    }
  });

  window.addEventListener("focus", () => {
    if (awaitingGoogle && !check.disabled) void checkSession();
  });
  check.addEventListener("click", checkSession);
  signOut.addEventListener("click", async () => {
    signOut.disabled = true;
    try {
      if (!(await jsonRequest("/auth/logout", {})).ok) throw new Error("Could not complete sign-out");
      resetChallenge();
      await checkSession();
    } catch {
      status.textContent = "Could not confirm sign-out. Check your session again.";
    } finally {
      signOut.disabled = false;
    }
  });
  void checkSession();
})();`;

export function researchSignInPilot(env, publicSignup = false) {
  const authOrigin = /^https:\/\/[a-z0-9]{20}\.supabase\.co(?=\/functions\/v1\/consumer-auth$)/
    .exec(env.VERITY_AUTH_EDGE_URL ?? "")?.[0];
  if (!authOrigin) return new Response("Sign-in is temporarily unavailable.", {
    status: 503, headers: { "Cache-Control": "private, no-store", "Content-Type": "text/plain; charset=utf-8" },
  });

  const nonce = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(18))));
  const title = publicSignup ? "Sign in to Verity" : "Research sign-in pilot";
  const instructions = publicSignup
    ? "Complete the security check, then use Google to sign in or create your account. Verity uses your basic Google profile to sign you in and keep saved research with your account."
    : "Use the Google account that received your Verity invitation. If sign-in opens in this tab, reopen this page afterward to check your session.";
  return new Response(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${publicSignup ? title : "Verity research sign-in pilot"}</title>
  <style nonce="${nonce}">
    [hidden] { display: none !important; }
    :root { color-scheme: dark; font: 1rem/1.55 system-ui, sans-serif; }
    body { margin: 0; background: #111722; color: #f2f5fa; }
    main { max-width: 33rem; margin: 10vh auto; padding: 1.25rem; }
    h1 { line-height: 1.15; }
    p { color: #bcc9d9; }
    a { color: #a9d6ff; }
    button { font: inherit; padding: .55rem .75rem; margin: .25rem .35rem .25rem 0; cursor: pointer; }
    button:disabled { cursor: default; }
  </style>
</head>
<body data-auth-origin="${authOrigin}">
  <main>
    <a href="/">Verity</a>
    <h1>${title}</h1>
    <p>${instructions}</p>
    <p id="status" role="status" aria-live="polite">Checking your session…</p>
    <div id="challenge" hidden></div>
    ${publicSignup ? '<div id="google-sign-in" hidden></div>' : ""}
    <button id="sign-in" type="button" disabled hidden>Continue with Google</button>
    <button id="check-session" type="button">Check session</button>
    <button id="sign-out" type="button" hidden>Sign out</button>
    <noscript>JavaScript is required for the security check and Google sign-in.</noscript>
  </main>
  <script nonce="${nonce}">${pilotScript}</script>
</body>
</html>`, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "private, no-store",
      "Content-Security-Policy": `default-src 'none'; script-src 'nonce-${nonce}' 'strict-dynamic' ${turnstileOrigin}; ` +
        `style-src 'nonce-${nonce}'${publicSignup ? ` ${googleOrigin}/gsi/style` : ""}; ` +
        `frame-src ${turnstileOrigin}${publicSignup ? ` ${googleOrigin}/gsi/` : ""}; ` +
        `connect-src 'self'${publicSignup ? ` ${googleOrigin}/gsi/` : ""}; frame-ancestors 'none'; ` +
        "base-uri 'none'; form-action 'none'",
      ...(publicSignup ? { "Cross-Origin-Opener-Policy": "same-origin-allow-popups" } : {}),
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
      "X-Robots-Tag": "noindex, nofollow",
    },
  });
}
