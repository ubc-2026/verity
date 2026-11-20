# Verity website (`site/`)

This folder holds two sites.

The public site at https://verityresearch.us is one self-contained HTML file (vanilla HTML, CSS and JavaScript) built from the terminal parts below. No framework and no npm install for that build.

The React site in the same folder is the team portal: the ledger page, the run page, and recorded research history. It uses `package.json` and Vite.

## Terminal site (verityresearch.us)

| File | What it holds |
| --- | --- |
| `src/style.css` | Design tokens and every style (see `DESIGN.md`) |
| `src/body.html` | All page markup |
| `src/app1.js` | Utilities, Nov 18 market data, nav, the Three.js coin, both terminal charts (including live Gemini Exchange candles) |
| `src/live.js` | Live Gemini Exchange store (markets list, price feed), browser port of `verity-rules-v1`, the live market board and its topic tabs |
| `src/ticker.js` | Top ticker (live markets) |
| `src/app2.js` | Terminal score, inspector, market details and outcomes, walkthrough, architecture diagram, code tabs |
| `src/gemini.js` | AI panel: Google Gemini review and questions, combined forecast, Exa market research, movable and resizable window |
| `src/news.js` | Crypto news (publisher RSS via the Worker, Hacker News fallback) and Exa research search |
| `src/app3.js` | Reconciler ledger, verification drawer, start-up |
| `keccak.js` | keccak-256 for request hashes |
| `build.sh` | Joins everything into `dist/index.html` (order matters; see the script) |
| `dist/index.html` | The built site, identical to what verityresearch.us serves |

The AI, news and research features call the Cloudflare Worker in `../worker/`. The page never holds an API key.

## React portal

| File | What it holds |
| --- | --- |
| Text, numbers, sections | `src/App.tsx` (the data lists at the top hold most of the content) |
| Layout and styling | `src/site.css` |
| Colours, fonts, spacing | `src/tokens.css` |
| The 3D coin | `src/Coin3D.tsx` |
| The ledger page | `src/Portal.tsx`, opened at `#ledger` |
| The run page (one market, end to end) | `src/Run.tsx`, opened at `#run`. It needs `npm run app` in the repo root, or shows the recorded fixture preview |
| Recorded history on the run page | `src/ResearchHistory.tsx`, section V of `#run`. It reads `/api/research`, or shows `src/research-preview.json` (`npm run research:snapshot`) |

`npm ci && npm run dev` inside `site/` proxies `/api` to the app server. `npm run build` writes the React `dist` build. The terminal `dist/index.html` and the React build use the same output path, so build the one you are about to publish and do not run both builds without saving the result you want.

## Edit and publish the terminal site

1. Edit the terminal files in `src/`, then run `sh build.sh`.
2. Open `dist/index.html` to check it. Live data needs a real HTTPS origin, so test risky changes as `preview.html` on the live repo first.
3. Copy `dist/index.html` to `index.html` in `ryanmarklin-arch/verityresearch-live` (keep `CNAME` and `.nojekyll`) and push to `main`. GitHub Pages serves it.

## Data rules

- Quotes, candles and the crypto spot prices are live from the public Gemini Exchange API. "Gemini" alone means Gemini Exchange; the AI model is always written "Google Gemini".
- The two Nov 18 markets use the real captured analysis with demo price paths, labelled.
- The walkthrough and the reconciler ledger are simulations, labelled. No control can reach a wallet, signer or payment endpoint.
- The AI forecast is an experimental model estimate, not trading advice. Verity places no trades.
