"""Fixture-only demo: no network, no API key, no wallet.

    python demo.py            # prints the three runs and writes samples/*.json

Live (needs network only; the Gemini Exchange events API is public, the analyst is
code-only with no LLM, and it still places no trades):
    python demo.py --live NBA-2611190100-ATL-OKC-M --outcome "Oklahoma City"
"""
from __future__ import annotations

import json
from pathlib import Path

from verity import FixtureContext, generate_purchase_request, get_risk_analysis

OUT = Path(__file__).resolve().parent / "samples"


def run(title: str, contract_id: str, scenario: str | None, sample_name: str | None) -> None:
    ctx = FixtureContext.default(free_check_scenario=scenario)
    print(f"\n=== {title} ===  (fixture clock {ctx.clock.now_utc})")
    ra = get_risk_analysis(contract_id, ctx)
    r = ra.rating
    s = ra.scores
    print(f"price  {ra.quoted_price.outcome_label}: bid {ra.quoted_price.best_bid} / ask {ra.quoted_price.best_ask}"
          f"  implied {ra.quoted_price.implied_probability}  (observed {ra.quoted_price.observed_date})")
    print(f"scores ambiguity={s.ambiguity.score} source={s.source.score} liquidity={s.liquidity.score} correlation={s.correlation.score}")
    print(f"rating raw {r.raw_total} -> {r.raw_rating}; floor {r.rating_floor}; final {r.final_rating}; action {ra.research_action}")
    for o in r.overrides:
        print(f"  override: {o.rule} -> {o.effect}")
    log: list[str] = []
    prop = generate_purchase_request(ra, ctx, decision_log=log)
    for line in log:
        print("  log:", line)
    print("proposal:", "null" if prop is None else prop.model_dump_json(indent=2))
    if sample_name:
        OUT.mkdir(exist_ok=True)
        (OUT / sample_name).write_text(json.dumps(
            {"risk_analysis": ra.model_dump(mode="json"),
             "purchase_proposal": None if prop is None else prop.model_dump(mode="json"),
             "decision_log": log},
            indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


def run_live(ticker: str, outcome: str, read_terms: bool) -> None:
    from verity.live import analyze_live
    ra, ctx = analyze_live(ticker, outcome, read_terms=read_terms)
    print(f"\n=== LIVE {ticker} / {outcome} ===  (clock {ctx.clock.now_utc})")
    s, r = ra.scores, ra.rating
    print(f"price  bid {ra.quoted_price.best_bid} / ask {ra.quoted_price.best_ask}  implied {ra.quoted_price.implied_probability}")
    print(f"scores ambiguity={s.ambiguity.score} source={s.source.score} liquidity={s.liquidity.score} correlation={s.correlation.score}")
    print(f"rating raw {r.raw_total} -> {r.raw_rating}; floor {r.rating_floor}; final {r.final_rating}; "
          f"complete={r.complete}; action {ra.research_action}")
    for f in ra.data_quality_flags:
        print("  flag:", f)
    log: list[str] = []
    prop = generate_purchase_request(ra, ctx, decision_log=log)
    for line in log:
        print("  log:", line)
    print("proposal:", "null" if prop is None else prop.model_dump_json(indent=2))
    OUT.mkdir(exist_ok=True)
    (OUT / "live_last_run.json").write_text(json.dumps(
        {"risk_analysis": ra.model_dump(mode="json"),
         "purchase_proposal": None if prop is None else prop.model_dump(mode="json"),
         "decision_log": log}, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


if __name__ == "__main__":
    import argparse
    ap = argparse.ArgumentParser(description="Verity analysis demo")
    ap.add_argument("--live", metavar="EVENT_TICKER", help="read this Gemini Exchange event and score it with the code-only rules")
    ap.add_argument("--outcome", help="contract label to analyze, e.g. 'Oklahoma City'")
    ap.add_argument("--no-terms", action="store_true", help="skip downloading the terms PDF")
    args = ap.parse_args()
    if args.live:
        if not args.outcome:
            ap.error("--live needs --outcome")
        run_live(args.live, args.outcome, read_terms=not args.no_terms)
        raise SystemExit(0)
    run("OKC moneyline: clear rules", "fx-okc-moneyline-20261118", None, "okc_moneyline.json")
    run("NYC high temp: free check answers (FIXTURE)", "fx-nyc-high-20261118", "free-check-answers", None)
    run("NYC high temp: gap remains (OBSERVED terms + NWS, 2026-11-18)", "fx-nyc-high-20261118", "observed-2026-11-18", "nyc_high_gap_remains.json")
