# Research evaluation research-eval-v1: results

Ran 2026-11-20T02:15:05.173Z on 1344e90 plus uncommitted changes. 37 of 51 checks passed across 19 cases.

> This is a research evaluation of how Verity reads markets. It does not measure forecasting performance; that needs a separate backtest. Human review: 0 of 19 cases approved so far, so every expected label below is provisional.

## By category and check

| Check | Weather | Sports | All |
| --- | --- | --- | --- |
| instrument_matching | 4/4 | 3/3 | 7/7 |
| quote_correctness | 7/7 | 2/2 | 9/9 |
| citation_support | 1/9 | 4/5 | 5/14 |
| rubric_agreement | 4/5 | 2/5 | 6/10 |
| abstention | 4/5 | 3/3 | 7/8 |
| risk_change_traceability | 2/2 | 1/1 | 3/3 |
| **all checks** | 22/32 | 15/19 | 37/51 |

## By data label

| Data | Passed |
| --- | --- |
| CAPTURED | 7/7 |
| FIXTURE | 28/42 |
| LIVE | 2/2 |

## Rubric agreement by dimension

Exact agreement between the code-only rules analyst and the expected label, over cases with rubric labels.

| Dimension | Weather | Sports | All |
| --- | --- | --- | --- |
| ambiguity | 4/5 | 2/5 | 6/10 |
| source | 5/5 | 5/5 | 10/10 |
| liquidity | 5/5 | 5/5 | 10/10 |
| correlation | 5/5 | 5/5 | 10/10 |

## By case type

| Tag | Passed |
| --- | --- |
| abstain | 7/11 |
| ambiguous_rules | 3/4 |
| buy | 4/5 |
| clear_rules | 9/13 |
| closed_quote | 2/2 |
| contradictory_sources | 1/4 |
| correlated | 1/3 |
| crossed_quote | 2/3 |
| free_evidence_answers_gap | 2/3 |
| instrument_matching | 14/16 |
| live | 2/2 |
| missing_terms | 5/6 |
| one_sided_quote | 3/4 |
| revisable_source | 4/5 |
| risk_change | 5/7 |
| stale_quote | 1/1 |
| unverified_evidence | 3/4 |
| verified_evidence | 2/3 |

## Failures (14)

- **W01-nyc-band-buy** `citation_support` (FIXTURE): source cites C-NYC-2, which is empty, for a claim that is not about an absence; correlation cites C-NYC-2, which is empty, for a claim that is not about an absence
  - expected `"every cited excerpt exists and has text"`
  - got `["source cites C-NYC-2, which is empty, for a claim that is not about an absence","correlation cites C-NYC-2, which is empty, for a claim that is not about an absence"]`
- **W02-nyc-free-check-answers** `citation_support` (FIXTURE): source cites C-NYC-2, which is empty, for a claim that is not about an absence; correlation cites C-NYC-2, which is empty, for a claim that is not about an absence
  - expected `"every cited excerpt exists and has text"`
  - got `["source cites C-NYC-2, which is empty, for a claim that is not about an absence","correlation cites C-NYC-2, which is empty, for a claim that is not about an absence"]`
- **W03-nyc-verified-evidence** `citation_support` (FIXTURE): source cites C-NYC-2, which is empty, for a claim that is not about an absence; correlation cites C-NYC-2, which is empty, for a claim that is not about an absence
  - expected `"every cited excerpt exists and has text"`
  - got `["source cites C-NYC-2, which is empty, for a claim that is not about an absence","correlation cites C-NYC-2, which is empty, for a claim that is not about an absence"]`
- **W04-nyc-unverified-evidence** `citation_support` (FIXTURE): source cites C-NYC-2, which is empty, for a claim that is not about an absence; correlation cites C-NYC-2, which is empty, for a claim that is not about an absence
  - expected `"every cited excerpt exists and has text"`
  - got `["source cites C-NYC-2, which is empty, for a claim that is not about an absence","correlation cites C-NYC-2, which is empty, for a claim that is not about an absence"]`
- **W05-nyc-one-sided** `citation_support` (FIXTURE): source cites C-NYC-2, which is empty, for a claim that is not about an absence; correlation cites C-NYC-2, which is empty, for a claim that is not about an absence
  - expected `"every cited excerpt exists and has text"`
  - got `["source cites C-NYC-2, which is empty, for a claim that is not about an absence","correlation cites C-NYC-2, which is empty, for a claim that is not about an absence"]`
- **W07-nyc-crossed** `citation_support` (FIXTURE): source cites C-NYC-2, which is empty, for a claim that is not about an absence; correlation cites C-NYC-2, which is empty, for a claim that is not about an absence
  - expected `"every cited excerpt exists and has text"`
  - got `["source cites C-NYC-2, which is empty, for a claim that is not about an absence","correlation cites C-NYC-2, which is empty, for a claim that is not about an absence"]`
- **W08-nyc-terms-missing** `abstention` (FIXTURE): [fx-nyc-high-20261118] PROPOSE cat-nws-cli-settlement-version-v1 for GAP-1: max 50000 base units (= 0.05 USDC), unsigned.
  - expected `{"decision":"abstain","gap_type":null}`
  - got `{"decision":"buy","proposal":{"gap_id":"GAP-1","catalog_item_id":"cat-nws-cli-settlement-version-v1"}}`
- **W09-nyc-contradictory-sources** `citation_support` (FIXTURE): source cites C-NYC-2, which is empty, for a claim that is not about an absence; correlation cites C-NYC-2, which is empty, for a claim that is not about an absence
  - expected `"every cited excerpt exists and has text"`
  - got `["source cites C-NYC-2, which is empty, for a claim that is not about an absence","correlation cites C-NYC-2, which is empty, for a claim that is not about an absence"]`
- **W09-nyc-contradictory-sources** `rubric_agreement` (FIXTURE): ambiguity: expected 3, got 2
  - expected `{"ambiguity":3,"source":2,"liquidity":3,"correlation":1}`
  - got `{"ambiguity":2,"source":2,"liquidity":3,"correlation":1}`
- **W10-nyc-discretion** `citation_support` (FIXTURE): ambiguity cites C-NYC-2, which is empty, for a claim that is not about an absence; source cites C-NYC-2, which is empty, for a claim that is not about an absence; correlation cites C-NYC-2, which is empty, for a claim that is not about an absence
  - expected `"every cited excerpt exists and has text"`
  - got `["ambiguity cites C-NYC-2, which is empty, for a claim that is not about an absence","source cites C-NYC-2, which is empty, for a claim that is not about an absence","correlation cites C-NYC-2, which is empty, for a claim that is not about an absence"]`
- **S01-okc-moneyline-clear** `rubric_agreement` (FIXTURE): ambiguity: expected 1, got 2
  - expected `{"ambiguity":1,"source":1,"liquidity":1,"correlation":1}`
  - got `{"ambiguity":2,"source":1,"liquidity":1,"correlation":1}`
- **S03-msu-spread-correlated** `citation_support` (FIXTURE): liquidity=2 cites nothing
  - expected `"every cited excerpt exists and has text"`
  - got `["liquidity=2 cites nothing"]`
- **S03-msu-spread-correlated** `rubric_agreement` (FIXTURE): ambiguity: expected 1, got 2
  - expected `{"ambiguity":1,"source":1,"liquidity":2,"correlation":3}`
  - got `{"ambiguity":2,"source":1,"liquidity":2,"correlation":3}`
- **S05-okc-contradictory-sources** `rubric_agreement` (FIXTURE): ambiguity: expected 3, got 2
  - expected `{"ambiguity":3,"source":1,"liquidity":1,"correlation":1}`
  - got `{"ambiguity":2,"source":1,"liquidity":1,"correlation":1}`

## Examples that pass

- **W03-nyc-verified-evidence** `abstention` (FIXTURE): got `{"decision":"buy","proposal":{"gap_id":"GAP-1","catalog_item_id":"cat-nws-cli-settlement-version-v1"}}`
- **W03-nyc-verified-evidence** `risk_change_traceability` (FIXTURE): got `{"status":"revised","changed":true,"changes":["evidence_gaps.GAP-1: open -> closed","scores.source: 2 -> 1","rating.raw_total: 8 -> 7"],"evidence_cited":true,"database":"accepted","forced_change_on_unverified":"not attempted"}`
- **W04-nyc-unverified-evidence** `abstention` (FIXTURE): got `{"decision":"buy","proposal":{"gap_id":"GAP-1","catalog_item_id":"cat-nws-cli-settlement-version-v1"}}`
- **W04-nyc-unverified-evidence** `risk_change_traceability` (FIXTURE): got `{"status":"evidence_rejected","changed":false,"changes":[],"evidence_cited":true,"database":"accepted","forced_change_on_unverified":"refused"}`
- **W07-nyc-crossed** `quote_correctness` (FIXTURE): got `{"state":"crossed","implied":null,"stored":{"quoteState":"crossed","impliedProbability":null}}`
- **W07-nyc-crossed** `quote_correctness` (FIXTURE): got `{"mid":null,"implied":null}`
- **S08-okc-wrong-game** `instrument_matching` (CAPTURED): got `{"fail":"event_mismatch"}`
- **S08-okc-wrong-game** `instrument_matching` (CAPTURED): got `{"fail":"no_match"}`

## How to read this

- FIXTURE: recorded or hand-made test data, including fixture records changed for a case. CAPTURED: a saved real API response. LIVE: read during this run.
- Labels from the team workbook are the team's human-entered scores. Labels drafted by Claude are marked in cases.json and need a reviewer before they count as ground truth.
- A failure is a disagreement with the expected label. For a low-confidence label it may be the label that is wrong; the reviewer decides.
