# Verity: project notes for Claude Code

Verity is a UBC 2026 hackathon prototype. It is a research agent for prediction markets: it reads how a market settles, scores the risk, and buys only the evidence that closes a gap. Every purchase stays inside the owner's spending rules. It places no trades, and payments run on testnet USDC.

The work lives in two places:

1. **The analysis code** is in the private repo `ubc-2026/verity`, on branch `analysis-fixture-slice`.
2. **The website** is served at verityresearch.us. Its source is on `main` in the public repo `ryanmarklin-arch/verityresearch-site`, and a GitHub Action publishes every push.

## Rules for working here

- **Gemini means Gemini Exchange,** the prediction-market exchange at api.gemini.com. It never means Google Gemini, the AI model. Do not add Google Gemini, Google AI SDKs or a `GEMINI_API_KEY` for an LLM anywhere.
- The analysis uses no LLM. Scoring is code rules in `verity/rules_analyst.py`.
- **Never put secrets in chat, code or commits.** An API key leaked in an earlier chat, so rotate any key that was ever pasted into one. Gemini Exchange keys go only in Codespaces secrets or a local `.env` that git ignores. Never give a key the Fund Manager role.
- Reading public market data needs no key.
- Passwords, wallet approvals and promo codes are entered by the owner, never by the agent.

## 1. Analysis code (`ubc-2026/verity`)

- **Branch:** `analysis-fixture-slice`, which is the owner's (Ryan's) work. Its head when these notes were written was `3594cb5a3ba8ab889d63744370de37231c658331`.
- **Morgan's branch** `morgan-lin-analysis` was merged into this branch. The merge commit on her branch is `e940e94`.
- **GitHub access:** the Claude GitHub app has no access to the `ubc-2026` org. Clone it with your own git credentials, or use Codespaces once the org enables them.

### Run it

```bash
cd analysis
python -m venv .venv
.venv\Scripts\activate            # macOS/Linux: . .venv/bin/activate
pip install -r requirements.txt   # add requirements-live.txt for live mode
python -m pytest -q               # 49 passed at last run
python demo.py                    # fixture mode, writes samples/*.json
python demo.py --live NBA-2611190100-ATL-OKC-M --outcome "Oklahoma City"
python demo.py --research         # checks the NYC gap against public sources
```

Flags for `demo.py`:

- `--analyst rules` is the default. It is the code-only scorer.
- `--analyst none` leaves ambiguity, source and correlation `null` for a person to score.
- `--no-terms` skips downloading the terms PDF.

### Layout

| File | What it does |
| --- | --- |
| `analysis/verity/live.py` | Reads the public event endpoint and reshapes it into the fixture format. `_event_terms_url(event)` returns `termsLink`, falling back to `termsAndConditionsUrl`. Morgan's `_plain_text` flattens rich-text descriptions. `analyze_live(..., analyst="rules"\|"none")`; any other value raises `ValueError`. |
| `analysis/verity/rules_analyst.py` | Framework scoring through `_ambiguity`, `_source`, `_correlation` and `_gaps`, with `ANALYST_ID = "verity-rules-v1"`. `_BANDS` ignores "between X and Y" when it joins team names. `_LIVE_FREE_CHECKS` maps `("WXHIGH-NYC", "settlement_source_version")` to `"nyc-settlement-version"`. |
| `analysis/verity/analysis.py` | Adds the flag `analyst=verity-rules-v1 (code rules, no LLM)`. |
| `analysis/verity/proposals.py` | `_free_check_label` gives real, non-fixture checks an OBSERVED label. |
| `analysis/verity/research.py` | Morgan's free-check research, for example `nyc-settlement-version`. |
| `analysis/verity/scoring.py`, `schemas.py`, `fixtures.py`, `exchange.py` | Scoring math, pydantic schemas, fixture loading and the exchange client. |
| `analysis/fixtures/markets_2026-11-17.json` | Five fixture markets. The NYC entry has C-NYC-4 and C-NYC-5. |
| `analysis/fixtures/free_checks.json` | Includes the `observed-2026-11-18` scenario, whose result is inconclusive. |
| `analysis/tests/` | `test_live.py` includes real-OKC tests that read `live_okc_event_2026-11-18.json`. Tests fake the API, so they need no network. |

### Scoring rubric

This comes from the workbook `Prediction market risk analysis.xlsx`.

- Four categories, each scored 1 to 3: ambiguity, source, liquidity and correlation.
- Totals: 4 to 6 is Low, 7 to 8 is Medium, 9 to 12 is High.
- The repo-level README still says 1 to 5. This slice uses 1 to 3, as agreed.

Liquidity is computed in code from the bid, the ask and the volume.

Reference results from Nov 18, 2026:

| Market | Ambiguity | Source | Liquidity | Correlation | Total |
| --- | --- | --- | --- | --- | --- |
| Atlanta vs Oklahoma City, moneyline | 1 | 1 | 1 ($1,392 traded, 1¢ spread) | 3 | 6, Low, nothing to buy |
| NYC high temperature, 62 to 63°F | 2 | 2 | 3 ($7 traded, 4¢ spread) | 1 | 8, Medium, one 0.05 USDC report proposed |

The NYC mid price was 0.56. Its gap: the rule says "only the first published version that includes confirmation of the ___ will be used." A word is missing, so it is unclear which NWS report counts: the partial 4 PM report or the full-day one.

### Gemini Exchange API notes

- **Endpoint:** `GET https://api.gemini.com/v1/prediction-markets/events/{ticker}`. It is public and needs no key.
- **Outage:** on Nov 18 it returned HTTP 500 for hours, then recovered. Retry before assuming the code is broken.
- **`description`:** a contract's `description` is a rich-text document object, not a string. Flatten it with `_plain_text`.
- **Terms link:** the event-level terms link is `termsLink`, not `termsAndConditionsUrl`.

### Spending rules (the payment side)

- **Tiers:**
  - 0.01 to 0.10 USDC is automatic once the shared checks pass: the merchant is allowlisted, the quote is valid and the purchase is not a duplicate.
  - 0.11 to 0.50 USDC is automatic only for an open gap with no free or cached answer.
  - 0.51 to 2.00 USDC needs owner approval: Verity explains the purchase by voice (ElevenLabs), and the owner signs with their wallet.
  - Over 2.00 USDC is rejected.
- **Budget:** a 25 USDC mission budget, which counts money already reserved.
- **Separation:** the analysis only proposes a purchase. A separate payment service holds the signer and decides.

Stack: x402 and EIP-3009, where the authorization is bound to a hash of the request; USDC on Arc Testnet; QuickNode Streams for on-chain payment records; ElevenLabs.

## 2. Website (verityresearch.us)

### Where things are

- **Domain:** `verityresearch.us` is registered at **Porkbun**, not GoDaddy, on account RyanLion.
- **Hosting:** GitHub Pages, built by GitHub Actions from `main` of `ryanmarklin-arch/verityresearch-site` (`.github/workflows/deploy.yml`). The custom domain is set in Settings > Pages and in `public/CNAME`.
- **Source:** `main` of the same repo. The old `source` branch is the history from before Nov 19 and is no longer used.
- **DNS at Porkbun:**
  - Four A records on the root domain: 185.199.108.153, 185.199.109.153, 185.199.110.153 and 185.199.111.153.
  - `www` CNAME to `ryanmarklin-arch.github.io`.
  - A leftover wildcard `*` CNAME to `pixie.porkbun.com` was kept. It does not affect the site.
- **HTTPS:** enforced.

### Stack

- **Build:** Vite 8 + React 19 + TypeScript. `vite-plugin-singlefile` inlines everything into one `dist/index.html`, and `base: './'`.
- **Animation:** GSAP 3.15 with ScrollTrigger, SplitText and matchMedia, plus `@gsap/react` (`useGSAP`). three.js draws the hero coin.
- **React Bits** (github.com/DavidHDev/react-bits): `Magnet.tsx` is used; the others in `src/bits/` are kept for later.
- **Design:** an original "on-chain certificate" concept (Nov 19, 2026). Black stock and gold leaf, laid out on a strict ruled grid.
  - Type: Archivo at an expanded width (`--display-stretch: 118%`) for heads, like banknote lettering; IBM Plex Sans for reading; IBM Plex Mono for serial-style labels.
  - Engraving: `Guilloche` draws banknote-style rosettes in gold hairlines (hero and closing); they draw themselves in and turn slowly. `Microprint` runs tiny repeated text in the certificate and footer.
  - Scores are struck as hallmarks (stamp-like tiles with 1 to 3 pips), and the process is a ledger of five linked diamond blocks with a packet running the chain.
  - Sections are numbered I to V with a gold rule, because they are read in order.
  - All tokens are in `src/tokens.css`; `src/base.css` is the reset.

### Commands

```bash
npm install
npm run dev          # local dev server
npm run build        # writes dist/index.html
```

This copy lives in `site/` of the team repo `ubc-2026/verity`. The live site deploys from `ryanmarklin-arch/verityresearch-site`, so copy changes there to publish. `README.md` is the short guide for other editors.

### Files

- **`src/App.tsx`:** the page.
  1. **Hero:** eyebrow, headline "Read the rules, then trust the price.", lead, two buttons, the 3D coin on the right over a guilloche rosette, and a certificate strip of four cells (market, 56¢ price, 8 of 12 risk, 0.05 USDC proposed).
  2. **I, `#reading`:** the NYC settlement clause on a certificate card (highlight sweep, dashed gap for the missing word, margin note, microprint), beside four hallmark tiles and a total stamp of 8/12, Medium.
  3. **II, `#how`:** the ledger: five linked blocks (Read, Score, Find the gap, Pay, Reconcile). Vertical below 64rem.
  4. **III, `#markets`:** a ruled comparison table of OKC and NYC with pips, reasons and totals.
  5. **IV, `#spending`:** the vault: an amount slider on a scale coloured by tier, the verdict, four tier cards and the 25 USDC budget bar.
  6. **V, `#stack`:** five ruled tiles, then the closing line over a second rosette, then the footer.
- **`src/Coin3D.tsx`:** the hero coin in WebGL (three.js), faces painted on canvas in Archivo and IBM Plex. Float, auto-turn, pointer tilt, click to flip. Falls back to `Coin.tsx` without WebGL.
- **`src/Tilt.tsx`:** pointer tilt with a glare. Not used by the current page.
- **`src/three/color.ts`:** resolves CSS tokens to three.js colours.
- **`src/site.css`:** all page styles.

### Design guardrails

- Colours and fonts come from `src/tokens.css`. Never `transition: all`. Animate `transform` and `opacity` where you can.
- Every animation needs a `prefers-reduced-motion` fallback. GSAP effects sit inside `gsap.matchMedia('(prefers-reduced-motion: no-preference)')`.
- Text is in sentence case with proper capitals (NYC, NWS, USDC, Gemini Exchange); nothing is forced to lowercase.
- About 80 words per screen at most.
- The hero's headline, lead and buttons must fit at 1280x800.
- Never invent metrics, quotes or logos. Every number on the page comes from the real Nov 18 analysis above.
- The design is original. Don't copy another site's copy, logos, images or brand.

## 3. Other tools

- **Emergent:** a parallel build of the same site was started. Its job id is `5c518cb5-a60b-4b0f-a554-e4b7f575f0c5`, at `https://app.emergent.sh/home?job_id=5c518cb5-a60b-4b0f-a554-e4b7f575f0c5`. Its answers: a CSS coin, no audio, buttons that smooth-scroll to sections, and the brief's text verbatim. It is not deployed. Compare it with the live site before replacing anything.
- **Figma:** account `ryantheawesome`, team plan `team::1515062467968547738`. The seat is View, so creating files may fail. Nothing has been pushed to Figma yet.
- **Playwright** is available as a local MCP on the owner's machine. Use it to screenshot the live site.
- **Skill:** `emilkowalski/skill` was installed only in the old sandbox. Reinstall it locally with `npx skills add emilkowalski/skill`.

## Open tasks

- [x] Enforce HTTPS on GitHub Pages. Done Nov 19; https://verityresearch.us loads.
- [x] Commit the website source to a repo. It is on `main` of `ryanmarklin-arch/verityresearch-site`. An older copy is in `morganxlin/ubc-2026` under `site/`.
- [x] Remove the unused Astryx and StyleX dependencies and the `old/` folder.
- [ ] Review the Emergent build and decide whether to keep or replace any of it.
- [ ] Optionally push the page into Figma as editable layers. This needs an Editor seat.
- [ ] Run the analysis tests on Windows. They have only been verified on Linux.
