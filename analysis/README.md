# Verity analysis: risk scoring and evidence proposals

Market fixture → `get_risk_analysis()` → `generate_purchase_request()` → an unsigned proposal, or `null` with a logged reason.
Fixture mode (the default) uses no network, no API key and no wallet. Live mode is optional and is described below.

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
- Ambiguity, source, and correlation stay `null` on a live snapshot. The exchange sends the contract text. It does not score how the contract settles, and this code does not invent those scores.
- Liquidity is computed in code from the bid, the ask, and the volume.
- `analyze_live()` returns the analysis and its context. Pass both to `generate_purchase_request()`.
- The output is written to `samples/live_last_run.json`, which git ignores.
- **Purchases stay blocked on a live market snapshot.** That snapshot has no evidence gaps. The New York fixture gap can be checked against the public terms PDF and the NWS Central Park report with `python demo.py --research`. A document that cannot be read does not become a purchase. The labeled fixture scenarios are unchanged.
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
tests/test_slice.py, tests/test_live.py (both APIs faked)
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

- **NYC free check:** both outcomes are FIXTURE ASSUMPTIONS. Read the weather terms PDF and the NWS CLINYC product, then record the real result. That PDF's URL is inferred, because the event-level `termsAndConditionsUrl` was empty.
- **Snapshot time:** the workbook stores only the date (2026-11-17). Live reads should store the UTC time.
- **Instrument symbols** are missing in the OKC and NYC fixtures. Live mode records them.
- **Field names:** `verity/live.py` reads the public event payload. Contract descriptions may arrive as a document tree; the loader flattens those to plain text.
- **Tickers** are missing for the Fed and Best AI rows, which came from CoinRithm rather than Gemini. They are flagged, and purchases for them are blocked.
- **Rules text** is a paraphrase of the API descriptions. Fetch the terms PDFs so citations quote the actual rules.
- **Expiry:** every fixture market expires between Nov 19 and Jan 1. After that, keep the fixture clock or take a new snapshot.
- **Reading scores:** a live snapshot does not assign ambiguity, source, or correlation. Fixture files still carry the workbook scores for those three.
- **Free checks in live mode:** to let a live gap lead to a purchase, add a free-check source for each type of gap (for example, read the terms PDF for the settlement rule).
