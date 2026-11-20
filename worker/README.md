# Verity AI and news Worker (`worker/`)

Cloudflare Worker `verity-gemini`, deployed at https://verity-gemini.safe-572.workers.dev. The website calls it for every AI, news and research feature, so no API key is ever in the page.

## Endpoints

All of them accept requests only from `https://verityresearch.us` (the `Origin` header).

| Endpoint | Does |
| --- | --- |
| `POST /review` | `mode: "review"` or `"ask"`: Google Gemini review of a market's settlement rules, falling back to Workers AI (Llama 3.3 70B). `mode: "forecast"`: Google Gemini and Workers AI each estimate P(Yes) from the price history, with Exa research added when the key is set. Rate-limited to 6 per minute per IP. Bodies are limited to 24 KB. |
| `GET /news` | Crypto headlines from the CoinDesk, Cointelegraph, Decrypt and The Block RSS feeds, cached for 10 minutes |
| `GET /research?q=&days=` | Exa news search, cached for 30 minutes per query |
| `GET /status` | Which Gemini model is in use, the last call's outcome, and whether each key is set. It never shows keys. |

## Files

- `worker.mjs`: the Worker code.
- `wrangler.toml`: its config, with the vars `SITE_ORIGIN`, `GEMINI_MODEL` (preferred model; retired names are replaced automatically) and `BACKUP_MODEL`, plus the `[ai]` binding and the rate limiter.
- `deploy.ps1`: a Windows one-step deploy. It writes these two files to a temp folder, runs `wrangler deploy`, and offers to set the Exa key.

## Secrets

Secrets are stored on Cloudflare and never in this repo:

```bash
npx wrangler secret put GEMINI_API_KEY   # Google AI Studio key
npx wrangler secret put EXA_API_KEY      # dashboard.exa.ai key
```

Deploying again does not remove saved secrets. Never paste a key into chat, code or a commit.

## Deploy

```bash
cd worker
npx wrangler@4 deploy
```

On Windows you can use `powershell -ExecutionPolicy Bypass -File deploy.ps1` instead.

## Notes

- Workers' `fetch` supports only `redirect: 'follow'` or `'manual'`. `'error'` throws, which broke the first version.
- Gemini thinking is turned down (`thinkingBudget: 0` for 2.5, `thinkingLevel: 'low'` for 3.x) so answers return before the 14-second timeout. A model that rejects the setting is retried without it.
- Workers AI's JSON mode can fail with "JSON Mode couldn't be met", so the Worker retries with `json_object`.
