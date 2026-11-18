# Verity analysis: risk scoring and evidence proposals

Market fixture → `get_risk_analysis()` → `generate_purchase_request()` → an unsigned proposal, or `null` with a logged reason.
Fixture mode (the default) uses no network, no API key and no wallet. Live mode is optional and is described below.

## Run it

```bash
cd analysis
python3 -m venv .venv && . .venv/bin/activate      # Windows: .venv\Scripts\activate
pip install -r requirements.txt
python -m pytest -q        # 41 passed
python demo.py             # 3 runs; writes samples/*.json
```

These commands were verified on Linux from a clean virtualenv (Python 3.13, pydantic 2.13), with both `requirements.txt` and `requirements-live.txt`. They have not been run on Windows yet. The tests fake both APIs, so they need no network and no key.

## Live mode

This reads a real Gemini Exchange market and has Google Gemini score it. It still places no trades and signs nothing.

```bash
pip install -r requirements-live.txt
export GEMINI_API_KEY=...            # Windows PowerShell: $env:GEMINI_API_KEY="..."
export VERITY_GEMINI_MODEL=...       # model id from Google AI Studio
python demo.py --live NBA-2611190100-ATL-OKC-M --outcome "Oklahoma City"
```

- `verity/live.py` reads `GET /v1/prediction-markets/events/{ticker}`, which is public and needs no key. It records the real snapshot time and instrument symbol, downloads the terms PDF (add `--no-terms` to skip it), and reshapes everything into the fixture format.
- `verity/llm.py` calls Google Gemini with structured output (`response_schema`, temperature 0).
  - The model scores only ambiguity, source and correlation, and names any evidence gaps. Liquidity stays computed in code.
  - Its output is checked before use. A score outside 1–3 becomes `null` with a reason, citations to excerpts that don't exist are dropped, and a forecast question can never count as material. Each of these fixes is flagged in the output.
- `analyze_live()` returns the analysis and its context. Pass both to `generate_purchase_request()`.
- The output is written to `samples/live_last_run.json`, which git ignores.
- **Key handling:** whoever pays for the Google Gemini API sets `GEMINI_API_KEY` in their own shell. The code does not read a `.env` file, and `.env` is gitignored. Never commit the key or paste it anywhere.
- **Purchases stay blocked in live mode.** The free official-source checks are only wired up for fixtures so far. A live gap with no free check is logged and skipped.

## Exchange actions (guarded)

`verity/exchange.py` is the only code that can act on a Gemini Exchange account, and every action goes through one gate. The exchange's market data stays public, so analysis never needs this key.

| Rule | Default |
|---|---|
| Environment | sandbox (`api.sandbox.gemini.com`). Production needs `VERITY_EXCHANGE_ENV=production` **and** `VERITY_ALLOW_PRODUCTION=yes` |
| Sending | dry run: orders are built, checked and logged, but not sent, until you pass `dry_run=False` |
| Order types | limit only, with a price strictly between 0 and 1 |
| Per order | at most $5.00 |
| Per day | at most $25.00, counting orders sent and orders whose outcome is unknown |
| Owner approval | required above $1.00. The default approver denies, so plug in the payment service's wallet-signature check |
| Price band | within 5¢ of the analysed best ask (buy) or best bid (sell) |
| Analysis | an order needs a `RiskAnalysisV1` for the same instrument. Markets flagged for human review are refused |
| Expiry | refused within 1 hour of expiry |
| Allowlist | only symbols you list in `TradingPolicy.symbol_allowlist` |
| Funds movement | no withdraw, transfer or deposit method exists, and those paths are refused even if called directly |
| Timeouts | an order with an unknown outcome blocks that symbol until `mark_reconciled()` is called |
| Pause | `VERITY_TRADING_PAUSED=1` stops every write |
| Audit | every decision (refused, dry_run, sent, outcome_unknown, reconciled) goes to a JSON-lines log. Keys, secrets and signatures are never logged |

Key setup: create the key at exchange.gemini.com, under Settings, then API. Make it account-scoped, with a time-based nonce, and give it the **Auditor** role for read-only use. Use **Trader** only if the agent really places orders, and never use **Fund Manager**. Set it in the shell as `GEMINI_EXCHANGE_API_KEY` and `GEMINI_EXCHANGE_API_SECRET`. The account must accept the prediction-market terms before its first order. Sandbox needs its own separate account and key.

```python
from verity.exchange import GuardedExchange, TradingPolicy, AuditLog, OrderRequest
ex = GuardedExchange(TradingPolicy(symbol_allowlist={ra.instrument_symbol}), AuditLog(Path("audit/exchange.jsonl")))
ex.place_order(OrderRequest(symbol=ra.instrument_symbol, side="buy", outcome="yes",
                            quantity="1", price=ra.quoted_price.best_ask, reason="..."), analysis=ra)
```

Not built yet: the WebSocket `order.place` path. Gemini recommends it for active trading, but REST is enough for occasional orders. The paths for listing active orders were not in the docs that were read, so they are not wired up.

The fixtures were checked against `Prediction market risk analysis.xlsx`, which has the same five rows, the same rubric and overrides, and the same 11 agent rules. The repo-level README still describes a 1–5 scale. This slice uses the workbook's 1–3 scale, as agreed for the prototype.

## Layout

```
verity/
  schemas.py     RiskAnalysisV1, PurchaseProposalV1 (pydantic, extra fields forbidden)
  scoring.py     workbook 1-3 rubric, 4-12 bands, overrides kept separate, liquidity computed in code
  analysis.py    get_risk_analysis(contract_id, ctx=None)
  proposals.py   generate_purchase_request(risk_analysis, ctx=None, decision_log=None)
  fixtures.py    loader, FixedClock (2026-11-18T01:00:00Z = Nov 17, 8pm ET), snapshot hash
  live.py        Gemini Exchange read + terms PDF -> fixture-shaped record; analyze_live()
  llm.py         Google Gemini analyst (structured output), validation and repair
  exchange.py    guarded Gemini Exchange actions: sandbox + dry run by default, caps, approval, audit
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
- **Liquidity** is computed from the quotes and never comes from the model. In fixture mode, the analyst block in each fixture stands in for the Google Gemini structured-output call.
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
- **Field names:** `verity/live.py` uses the field names from Gemini's API docs. Check them against one real response; nobody has made a live call yet.
- **Tickers** are missing for the Fed and Best AI rows, which came from CoinRithm rather than Gemini. They are flagged, and purchases for them are blocked.
- **Rules text** is a paraphrase of the API descriptions. Fetch the terms PDFs so citations quote the actual rules.
- **Expiry:** every fixture market expires between Nov 19 and Jan 1. After that, keep the fixture clock or take a new snapshot.
- **The Google Gemini analyst** is built and tested only against a fake client. It needs one real run with the paid key to confirm the model ID and how good its scores are.
- **Free checks in live mode:** to let a live gap lead to a purchase, add a free-check source for each type of gap (for example, read the terms PDF for the settlement rule).
