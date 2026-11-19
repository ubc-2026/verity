# Verity analysis: risk scoring and evidence proposals

Market fixture → `get_risk_analysis()` → `generate_purchase_request()` → an unsigned proposal, or `null` with a logged reason.
Fixture mode (the default) uses no network, no API key and no wallet. Live mode is optional and is described below. Neither mode uses an LLM.

## Run it

```bash
cd analysis
python3 -m venv .venv && . .venv/bin/activate      # Windows: .venv\Scripts\activate
pip install -r requirements.txt
python -m pytest -q
python demo.py             # 3 runs; writes samples/*.json
```

These commands were verified on Linux from a clean virtualenv (Python 3.13, pydantic 2.13), with both `requirements.txt` and `requirements-live.txt`. They have not been run on Windows yet. The tests fake the exchange API, so they need no network and no key.

## Live mode

This reads a real Gemini Exchange market. It needs no API key. It still places no trades and signs nothing.

```bash
pip install -r requirements-live.txt
python demo.py --live NBA-2611190100-ATL-OKC-M --outcome "Oklahoma City"
```

- `verity/live.py` reads `GET /v1/prediction-markets/events/{ticker}`, which is public. It records the real snapshot time and instrument symbol, downloads the terms PDF (add `--no-terms` to skip it), and reshapes everything into the fixture format.
- **The analyst is `verity/rules_analyst.py`.** It scores ambiguity, source, and correlation from the contract text, the settlement source, and the sibling events, using the Framework rules in the table under *Live rules*. It has no LLM and needs no key. Every score cites the excerpt ids it used. When a rule can't be applied (no rule text, or a settlement source the rules don't recognize), that score stays `null` with a reason instead of being guessed. Pass `--analyst none` (or `analyze_live(..., analyst="none")`) to leave all three `null` for a person to read instead.
- Liquidity is computed in code from the bid, the ask, and the volume.
- `analyze_live()` returns the analysis and its context. Pass both to `generate_purchase_request()`.
- The output is written to `samples/live_last_run.json`, which git ignores.
- **Evidence gaps on live markets** come from the rules analyst. A live NYC weather gap is wired to the `nyc-settlement-version` free check in `research.py`; other live gaps have no free check yet, so they are logged and skipped, and no purchase is proposed. The New York fixture gap can be checked against the public terms PDF and the NWS Central Park report with `python demo.py --research`. A document that cannot be read does not become a purchase. The labeled fixture scenarios are unchanged.
- **A model can answer any gap** when `FixtureContext.complete_json` is set. That function is `complete_json(system, user, schema) -> dict`. The model may quote only text that was gathered. A quote or URL it was not given makes the result `failed`, and a failure does not propose a purchase. No model provider or API key is wired in. A fixture scenario still takes priority.

The fixtures were checked against `Prediction market risk analysis.xlsx`, which has the same five rows, the same rubric and overrides, and the same 11 agent rules. The repo-level README still describes a 1–5 scale. This slice uses the workbook's 1–3 scale, as agreed for the prototype.

## Layout

```
verity/
  schemas.py     RiskAnalysisV1, PurchaseProposalV1 (pydantic, extra fields forbidden)
  scoring.py     workbook 1-3 rubric, 4-12 bands, overrides kept separate, liquidity computed in code
  analysis.py    get_risk_analysis(contract_id, ctx=None)
  proposals.py   generate_purchase_request(risk_analysis, ctx=None, decision_log=None)
  research.py    NYC document check, and one injected model call per gap
  fixtures.py    loader, FixedClock (2026-11-18T01:00:00Z = Nov 17, 8pm ET), snapshot hash
  live.py        Gemini Exchange read + terms PDF -> fixture-shaped record; analyze_live()
fixtures/
  markets_2026-11-17.json   the 5 workbook rows, with source, snapshot date, ticker status
  catalog_v1.json           allowlisted evidence items (NWS settlement-version item at 50000 base units)
  free_checks.json          free official-source checks; NYC outcomes are labeled assumptions
tests/test_slice.py, test_live.py, test_exchange.py (all external APIs faked)
demo.py
samples/                    generated outputs (OKC, NYC gap-remains)
```

## Scoring decisions

- **Scale:** the workbook's 1–3 per category, summed to 4–12. Low is 4–6, Medium 7–8, High 9–12. The README's 1–5 scale is not used in this prototype.
- **Overrides** are applied after the raw band and reported separately (`raw_rating`, `rating_floor`, `final_rating`).
  - A 3 in Ambiguity or Source sets a floor of Medium.
  - A 3 in Liquidity is a trading rule, so it becomes a note ("the price is an unreliable signal") and does not change the rating.
- **Null** scores carry a reason. With any null, the rating is `complete: false` and `final_rating: null`, and the output shows the `possible_range`.
- **Ambiguity, source, and correlation** follow `READING_RUBRIC` in `verity/scoring.py`. Fixture files store those three scores. A live snapshot leaves them null. An empty terms link is at least ambiguity 2. No named settlement source is a null source score, not a guess. Correlation measures overlap between contracts. Sibling buckets of the same question stay 1. A wording conflict with the source is a snapshot flag, not a second score.
- **Liquidity** is computed from the quotes. Volume under $100, a spread over 5¢, or a missing bid or ask is 3. Volume of at least $1,000, a spread of at most 2¢, and a bid on every strike is 1. Anything else with two prices is 2. No data at all is null. Both prices with no volume is null. `total` and `24h` volume are labeled and are not converted.
- **Research actions:** Low → `no_further_research`, Medium → `investigate`, High → `flag_for_human_review`. This replaces the workbook's trading verbs.

## Live rules (`rules_analyst.py`)

| Category | 3 | 2 | 1 | null |
|---|---|---|---|---|
| Ambiguity | rules mention a setting, ranking or judgment ("style control", "top-ranked", "at its discretion") | terms PDF not read, event terms link empty (Agent rule 3), or numeric band edges decide it | terms read, objective outcome | no rule text |
| Source | leaderboard, LM Arena, social metrics | NWS / climate report, BLS, CPI, GDP, anything preliminary or revisable | league, NCAA, Federal Reserve, official result | no source, or one the rules don't recognize |
| Correlation | sibling events on the same underlying (Agent rule 7) | scheduled data or news (CPI, jobs, FOMC, injuries, earnings) | neither | — |

Evidence gaps: a Source 2 adds a material `settlement_source_version` gap; a Source 3 (or Ambiguity 3 on a leaderboard) adds a `leaderboard_snapshot` gap. On a `WXHIGH-NYC` market the settlement-version gap uses the `nyc-settlement-version` free check; on `WXHIGH-CHI` it uses `chi-midway-settlement-version` (Midway CLI). Live WXHIGH events often omit `termsLink`; `analyze_live` falls back to the shared weather terms PDF so free research can run. `analyze_live` sets `live_research=True` so inconclusive free reads can emit an unsigned catalog proposal (Midway prefers `cat-midway-vs-title-station-pack-v1`).

On the real OKC moneyline response (2026-11-18) with the terms read, the rules give Ambiguity 1, Source 1, Liquidity 1, Correlation 3 (5 sibling events): raw total 6 (Low), floor High from Correlation 3, final High, `flag_for_human_review`. The workbook scored Correlation 1.

## Proposal gates

1. The ticker must be confirmed.
2. The market must be at least 1 hour from expiry on the fixture clock.
3. For each material gap that affects **resolution** risk:
   - skip it if cached evidence exists;
   - otherwise run the free official-source check;
   - if the gap is still open, look for an allowlisted catalog item that answers that gap type.

Forecast gaps (outcome probability) are logged and skipped. When the free check has no result for the chosen scenario, there is no purchase, because the gap can't be validated.

## Conflicts found in the workbook

1. The README uses a 1–5 scale; the workbook uses 1–3. Resolved in favor of 1–3.
2. The `Markets!B` rating formula ignores the overrides, and `SUM` counts a blank as 0, so incomplete rows silently show Low.
3. The Volume column mixes event totals (rows 2–4, from the Gemini API) with 24-hour figures (rows 5–6, from CoinRithm). Agent rule 4 assumes 24-hour volume.
4. The Ambiguity/Source floor only changes anything at a raw total of 6. The same override also says "Always buy evidence on the settlement rule before acting", which a research-only agent can't do unconditionally. Here it is a floor plus a note, and any purchase still has to pass the proposal gates.
5. The Liquidity override is about trading, which Verity doesn't do.
6. Row 2 (OKC) scores Correlation 1 but cites injury news, which the Framework places at 2. It stays Low either way.
7. Row 4 (MSU) is rated Medium but its action is "Proceed, small size". The Framework's default for Medium is "Investigate first".
8. Row 6 (Best AI) scores Source 2, but the Framework describes LM Arena as a 3.

All five rows reproduce the workbook's totals.

## What still needs live data

- **Live OKC result (2026-11-18, terms not read):** Ambiguity 2, Source 1, Liquidity 1 ($1,392 volume, 1¢ spread), Correlation 3, raw total 7 (Medium), floor High, final High, `flag_for_human_review`, no purchase (no material gap). The live event has 5 sibling events (spread, totals, 3 player props), so Correlation is 3, not the workbook's 1. With the terms PDF read (`pypdf`), Ambiguity drops to 1 and the raw total to 6; Correlation 3 still floors final to High.
- **NYC free check:** done on 2026-11-18 as scenario `observed-2026-11-18` in `free_checks.json`, which the demo now uses. Rule 13.111(i)(2) settles on the first published version that confirms the value, so later corrections don't count. The rule text is missing a word, though, and NWS publishes a same-day partial CLINYC (valid to 4 PM) before the full-day report, so whether that partial report counts is still unstated. The result is `inconclusive` and the 0.05 USDC proposal still stands, now labeled `OBSERVED`. The two `free-check-*` scenarios remain as labeled fixture assumptions. The terms PDF URL was inferred but resolves.
- **NYC expiry:** the terms set expiry at the first 11:00 PM ET after the data are available. That is later than the fixture's `2026-11-19T04:59:00Z` from the API, which is probably the trading close. Confirm against a live response.
- **Snapshot time:** the workbook stores only the date (2026-11-17). Live reads should store the UTC time.
- **Instrument symbols** are missing in the OKC and NYC fixtures. Live mode records them.
- **Field names:** `verity/live.py` reads the public event payload. Contract descriptions may arrive as a document tree; the loader flattens those to plain text.
- **Tickers** are missing for the Fed and Best AI rows, which came from CoinRithm rather than Gemini. They are flagged, and purchases for them are blocked.
- **Rules text** is a paraphrase of the API descriptions, except NYC, which now cites the real terms (`C-NYC-4`, `C-NYC-5`). Fetch the OKC and MSU terms PDFs the same way.
- **Expiry:** every fixture market expires between Nov 19 and Jan 1. After that, keep the fixture clock or take a new snapshot.
- **Reading scores:** on live markets they come from `rules_analyst.py`. Check its scores against the workbook on a few more real markets. Fixture files still carry the workbook scores.
- **Free checks in live mode:** to let a live gap lead to a purchase, add a free-check source for each type of gap (for example, read the terms PDF for the settlement rule).
