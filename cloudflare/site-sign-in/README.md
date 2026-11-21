# verity-site-sign-in (website Worker)

This Worker runs in front of the GitHub Pages site on `verityresearch.us/*` (Cloudflare account Verity). It does four things:

- Adds the Sign in and Sign out buttons to the homepage nav, and hides the operator ledger.
- Injects the voice controls into the AI second opinion panel.
- Serves the voice browser code: `/_verity/voice.js`, `/_verity/voice-sdk.js` and `/_verity/voice-resampler.js`.
- Issues one-use ElevenLabs voice sessions at `/_verity/voice-session`, and reports the remaining balance at `/_verity/voice-allowance`.

This folder is the source of the deployed version. Before 2026-11-21 that source was not in git. It was recovered from the live Worker: the server files come from its source map, and `voice-controls.mjs` is confirmed by an esbuild build that is byte-identical to the live `voice.js`. The only addition is the `get_selected_market` tool.

| File | Purpose |
|---|---|
| `worker.mjs` | Homepage rewriting, voice routes and static voice assets |
| `voice-session.mjs` | Origin check, IP rate limit, session check through `verity-website-account`, the allowance, and the ElevenLabs signed URL |
| `voice-budget.mjs` | `VoiceBudget` Durable Object, deployed separately as `verity-voice-budget` |
| `voice-controls.mjs` | Browser voice controls, bundled into `.generated/voice-entry.txt` |
| `voice-sdk.mjs`, `voice-entry.mjs`, `build-voice.mjs` | esbuild entry points for the browser bundles |

## Voice agent and live market data

The browser starts the ElevenLabs agent `agent_9001m7x29v7kekz8wm2tek94vg2v` with one client tool:

- `get_selected_market` returns the market the visitor has open. It calls the page's own `marketContext()`, the same public data the text review sends.

The agent's other tools call the AI Worker (`worker/`, `verity-gemini`) directly:

- `get_market` calls `GET /market?ticker=…`.
- `find_markets` calls `GET /markets?q=…`.

The prompt tells the agent to look market data up itself and never ask the caller to describe a market. The agent's prompt and tools live in ElevenLabs, not in this folder.

## Commands

```sh
npm ci --ignore-scripts
npm test                         # builds the browser bundles, then runs the controls and session tests
npx wrangler deploy --dry-run    # preview the bundle and bindings
npx wrangler deploy              # website Worker (ask the owner first)
npx wrangler deploy --config wrangler.voice-budget.jsonc   # budget Durable Object Worker
```

The only secret is `ELEVENLABS_API_KEY`, set with `wrangler secret put`. Never commit it. `Test-ElevenLabsVoiceKey.ps1` checks a key at a masked prompt without starting a call. `Set-ElevenLabsVoiceGuardrails.ps1` previews the agent's native guardrails and saves them only with `-Apply`.

## Limits

- Signed-in visitors get 3 call starts per UTC day, counted on both the account and its browser cookie.
- Guests get one call, ever. A previous guest call from the same IP address or the same browser blocks another.
- The whole demo is capped at 20 starts per UTC day and 100 starts over the last 31 UTC days. Each call lasts at most 60 seconds.
- The allowance is charged only after ElevenLabs returns a valid signed ticket.
- The budget stores keyed hashes only: no raw IP addresses, raw account IDs, audio or keys.

## Voice opt-in

Above Start voice, the panel shows a notice that ElevenLabs receives the microphone audio, with a link to `/privacy.html`. Below the notice is a checkbox: "I agree to send microphone audio to ElevenLabs for this call."

- Start voice stays disabled until the box is ticked.
- Nothing asks for the microphone or a ticket before that.
- The box locks during the call and clears when the call ends, so each call needs a fresh opt-in.

## Not released yet

An earlier session's local copy also has homepage CSP headers and a live agent transcript. Neither is live or in this folder. Ship each as its own change.
