# Verity: handoff for Codex

Read this whole file before changing anything. It describes the project, where every piece lives, how the live website works, the rules you must follow, and what is left to do. You can also save it as `AGENTS.md` in a repo root, where Codex reads it automatically.

State as of **Nov 20, 2026, 1:35 AM ET**. Sections 6b and 9 cover the AI, news and research features added overnight.

---

## 1. What Verity is

Verity is a UBC 2026 hackathon prototype for the University Blockchain Conference. It entered the Agentic Payments and AI track and the Best Use of Arc award.

It is a research agent for prediction markets:

1. It reads how a market settles.
2. It scores the **resolution risk**: how the contract settles, which is a different question from how likely the event is.
3. It buys only the evidence that closes a real gap, paying per request in testnet USDC.

Every purchase stays inside the owner's spending rules. **It places no trades.**

Its core promise: AI agents that can buy what they need, spend only what they are allowed, and prove they got what they paid for.

---

## 2. Hard rules (read first)

1. **Plain "Gemini" means Gemini Exchange**, the prediction-market and crypto exchange at `api.gemini.com`. Always write "Google Gemini" for the AI model and keep the two clearly separate in code and UI.
   - **Update, Nov 19, 11 PM:** the owner asked for an *optional* Google Gemini second opinion on the website (section 6, "AI second opinion"). That panel is the only Google Gemini integration.
   - Do not add Google Gemini to the Python analysis or the scoring.
   - Do not hard-code a key or add a `GEMINI_API_KEY` to the repo; visitors paste their own key on the page.
2. **The score of record uses no LLM.** Scoring is code rules (`verity-rules-v1`). The Google Gemini panel is advisory: it never changes the score, and it buys nothing.
3. **Never put secrets in chat, code or commits.**
   - An API key leaked in an earlier chat, so treat any key ever pasted anywhere as compromised and rotated.
   - Gemini Exchange keys go only in Codespaces secrets or a git-ignored `.env`.
   - Never give a key the Fund Manager role.
   - Reading public market data needs no key.
4. **The owner (Ryan) enters all passwords, wallet approvals and promo codes.** The agent never does.
5. **Never invent metrics, quotes, logos, transactions or hashes.**
   - Real data comes either from the live Gemini Exchange API or from the Nov 17–18, 2026 captures and analysis.
   - Anything simulated must be labelled on the page (`DEMO FIXTURE`, `SIMULATED`).
6. **No demo control may reach a wallet, signer or payment endpoint.** The walkthrough and the ledger are simulations.
7. **The owner retains authority** over publishing, production deploys, paid services, real transactions, credential changes, contract interactions, repo merges, payment-security changes and external service configuration. Ask before doing any of these.
8. **Text is sentence case with proper capitals** (NYC, NWS, USDC, Gemini Exchange). Every animation respects `prefers-reduced-motion`.

---

## 3. Where everything lives

| Thing | Location | Notes |
| --- | --- | --- |
| **Live site** | https://verityresearch.us | GitHub Pages, HTTPS enforced |
| **Live site repo** (public) | `ryanmarklin-arch/verityresearch-live`, branch `main` | Holds the built `index.html` (the whole site), plus `CNAME` (`verityresearch.us`), `.nojekyll`, `robots.txt`, `DESIGN.md` and `README.md`. Pushing to `main` publishes. |
| **Analysis code** (private) | `ubc-2026/verity`, branch `analysis-fixture-slice` | Python, `analysis/` folder. The head when notes were written was `3594cb5a3ba8ab889d63744370de37231c658331`. Morgan's branch `morgan-lin-analysis` was merged in (merge commit `e940e94` on her branch). |
| **Team copy of site source** | `ubc-2026/verity`, branch `website`, folder `site/` | Current as of Nov 20, 1:35 AM ET. `site/dist/index.html` matches the live site. |
| **AI and news Worker** | `ubc-2026/verity`, branch `website`, folder `worker/` | Cloudflare Worker `verity-gemini` (https://verity-gemini.safe-572.workers.dev). Secrets `GEMINI_API_KEY` and `EXA_API_KEY` live on Cloudflare only. See `worker/README.md`. |
| **Old Lovable version** | Lovable project "Verity: Market Clarity" (`2d886bed-95e0-40a5-8a43-568a85f73396`) → https://verity-research.lovable.app; source on `main` of private `ryanmarklin-arch/verityresearch-site` | Superseded. Lovable free credits are used up. |
| **Old certificate design** | `certificate-design` branch of `ryanmarklin-arch/verityresearch-site` | History only |
| **Domain** | `verityresearch.us` at Porkbun (account RyanLion) | Four A records 185.199.108.153 to .111.153, plus `www` CNAME → `ryanmarklin-arch.github.io`. A leftover `*` CNAME → `pixie.porkbun.com` is harmless. |
| **Leftover temp branch** | `team-export3` in `ryanmarklin-arch/verityresearch-site` | Safe to delete |

**Access notes:**
- The `ubc-2026` org is private. Clone it with the owner's own git credentials, or use Codespaces if the org enables them.
- `ryanmarklin-arch/verityresearch-site` is private and the owner said it "does not matter."

---

## 4. The analysis code (`ubc-2026/verity`, `analysis-fixture-slice`)

### Run it

```bash
cd analysis
python -m venv .venv
.venv\Scripts\activate            # macOS/Linux: . .venv/bin/activate
pip install -r requirements.txt   # add requirements-live.txt for live mode
python -m pytest -q               # 49 passed at last run (Linux only so far)
python demo.py                    # fixture mode, writes samples/*.json
python demo.py --live NBA-2611190100-ATL-OKC-M --outcome "Oklahoma City"
python demo.py --research         # checks the NYC gap against public sources
```

Flags for `demo.py`:
- `--analyst rules` is the default, the code-only scorer.
- `--analyst none` leaves ambiguity, source and correlation `null` for a person to score.
- `--no-terms` skips downloading the terms PDF.

### Layout

| File | Role |
| --- | --- |
| `analysis/verity/live.py` | Reads `GET /v1/prediction-markets/events/{ticker}` and reshapes it into the fixture format. `_event_terms_url` returns `termsLink`, falling back to `termsAndConditionsUrl`. `_plain_text` flattens rich-text descriptions. `analyze_live(..., analyst="rules"\|"none")` |
| `analysis/verity/rules_analyst.py` | `verity-rules-v1`: `_ambiguity`, `_source`, `_correlation` and `_gaps`. `_BANDS` ignores "between X and Y" in team names. `_LIVE_FREE_CHECKS` maps `("WXHIGH-NYC","settlement_source_version")` to `"nyc-settlement-version"`. |
| `analysis/verity/scoring.py` | `liquidity_score` and `rate`: bands plus overrides |
| `analysis/verity/proposals.py` | Purchase proposals. `_free_check_label` marks real checks OBSERVED. |
| `analysis/verity/research.py` | Free-check research (Morgan) |
| `analysis/verity/schemas.py`, `fixtures.py`, `exchange.py`, `analysis.py` | Pydantic schemas, fixture loading with `canonical_hash` (sha256 of sorted JSON), the exchange client, and the analysis flag |
| `analysis/fixtures/markets_2026-11-17.json` | Five fixture markets: OKC moneyline, NYC high 62–63°F, MSU−TENN spread, Fed Dec hike 25bps, Best AI end of 2026 |
| `analysis/fixtures/catalog_v1.json` | Merchant catalog `verity-catalog-v1`, allowlist `["verity-demo-merchant"]`, with three items (below) |
| `analysis/fixtures/free_checks.json` | Includes `observed-2026-11-18`, whose result was inconclusive |
| `analysis/samples/nyc_high_gap_remains.json`, `okc_moneyline.json` | Real analysis outputs |
| `analysis/tests/` | Tests fake the API, so no network is needed. `live_okc_event_2026-11-18.json` is a captured real event. |

Catalog items (prices in base units, 6 decimals):
- `cat-nws-cli-settlement-version-v1` costs 50000 (0.05 USDC) and answers gap type `settlement_source_version`.
- `cat-point-forecast-v1` costs 20000 (0.02 USDC) and affects outcome probability, not risk, so it is never proposed.
- `cat-lm-arena-snapshot-v1` costs 50000 (0.05 USDC) and answers `leaderboard_snapshot`.

### Scoring rubric (from the workbook `Prediction market risk analysis.xlsx`)

- There are four categories, each scored 1 to 3: ambiguity, source, liquidity and correlation.
- Totals: 4–6 is Low, 7–8 is Medium, 9–12 is High. The repo README still says 1–5; this slice uses 1–3, as agreed.
- Overrides:
  - Any 3 in Ambiguity or Source means the rating is at least Medium.
  - A 3 in Liquidity means "never trade more than top-of-book". In research terms, the price is an unreliable signal.
- Liquidity:
  - Missing quote → 3.
  - Volume under $100 → 3.
  - Spread over 5¢ → 3.
  - Volume of $1000 or more with a spread of 2¢ or less and all strikes quoted → 1.
  - Anything else → 2.

Reference results from Nov 18, 2026 (the site uses these):

| Market | Amb | Src | Liq | Corr | Total |
| --- | --- | --- | --- | --- | --- |
| Atlanta vs Oklahoma City moneyline (`NBA-2611190100-ATL-OKC-M`) | 1 | 1 | 1 ($1,392.14 traded, 1¢ spread, bid 0.69, ask 0.70) | 3 (5 siblings) | 6, Low, nothing to buy |
| NYC high 62–63°F (`WXHIGH-NYC-2611190459`) | 2 | 2 | 3 ($7 traded, 4¢ spread, bid 0.54, ask 0.58, mid 0.56) | 1 | 8, Medium, one 0.05 USDC report proposed |

The NYC gap: Rule 13.111(i)(2) of the weather terms says "only the first published version that includes confirmation of the ___ will be used." A word is missing, so it is unclear whether the partial 4 PM NWS report or the full-day report settles the market.

### Spending rules (payment side, not built in this repo)

- **Tiers:**
  - 0.01–0.10 USDC is automatic once the shared checks pass: the merchant is allowlisted, the quote is valid and the purchase is not a duplicate.
  - 0.11–0.50 USDC is automatic only for an open gap with no free or cached answer.
  - 0.51–2.00 USDC needs owner approval: Verity explains the purchase by voice (ElevenLabs), and the owner signs with their wallet.
  - Over 2.00 USDC is rejected.
- **Budget:** 25 USDC per mission, counting money already reserved.
- **Separation:** the analysis only proposes a purchase. A separate payment service holds the signer and decides.
- **Stack:** x402 and EIP-3009, with the authorization bound to a hash of the request; USDC on Arc Testnet; QuickNode Streams for on-chain records; ElevenLabs for voice.

---

## 5. Gemini Exchange public API (what the site uses)

All of these are public, need no key, and are **CORS-enabled**, so the browser can call them directly from verityresearch.us.

| Endpoint | Used for | Notes |
| --- | --- | --- |
| `GET /v1/prediction-markets/events?status=active&limit=100&offset=N` | Markets list | Returns `{data:[event], pagination:{limit,offset,total}}`. About 1,000 active events. The first page is roughly sorted by volume; page 2 is mostly zero-volume. |
| `GET /v1/prediction-markets/events/{ticker}` | One event | Same shape as one list item |
| `GET /v2/candles/{instrumentSymbol lowercased}/{tf}` | Price history | `tf` is one of `1m`, `5m`, `15m`, `30m`, `1hr`, `6hr`, `1day`. Returns `[[ms,o,h,l,c,vol],…]`, **newest first**. A contract that has never traded returns HTTP 400 `{"reason":"NoDataFound"}`. |
| `GET /v1/pricefeed` | Crypto spot | About 348 pairs: `{pair, price, percentChange24h}` |
| `GET /v2/ticker/{pair}` (for example `btcusd`) | 24-hour hourly line | `changes` holds 24 hourly closes, newest first |
| `/v1/book/...`, `/v1/trades/...` | Not usable from the browser | No CORS, so fetches fail |

Event fields used:
- `ticker`, `title`, `category` (Crypto, Sports, Weather and so on), `type` (`binary`/`categorical`)
- `volume` (total) and `volume24h`
- `expiryDate`, `termsLink`, `sourceDetails` (`{agency,index}`), `gameId` (used to match sibling events)
- `description`, a **rich-text document object, not a string**; flatten it by walking `content[].value`
- `contracts[]`

Contract fields used: `id`, `label`, `status`, `instrumentSymbol`, `expiryDate`, `termsAndConditionsUrl`, `description` (rich text) and `prices{bestBid,bestAsk,lastTradePrice,buy,sell}`.

**Outage history:** on Nov 18 the API returned HTTP 500 for hours, then recovered. Retry before assuming code is broken.

---

## 6. The live website (`index.html` in `verityresearch-live`)

### Approach

- **One self-contained HTML file** (about 166 KB, unminified), with all CSS and JavaScript inline. There is no framework and no bundler.
- **External loads:**
  - Three.js r128 from `https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js`, pinned with SRI `sha512-dLxUelApnYxpLt6K2iomGngnHO83iUvZytA3YjDUCjT0HDOHKXnVYdf3hU4JjM8uEhxf9nD1/ey98U3t2vZ0qQ==`. That hash was verified against the npm `three@0.128.0` build. CORS is required for the SRI check.
  - Google Fonts: Space Grotesk and JetBrains Mono.
- **Fallbacks:** a static SVG coin if WebGL or Three.js fails, system fonts if fonts fail, and the labelled Nov 18 snapshot if the API fails.
- **Design system:** `DESIGN.md` (owner-approved Nov 19): the "Institutional prediction terminal".
  - Tokens: `--bg-void #090C10`, `--bg-surface #10151E`, `--bg-elevated #161D29`, `--border-hairline #1E2738`, `--accent-blue #2E5CFF`, `--signal-yes #00C853`, `--signal-no #FF3B30`, `--signal-warn #F59E0B`, `--text-primary #F1F5F9`, `--text-muted #8B9BB4`.
  - Spacing, radius, focus and motion tokens are borrowed from Astryx (`meta/astryx`, `@astryxdesign/core` tokens).
  - Forbidden fonts: Inter, Roboto, Arial. Forbidden effects: purple or pink neon, glass blobs, decorative glowing networks.

### How the source is organized

Before it is built, the page is these parts, concatenated in order by `build.sh` into `dist/index.html`:

```
<head> + <style>  src/style.css
<body>            src/body.html
<script>          keccak.js → src/app1.js → src/live.js → src/ticker.js → src/app2.js → src/app3.js
```

All scripts share one scope. Top-level `const`s are in the temporal dead zone until their file runs, so **anything that calls across files must run at runtime, not at load.** That is why `LIVE.start()` is called from `init()` in `app3.js`.

If you only have `index.html`, you can edit it directly: it is the concatenation above, unminified. If you restore the split, keep the same order.

| Part | Contents |
| --- | --- |
| `keccak.js` | Compact keccak-256 (Ethereum variant), checked against vectors: `""` → `c5d24601…a470`, `"abc"` → `4e03657a…6c45`, 200×"a" multi-block |
| `app1.js` | Utilities (`$`, `$$`, `esc`, `copy` with clipboard fallback, `canon` sorted-key JSON, `sha256` via WebCrypto, seeded `rng`, `fitCanvas`); `MARKETS` (real NYC/OKC Nov 18 data); `TICKER` (snapshot fallback); nav and mobile menu; **Three.js coin**; **probability chart** (`makeSeries`, `drawProb`, `renderProb`, `gxCandles`, `CTF` timeframe map); **candles panel** (`seedCandles`, `liveCandles`, `drawCandles`, `candleSchedule`) |
| `live.js` | **`LIVE` store**: polls events pages 0 and 1 plus `/v1/pricefeed` every 15 s, `/v2/ticker` lines every 2 min, pauses in background tabs, `LIVE.on(fn)` subscribers. Helpers `lmid`, `favourite` (leading outcome, preferring traded contracts), `plain` (rich-text flatten), `closesIn`. **`analyzeLive(e,c)`**, a browser port of `verity-rules-v1` plus `liquidity_score`. `liveMarket(e,c)` builds a `MARKETS.live` entry. **Hero board** (`renderBoard`, `renderStats`, topic tabs, Crypto grid). |
| `ticker.js` | Top marquee. Subscribes to `LIVE`, picks the 18 most-traded markets (at most 9 per category), updates prices in place (green or red flash, ▲▼, session sparkline), reselects every 5 minutes, and falls back to the snapshot if the API never loaded |
| `app2.js` | Terminal scores, gauge and **risk inspector** (`renderTerm(light)`, `liveJSON`, `liveFlags`, `livePurch`, `selectLive`, `fillLiveSel`); the **six-step walkthrough** state machine (`W`, `STEPS`, `stageHTML`, policy tester, simulated voice and wallet approval, tamper demo); the **architecture SVG** synced to steps; **code tabs** (402 challenge, EIP-3009 typed data, risk JSON, QuickNode-shaped event) |
| `app3.js` | **Reconciler ledger** (six fixture events: matched, paid-not-delivered, duplicate deduplicated, Gateway delivered-not-paid, nonce replay blocked, mismatched request), filters, sort, replay, verification drawer with focus trap; `init()` |
| `body.html` | Markup for all sections (below) |
| `style.css` | Tokens, components and responsive rules (breakpoints at 1024, 760, 640, 560, 480 and 400px) |

### Page sections and what is real

| # | Section | Data |
| --- | --- | --- |
| 1 | **Ticker** (`#ticker`) | **Live** Gemini Exchange: the 18 most-traded markets, each item linking to gemini.com/predictions |
| 2 | **Hero / live board** (`#top`): a compact heading, status line, stats (active markets, 24h volume, BTC, ETH), **topic tabs** (Overview, then categories with counts), a market list (click → terminal); Crypto tab with eight spot prices and 24h lines; spinning ₿ coin on the right with caption "Editorial visual. Verity pays in USDC on Arc Testnet, not bitcoin." | **Live** |
| — | Telemetry strip | Configured values: 0.05 USDC, EIP-3009 nonce, 0.51–2.00 approval, demo reconciliation |
| 3 | **Market terminal** (`#terminal`): a market switch (`Live: …` plus a dropdown of the top 40 live markets, and the two Nov 18 analyses); probability chart with 1H/24H/7D/30D/ALL; resolution-risk gauge (4–12, never on the probability axis); microstructure candles; risk inspector JSON, flags and purchase proposals | **Live** markets: real v2 candles (1H=1m×60, 24H=15m×96, 7D=1hr×168, 30D=6hr×120, ALL=1day), real 5m candles, live top of book, browser-port rules. **NYC/OKC**: the real Nov 18 analysis with demo-fixture price paths, labelled. |
| 4 | **Walkthrough** (`#walkthrough`): six steps from contract to audit, with keccak request hash computed in the browser, tamper demo (KNYC→KLGA, merchant rejects), policy tester with simulated voice approval and wallet signature, settlement vs delivery chain, audit report | **Simulated**, labelled. No payment service exists to read from. |
| 5 | **Architecture** (`#stack`, `#modules`, `#spec`): four-layer matrix (Brain = Gemini Exchange API plus verity-rules-v1, not an LLM), four modules, code tabs | Spec and pseudocode, labelled |
| 6 | **Reconciler** (`#reconciler`) | **Demo fixture** ledger; hashes computed from fixtures; transaction refs are `demo-tx-…`, never fake hex |
| 7 | Footer | Real links only (GitHub, Gemini API, NYC terms PDF); unavailable items say so |

### AI second opinion (Google Gemini): `src/gemini.js`, panel `#gaiPanel` in the terminal

- **Key handling:**
  - The visitor pastes a Google Gemini API key into a password field, then clicks **Connect**. This calls `GET https://generativelanguage.googleapis.com/v1beta/models` to validate the key and list models.
  - The models offered are those that support `generateContent`, with Flash preferred by default.
  - The key is kept in memory. It is stored in this browser's `localStorage` (key `verity.googleGeminiKey`) only if the visitor ticks "Remember on this device".
  - **Remove key** clears it from memory and storage.
  - The key is sent only in the `x-goog-api-key` header, never in a URL, and never to any Verity server (there isn't one).
- **Review this market's settlement rules:**
  - Sends the selected market's data, rules text and the `verity-rules-v1` scores to `POST /v1beta/{model}:generateContent`.
  - Uses a system instruction (resolution risk only, no trading or outcome predictions, stick to the given text) and structured JSON output: summary, settlement source, ambiguities with quotes, scores for ambiguity/source/correlation, whether it agrees with the rules analyst, suggested research, and confidence.
  - Renders a side-by-side table: rules analyst vs Google Gemini.
- **Ask a question:** free-text Q&A grounded in the same market data, rendered as escaped light markdown.
- **Errors handled:** invalid key (400), referrer-restricted or forbidden (403), quota (429), unknown model (404), blocked or empty responses.
- **Advice to the owner:** restrict the key in Google Cloud to HTTP referrer `https://verityresearch.us/*`.

### Browser rules port: known differences from Python

- The terms PDF is never read in the browser, so ambiguity is at least 2 and the reason says so.
- Siblings are matched by shared `gameId`. Python used `event.events`, which the current API does not return.
- A settlement source that matches no rule scores `null` and the rating shows **Incomplete**. This is the same behaviour as Python. Crypto markets usually land here.
- Purchases map gap types to catalog v1. Only NWS weather gaps map to `cat-nws-cli-settlement-version-v1`; others show "Unsupported by catalog". A proposal is never a payment.

### Coin

- `CylinderGeometry(1.5,1.5,.2,96)` with canvas face and bump textures: brushed gold, grooves, a vector ₿ drawn as a path (not a font glyph), and "KECCAK-256 · SHA-256 · EIP-3009 · NONCE…" micro-engraving.
- The milled edge comes from a stripe bump and roughness map.
- The face texture is rotated `π/2` so the ₿ is upright. The back face uses a mirrored clone, rotated `-π/2`.
- Lights: warm key, blue rim, emerald point, plus a PMREM environment built from emissive panels.
- Motion: continuous Y spin at 1.9 rad/s, with pointer tilt and parallax. A click adds speed, which damps back down. The coin stops when offscreen (IntersectionObserver) and stays still under reduced motion.
- The orbit dots were removed at the owner's request.

---

## 6b. Added overnight (Nov 19–20)

- **Live market board** (hero): active-market count, 24h volume, BTC/ETH spot; topic tabs built from live categories; Crypto tab with eight spot prices and 24h lines.
- **Live terminal:** real Gemini Exchange v2 candles for every timeframe; real 5-minute candles; a market details and outcomes panel (every outcome, switchable); a note when a contract barely trades; the Terminal link re-anchors after live data loads.
- **Crypto news** beside a 190 px coin: publisher RSS (CoinDesk, Cointelegraph, Decrypt, The Block) via the Worker's `/news`, with photos; Hacker News crypto stories as the labelled fallback. Below it, **Exa research** search (`/research`).
- **AI panel** (`src/gemini.js`): a side tab that follows the page. It can be dragged out into a floating window and resized from every edge or corner; position and size are remembered.
  - **Review and Ask:** Google Gemini, falling back to Workers AI (Llama 3.3 70B), with the answering model labelled.
  - **Forecast:** Google Gemini and Workers AI each estimate P(Yes) from real price history plus Exa research. The page averages them, compares with the market price and draws a dashed line on the chart. It is labelled experimental and not trading advice.
  - **Research this market:** Exa coverage from the last 30 days.
- **Google Gemini status:** model `gemini-2.5-flash` returned 404 (retired), and the next model timed out with thinking on. Worker v7 picks a current model, turns thinking down and tries the next model on a timeout. Check `GET /status` after a deploy.

## 7. Build, test, publish

```bash
# build (from the folder containing build.sh, src/, keccak.js)
sh build.sh                      # writes dist/index.html

# quick syntax check of the inline script
sed -n '/^<script>$/,/^<\/script>$/p' dist/index.html | sed '1d;$d' > /tmp/page.js && node --check /tmp/page.js

# publish (owner approval required)
git clone https://github.com/ryanmarklin-arch/verityresearch-live
cp dist/index.html verityresearch-live/index.html      # keep CNAME and .nojekyll
cd verityresearch-live && git commit -am "..." && git push origin main
```

**Safe preview:** push the build as `preview.html` to `verityresearch-live`, test it at https://verityresearch.us/preview.html, then copy it to `index.html` and delete `preview.html`. Live API calls only work from a real HTTPS origin or localhost, not from a sandbox with no network.

**Checks done so far:**
- Overflow checked at 360, 375, 390, 430, 768, 1024, 1440 and 1920px. No page-level horizontal scroll; the ledger, code and diagram scroll inside their own panels.
- Interaction flows tested: walkthrough, tamper, approval, filters, drawer (Escape and focus trap), tabs (arrow keys) and reduced motion.
- The WebGL fallback was tested.
- Live data, candles and the board were verified in a real browser on verityresearch.us.
- **Lighthouse has not been run.** Do not claim scores.

For headless tests, serve the HTML with request interception and answer the cdnjs request with `three.min.js` plus an `access-control-allow-origin: *` header. Without that header the SRI check fails and the coin falls back.

**Commit trailer used so far:**
```
Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
```

---

## 8. Other tools and accounts

- **Figma:** the connected account `ryantheawesome` (ryanmarklin@gmail.com) has a **View** seat on the Starter team `team::1515062467968547738`, so it can't create files. The owner wants to use a school account instead. Nothing has been pushed to Figma.
- **Emergent:** a parallel build of an older version, job `5c518cb5-a60b-4b0f-a554-e4b7f575f0c5`. Not deployed; probably obsolete.
- **Lovable:** superseded and out of credits.
- **Playwright** is available as a local MCP on the owner's machine.
- **Skill:** `npx skills add emilkowalski/skill` was installed only in an old sandbox.

---

## 9. Open tasks

- [x] **Sync the team repo** (done Nov 20, 1:35 AM ET: `site/` and `worker/`). Earlier notes on this task:
  - **Files:** `src/live.js` and `src/ticker.js` (both new), plus updated `src/app1.js`, `src/app2.js`, `src/app3.js`, `src/body.html`, `src/style.css`, `build.sh` and `dist/index.html`.
  - **If you only have `index.html`:** put it in `site/dist/` and note in the README that the split parts are stale. Alternatively, re-split it along the boundaries in section 6.
  - **README:** update `site/README.md` to say the ticker, board and terminal are live.
- [ ] **Deploy Worker v7 and confirm** `GET /status` shows `chosen_model` and `last_call.outcome: "ok"`, so Google Gemini, not the backup, answers.
- [ ] **Run Lighthouse** (performance, accessibility, best practices, SEO) and the axe accessibility checks; fix any failures. Watch the 166 KB inline script and the font loading.
- [ ] **Run the analysis tests on Windows.** They have only been verified on Linux.
- [ ] **Optional:** push the page into Figma as editable layers. This needs an Editor seat, or the owner's school account connected.
- [ ] **Optional:** delete the `team-export3` branch in `ryanmarklin-arch/verityresearch-site`, and the old Emergent job.
- [ ] **When a real payment service exists:**
  - Replace the walkthrough and ledger fixtures with its authorized endpoints, read-only from the site.
  - Show the source and freshness of the data.
  - Distinguish a connection failure from zero activity.
  - Never expose a signer.
  - Keep Gateway batch receipts separate from individual transfer attribution.
- [ ] **Possible improvements:**
  - Fetch more than the first 200 events, by category, so rarer topics such as Economics and Politics get tabs.
  - Port the terms-PDF read. The browser can't fetch the PDF with CORS, so this would need a small proxy, with owner approval.
  - Add search to the board.

---

## 10. Quick facts cheat sheet

- **Analysed markets:** NYC `WXHIGH-NYC-2611190459` (mid 0.56, risk 8 Medium) and OKC `NBA-2611190100-ATL-OKC-M` (mid 0.695, risk 6 Low).
- **NYC research item:** `cat-nws-cli-settlement-version-v1`, 0.05 USDC.
- **Demo canonical request** (sorted-key JSON, no whitespace) hashes with keccak-256 to `0x273c46bbd05da2e9ff056f2aa8b12beb57c33baeb0f8d221a2d96b74bcf60038`. The tampered KLGA version hashes to `0x988ab306…92ba`.
- **Tiers:** 0.10 / 0.50 / 2.00 USDC. Budget 25 USDC.
- **Live poll interval:** 15 s (events and price feed), 2 min (crypto 24h lines), 30 s (terminal 5m candles when visible).
