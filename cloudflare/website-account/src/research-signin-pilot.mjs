const turnstileOrigin = "https://challenges.cloudflare.com";
const googleOrigin = "https://accounts.google.com";
const fontStyles = "https://fonts.googleapis.com";
const fontFiles = "https://fonts.gstatic.com";

// Keep browser code as text so the Worker bundler cannot inject server-side helpers.
const pilotScript = String.raw`(() => {
  const status = document.getElementById("status");
  const signIn = document.getElementById("sign-in");
  const googleButton = document.getElementById("google-sign-in");
  const githubButton = document.getElementById("github-sign-in");
  const providers = document.getElementById("providers");
  const signOut = document.getElementById("sign-out");
  const check = document.getElementById("check-session");
  const challenge = document.getElementById("challenge");
  const challengeStep = document.getElementById("challenge-step");
  const signedIn = document.getElementById("signed-in");
  const card = document.querySelector(".card");
  const issuer = document.body.dataset.authOrigin;
  const nonce = document.currentScript.nonce;
  const TICKET = /^[0-9a-f]{32}~[A-Za-z0-9_-]{43}\.[0-9]{1,12}\.[0-9a-f]{64}$/;
  let token;
  let widget;
  let loadingWidget = false;
  let awaitingProvider = "";
  let initializingGoogle = false;
  let googleReady = false;
  let submitting = false;

  function say(text, tone) {
    status.textContent = text;
    status.dataset.tone = tone || "";
  }

  function showChallenge(value) {
    token = value;
    signIn.disabled = !value;
    if (githubButton) githubButton.disabled = !value;
    if (providers) providers.dataset.ready = value ? "true" : "false";
    if (challengeStep) challengeStep.dataset.done = value ? "true" : "false";
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
    say("Signing in…");
    try {
      const response = await jsonRequest("/auth/signup", { challenge: completedChallenge, credential });
      if (!response.ok) throw new Error("Could not sign in");
      location.replace("/");
    } catch {
      say("Could not sign in. Complete a fresh security check and try again.", "error");
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
      const width = Math.max(200, Math.min(400, Math.round(googleButton.getBoundingClientRect().width || 320)));
      google.accounts.id.renderButton(googleButton, {
        theme: "filled_black", text: "continue_with", size: "large", shape: "rectangular", logo_alignment: "left", width,
      });
      googleReady = true;
    } catch {
      say("Google sign-in could not load. Reload this page to try again.", "error");
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
          theme: "dark",
          callback: (value) => {
            showChallenge(value);
            say(awaitingProvider ? status.textContent : "Security check passed. Choose how to continue.");
          },
          "expired-callback": () => {
            showChallenge(undefined);
            say("The security check expired. Complete it again to continue.");
          },
          "error-callback": () => {
            showChallenge(undefined);
            say("The security check could not load. Reload this page to try again.", "error");
          },
        });
        loadingWidget = false;
      };
      script.onerror = () => {
        delete window.verityPilotWidgetReady;
        script.remove();
        loadingWidget = false;
        say("The security check could not load. Reload this page to try again.", "error");
      };
      document.head.append(script);
    } catch {
      loadingWidget = false;
      say("Sign-in is temporarily unavailable. Try again shortly.", "error");
    }
  }

  function showSignedOut() {
    card.dataset.state = "signed-out";
    signIn.hidden = Boolean(googleButton);
    signOut.hidden = true;
    if (signedIn) signedIn.hidden = true;
    if (providers) providers.hidden = false;
    if (challengeStep) challengeStep.hidden = false;
    challenge.hidden = false;
  }

  async function checkSession() {
    check.disabled = true;
    try {
      const session = await fetch("/auth/session", { cache: "no-store", redirect: "error" });
      if (session.status === 401) {
        showSignedOut();
        say(awaitingProvider
          ? "Finish signing in on the " + awaitingProvider + " tab. If you closed it, you can try again here."
          : "Complete the security check to continue.");
        await loadWidget();
        return;
      }
      if (!session.ok) throw new Error("Could not check session");
      awaitingProvider = "";
      card.dataset.state = "signed-in";
      signIn.hidden = true;
      if (googleButton) googleButton.hidden = true;
      if (providers) providers.hidden = true;
      if (challengeStep) challengeStep.hidden = true;
      if (signedIn) signedIn.hidden = false;
      signOut.hidden = false;
      challenge.hidden = true;
      const reports = await fetch("/api/account/runs", { cache: "no-store", redirect: "error" });
      if (!reports.ok) {
        say("Signed in. Saved research is temporarily unavailable.");
        return;
      }
      const { data } = await reports.json();
      say(Array.isArray(data)
        ? "Signed in. " + data.length + (data.length === 1 ? " saved run." : " saved runs.")
        : "Signed in. The saved research response was unexpected.", "ok");
    } catch {
      say("Could not check sign-in. Try again shortly.", "error");
    } finally {
      check.disabled = false;
    }
  }

  function expectedDestination(provider, next) {
    if (next.origin !== issuer || next.username || next.password || next.hash) return false;
    if (provider === "github") {
      const keys = Array.from(next.searchParams.keys());
      return next.pathname === "/functions/v1/consumer-auth/github" && keys.length === 1 && keys[0] === "ticket" &&
        TICKET.test(next.searchParams.get("ticket") || "");
    }
    return next.pathname === "/auth/v1/authorize" && next.searchParams.get("provider") === "google" &&
      next.searchParams.get("redirect_to") === location.origin + "/auth/callback";
  }

  async function startRedirect(provider, button) {
    if (!token || button.disabled || submitting) return;
    submitting = true;
    const completedChallenge = token;
    showChallenge(undefined);
    const label = provider === "github" ? "GitHub" : "Google";
    // Google opens in a new tab and this page waits; GitHub continues in this tab.
    const loginTab = provider === "google" ? window.open("about:blank", "_blank") : null;
    if (loginTab) loginTab.opener = null;
    say("Starting " + label + " sign-in…");
    try {
      const body = provider === "google" ? { challenge: completedChallenge } : { challenge: completedChallenge, provider };
      const response = await jsonRequest("/auth/start", body);
      if (!response.ok) throw new Error("Could not start sign-in");
      const next = new URL((await response.json()).url);
      if (!expectedDestination(provider, next)) throw new Error("Unexpected sign-in destination");
      if (loginTab && !loginTab.closed) {
        loginTab.location.replace(next.href);
        awaitingProvider = label;
        say("After completing " + label + " sign-in, return to this tab.");
        resetChallenge();
      } else {
        location.assign(next.href);
      }
    } catch {
      loginTab?.close();
      say("Could not start sign-in. Complete a fresh security check and try again.", "error");
      resetChallenge();
    } finally {
      submitting = false;
    }
  }

  signIn.addEventListener("click", () => startRedirect("google", signIn));
  githubButton?.addEventListener("click", () => startRedirect("github", githubButton));
  window.addEventListener("focus", () => {
    if (awaitingProvider && !check.disabled) void checkSession();
  });
  window.addEventListener("pageshow", (event) => { if (event.persisted) void checkSession(); });
  check.addEventListener("click", checkSession);
  signOut.addEventListener("click", async () => {
    signOut.disabled = true;
    try {
      if (!(await jsonRequest("/auth/logout", {})).ok) throw new Error("Could not complete sign-out");
      resetChallenge();
      await checkSession();
      say("Signed out. Complete the security check to sign in again.");
    } catch {
      say("Could not confirm sign-out. Check your session again.", "error");
    } finally {
      signOut.disabled = false;
    }
  });
  void checkSession();
})();`;

const styles = String.raw`
  [hidden] { display: none !important; }
  :root {
    color-scheme: dark;
    --bg-void: #090C10; --bg-surface: #10151E; --bg-elevated: #161D29;
    --border-hairline: #1E2738; --border-strong: #2A3550;
    --accent-blue: #2E5CFF; --accent-blue-text: #7C9BFF;
    --signal-yes: #00C853; --signal-no-text: #FF6B62;
    --text-primary: #F1F5F9; --text-muted: #8B9BB4;
    --font-sans: "Space Grotesk", ui-sans-serif, system-ui, sans-serif;
    --font-mono: "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace;
    --ease: cubic-bezier(0.24, 1, 0.4, 1);
  }
  * { box-sizing: border-box; }
  html, body { min-height: 100%; }
  body {
    margin: 0; color: var(--text-primary); font: 1rem/1.55 var(--font-sans);
    background:
      radial-gradient(60rem 36rem at 85% -10%, rgba(46, 92, 255, .22), transparent 60%),
      radial-gradient(40rem 30rem at -10% 110%, rgba(0, 200, 83, .08), transparent 60%),
      var(--bg-void);
    display: grid; place-items: center; padding: 32px 16px;
  }
  body::before {
    content: ""; position: fixed; inset: 0; pointer-events: none; z-index: 0;
    background-image:
      linear-gradient(rgba(124, 155, 255, .05) 1px, transparent 1px),
      linear-gradient(90deg, rgba(124, 155, 255, .05) 1px, transparent 1px);
    background-size: 48px 48px;
    mask-image: radial-gradient(ellipse at center, #000 30%, transparent 75%);
  }
  main { position: relative; z-index: 1; width: 100%; max-width: 440px; }
  .brand {
    display: inline-flex; align-items: center; gap: 10px; margin-bottom: 20px;
    color: var(--text-primary); text-decoration: none; font-weight: 600; letter-spacing: -.01em; font-size: 1.1rem;
  }
  .brand svg { width: 28px; height: 28px; }
  .brand:focus-visible, button:focus-visible, a:focus-visible { outline: 2px solid var(--accent-blue-text); outline-offset: 3px; border-radius: 6px; }
  .card {
    background: linear-gradient(180deg, rgba(22, 29, 41, .92), rgba(16, 21, 30, .96));
    border: 1px solid var(--border-strong); border-radius: 14px; padding: 28px;
    box-shadow: 0 24px 60px -24px rgba(0, 0, 0, .8), 0 0 0 1px rgba(46, 92, 255, .06) inset;
    backdrop-filter: blur(8px);
    animation: rise .5s var(--ease) both;
  }
  @keyframes rise { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: none; } }
  .eyebrow { font: 500 .72rem/1 var(--font-mono); letter-spacing: .08em; text-transform: uppercase; color: var(--accent-blue-text); margin: 0 0 10px; }
  h1 { margin: 0 0 8px; font-size: 1.75rem; line-height: 1.15; letter-spacing: -.02em; }
  .lede { margin: 0 0 22px; color: var(--text-muted); }
  .step { border: 1px solid var(--border-hairline); border-radius: 10px; padding: 14px; background: rgba(9, 12, 16, .45); }
  .step + .step { margin-top: 12px; }
  .step-head { display: flex; align-items: center; gap: 10px; margin-bottom: 12px; font-size: .92rem; font-weight: 500; }
  .step-num {
    width: 22px; height: 22px; border-radius: 50%; display: grid; place-items: center; flex: none;
    font: 500 .72rem/1 var(--font-mono); border: 1px solid var(--border-strong); color: var(--text-muted);
    transition: background .2s var(--ease), color .2s var(--ease), border-color .2s var(--ease);
  }
  [data-done="true"] .step-num, [data-ready="true"] .step-num { background: var(--accent-blue); border-color: var(--accent-blue); color: #fff; }
  #challenge { min-height: 65px; }
  .providers { display: grid; gap: 10px; }
  .providers[data-ready="false"] .hint { display: block; }
  .hint { display: none; margin: 0; font-size: .82rem; color: var(--text-muted); }
  #google-sign-in { min-height: 44px; width: 100%; }
  .btn {
    display: flex; align-items: center; justify-content: center; gap: 10px; width: 100%; min-height: 44px;
    padding: 10px 14px; border-radius: 6px; cursor: pointer;
    font: 500 .95rem/1 var(--font-sans); color: var(--text-primary);
    background: #0D1117; border: 1px solid #3A4456;
    transition: background .18s var(--ease), border-color .18s var(--ease), transform .18s var(--ease), opacity .18s;
  }
  .btn svg { width: 20px; height: 20px; flex: none; }
  .btn:hover:not(:disabled) { background: #161B22; border-color: #57627A; }
  .btn:active:not(:disabled) { transform: translateY(1px); }
  .btn:disabled { opacity: .45; cursor: not-allowed; }
  .btn.quiet { background: transparent; border-color: var(--border-hairline); color: var(--text-muted); font-size: .85rem; min-height: 36px; width: auto; }
  .btn.quiet:hover:not(:disabled) { color: var(--text-primary); background: rgba(255, 255, 255, .03); }
  .btn.primary { background: var(--accent-blue); border-color: var(--accent-blue); color: #fff; }
  .btn.primary:hover:not(:disabled) { background: #4A72FF; border-color: #4A72FF; }
  #status {
    margin: 18px 0 0; min-height: 1.5em; font-size: .9rem; color: var(--text-muted);
    display: flex; gap: 8px; align-items: flex-start;
  }
  #status::before { content: ""; width: 8px; height: 8px; margin-top: .45em; border-radius: 50%; background: var(--border-strong); flex: none; }
  #status[data-tone="ok"] { color: var(--text-primary); }
  #status[data-tone="ok"]::before { background: var(--signal-yes); box-shadow: 0 0 0 3px rgba(0, 200, 83, .18); }
  #status[data-tone="error"] { color: var(--signal-no-text); }
  #status[data-tone="error"]::before { background: var(--signal-no-text); }
  .signed-in { text-align: center; padding: 8px 0 4px; }
  .signed-in .badge {
    width: 56px; height: 56px; border-radius: 50%; margin: 0 auto 12px; display: grid; place-items: center;
    background: rgba(0, 200, 83, .12); border: 1px solid rgba(0, 200, 83, .35); color: var(--signal-yes);
  }
  .signed-in .badge svg { width: 26px; height: 26px; }
  .signed-in .btn { margin-top: 14px; text-decoration: none; }
  .actions { display: flex; gap: 8px; justify-content: space-between; align-items: center; margin-top: 18px; flex-wrap: wrap; }
  .trust { list-style: none; margin: 20px 0 0; padding: 18px 0 0; border-top: 1px solid var(--border-hairline); display: grid; gap: 10px; }
  .trust li { display: grid; grid-template-columns: 18px 1fr; gap: 10px; font-size: .82rem; color: var(--text-muted); line-height: 1.45; }
  .trust svg { width: 16px; height: 16px; margin-top: 2px; color: var(--accent-blue-text); }
  .fine { margin: 18px 4px 0; font-size: .75rem; color: var(--text-muted); text-align: center; }
  .fine a { color: var(--accent-blue-text); }
  noscript p { color: var(--signal-no-text); }
  @media (max-width: 420px) { .card { padding: 20px; } h1 { font-size: 1.5rem; } }
  @media (prefers-reduced-motion: reduce) { *, *::before { animation: none !important; transition: none !important; } }
`;

const icons = {
  mark: '<svg viewBox="0 0 32 32" aria-hidden="true"><rect width="32" height="32" rx="8" fill="#2E5CFF"/><path d="M9 10l7 13 7-13" fill="none" stroke="#fff" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  github: '<svg viewBox="0 0 16 16" aria-hidden="true" fill="currentColor"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>',
  shield: '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="M9 12l2 2 4-4"/></svg>',
  key: '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="7.5" cy="15.5" r="4.5"/><path d="M10.7 12.3L21 2M16 7l3 3M18 5l2 2"/></svg>',
  lock: '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 018 0v4"/></svg>',
  eye: '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>',
  check: '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>',
};

export function researchSignInPilot(env, publicSignup = false) {
  const authOrigin = /^https:\/\/[a-z0-9]{20}\.supabase\.co(?=\/functions\/v1\/consumer-auth$)/
    .exec(env.VERITY_AUTH_EDGE_URL ?? "")?.[0];
  if (!authOrigin) return new Response("Sign-in is temporarily unavailable.", {
    status: 503, headers: { "Cache-Control": "private, no-store", "Content-Type": "text/plain; charset=utf-8" },
  });

  const github = publicSignup && env.VERITY_AUTH_GITHUB_SIGNUP === "true";
  const nonce = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(18))));
  const title = publicSignup ? "Sign in to Verity" : "Research sign-in pilot";
  const instructions = publicSignup
    ? `Save your research and pick up where you left off. New here? Signing in creates your account.`
    : "Use the Google account that received your Verity invitation. If sign-in opens in this tab, reopen this page afterward to check your session.";
  const sharing = github
    ? "Google shares your name, email address and profile picture. GitHub shares your email addresses, read-only."
    : "Google shares your name, email address and profile picture.";
  return new Response(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="referrer" content="no-referrer">
  <meta name="color-scheme" content="dark">
  <title>${publicSignup ? title : "Verity research sign-in pilot"}</title>
  <link rel="preconnect" href="${fontStyles}">
  <link rel="preconnect" href="${fontFiles}" crossorigin>
  <link nonce="${nonce}" rel="stylesheet" href="${fontStyles}/css2?family=JetBrains+Mono:wght@500&family=Space+Grotesk:wght@400;500;600&display=swap">
  <style nonce="${nonce}">${styles}</style>
</head>
<body data-auth-origin="${authOrigin}">
  <main>
    <a class="brand" href="/">${icons.mark}<span>Verity</span></a>
    <section class="card" data-state="loading" aria-labelledby="title">
      <p class="eyebrow">${publicSignup ? "Account" : "Pilot"}</p>
      <h1 id="title">${title}</h1>
      <p class="lede">${instructions}</p>

      <div class="step" id="challenge-step" data-done="false" hidden>
        <div class="step-head"><span class="step-num">1</span>Confirm you're human</div>
        <div id="challenge" hidden></div>
      </div>

      <div class="step providers" id="providers" data-ready="false" hidden>
        <div class="step-head"><span class="step-num">2</span>Choose how to continue</div>
        <p class="hint">Finish the security check to turn these on.</p>
        ${publicSignup ? '<div id="google-sign-in" hidden></div>' : ""}
        <button id="sign-in" class="btn" type="button" disabled hidden>Continue with Google</button>
        ${github ? `<button id="github-sign-in" class="btn" type="button" disabled>${icons.github}<span>Continue with GitHub</span></button>` : ""}
      </div>

      <div class="signed-in" id="signed-in" hidden>
        <div class="badge">${icons.check}</div>
        <h2 class="eyebrow">You're signed in</h2>
        <a class="btn primary" href="/">Go to Verity</a>
      </div>

      <p id="status" role="status" aria-live="polite">Checking your session…</p>

      <div class="actions">
        <button id="check-session" class="btn quiet" type="button">Refresh status</button>
        <button id="sign-out" class="btn quiet" type="button" hidden>Sign out</button>
      </div>

      <ul class="trust">
        <li>${icons.shield}<span>Every sign-in starts with a Cloudflare Turnstile check, so bots can't create accounts.</span></li>
        <li>${icons.key}<span>No passwords. ${github ? "Google or GitHub confirms" : "Google confirms"} it's you, and Verity never sees your password.</span></li>
        <li>${icons.lock}<span>Your session lives in a secure, HttpOnly cookie that page scripts can't read. It ends after 30 minutes.</span></li>
        <li>${icons.eye}<span>${sharing}</span></li>
      </ul>
      <noscript><p>JavaScript is required for the security check and sign-in.</p></noscript>
    </section>
    <p class="fine">Research on Verity is free to read without an account. <a href="/">Back to Verity</a></p>
  </main>
  <script nonce="${nonce}">${pilotScript}</script>
</body>
</html>`, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "private, no-store",
      "Content-Security-Policy": `default-src 'none'; script-src 'nonce-${nonce}' 'strict-dynamic' ${turnstileOrigin}; ` +
        `style-src 'nonce-${nonce}' ${fontStyles}${publicSignup ? ` ${googleOrigin}/gsi/style` : ""}; ` +
        `font-src ${fontFiles}; ` +
        `frame-src ${turnstileOrigin}${publicSignup ? ` ${googleOrigin}/gsi/` : ""}; ` +
        `connect-src 'self'${publicSignup ? ` ${googleOrigin}/gsi/` : ""}; frame-ancestors 'none'; ` +
        "base-uri 'none'; form-action 'none'; object-src 'none'",
      ...(publicSignup ? { "Cross-Origin-Opener-Policy": "same-origin-allow-popups" } : {}),
      "Cross-Origin-Resource-Policy": "same-origin",
      "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
      "Strict-Transport-Security": "max-age=31536000",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
      "X-Robots-Tag": "noindex, nofollow",
    },
  });
}
