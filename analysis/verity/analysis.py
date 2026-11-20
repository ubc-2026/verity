"""get_risk_analysis(contract_id) -> RiskAnalysisV1.

Fixture files already contain ambiguity, source, and correlation scores.
A live exchange snapshot leaves those three null. Liquidity is always
computed here from the quoted numbers.
"""
from __future__ import annotations

from decimal import Decimal
from typing import Any, Optional

from .fixtures import FixtureContext, canonical_hash, fmt_utc
from .schemas import (
    CategoryScore, Citation, EvidenceGap, QuotedPrice, ResearchAction,
    RiskAnalysisV1, Scores, Snapshot,
)
from .scoring import liquidity_score, rate

# Workbook-level conflicts that apply to every fixture.
GLOBAL_WORKBOOK_CONFLICTS = [
    "Scale: the README specifies 1-5 per category; the workbook uses 1-3. This prototype uses the workbook's 1-3 scale and 4-12 totals.",
    "Markets!B formula =IF(I>=9,\"High\",IF(I>=7,\"Medium\",\"Low\")) ignores the Framework overrides, and SUM() treats a blank score as 0, so an incomplete row shows as Low. The code reports incomplete ratings instead.",
    "Volume column mixes bases: rows 2-4 are event totals from the Gemini API, rows 5-6 are 24h figures from CoinRithm, while Agent rule 4 is written for 24h volume.",
    "Override 'any 3 in Ambiguity or Source -> at least Medium' only changes the result at a raw total of 6 (for example 3+1+1+1); at 7 or more the total is already Medium.",
    "Override 'High (3) in Liquidity -> never trade more than top-of-book' is a trading rule. Verity places no trades, so it becomes a note that the price is an unreliable signal.",
    "Agent action column uses trading verbs (Proceed, Proceed small size). They are mapped to research actions: Low -> no_further_research, Medium -> investigate, High -> flag_for_human_review.",
]

ROW_CONFLICTS = {
    "fx-okc-moneyline-20261118": "Row 2 scores Correlation 1, yet its Key risks cite injury news, which the Framework lists under Correlation 2 ('injury reports'). The total stays Low either way (4 vs 5).",
    "fx-msu-spread-20261117": "Row 4 is Medium (7) but its action is 'Proceed, small size'; the Framework's Medium default is 'Investigate first'.",
    "fx-best-ai-2026-gemini": "Row 6 scores Source 2, but the Framework describes LM Arena ('third-party ranking that changes continuously') as Source 3.",
}

_ACTION: dict[str, ResearchAction] = {
    "Low": "no_further_research", "Medium": "investigate", "High": "flag_for_human_review",
}


def _dec(x: Optional[str]) -> Optional[Decimal]:
    return Decimal(x) if x is not None else None


def _quoted_price(m: dict[str, Any]) -> QuotedPrice:
    mk = m["market"]
    bid, ask = _dec(mk.get("best_bid")), _dec(mk.get("best_ask"))
    # The mid of a two-sided, uncrossed book only. A missing, one-sided or crossed book has no midpoint.
    mid = (bid + ask) / 2 if bid is not None and ask is not None and bid <= ask else None
    reported = mk.get("reported_probability")
    implied = str(mid) if mid is not None else reported
    return QuotedPrice(
        outcome_label=m["outcome_label"],
        best_bid=mk.get("best_bid"), best_ask=mk.get("best_ask"),
        mid=str(mid) if mid is not None else None,
        implied_probability=implied,
        volume_usd=mk.get("volume_usd"), volume_basis=mk.get("volume_basis", "unknown"),
        observed_date=m["source"]["snapshot_date"],
        observed_time_utc=m["source"]["snapshot_time_utc"],
    )


def _flags(m: dict[str, Any]) -> list[str]:
    f: list[str] = []
    if m["source"]["mode"] == "fixture":
        f.append(f"source_mode=fixture ({m['source']['label']})")
    if m["source"]["snapshot_time_utc"] is None:
        f.append("snapshot_time_unrecorded: workbook stores the date only")
    if m["ticker_status"] != "confirmed":
        f.append(f"ticker_{m['ticker_status']}: no Gemini event ticker captured; confirm via the live API before any purchase")
    if m["instrument_symbol"] is None:
        f.append("instrument_symbol_not_captured")
    if not m.get("event_terms_url_present", True):
        f.append("event_terms_url_empty")
    if m["terms_url"] is None:
        f.append("terms_url_missing")
    if any("paraphrased" in r["field_or_rule"] for r in m["rules_excerpts"]):
        f.append("rules_paraphrased: excerpts paraphrase API descriptions; terms PDF not fetched")
    if m["market"].get("volume_basis") != "total":
        f.append(f"volume_basis={m['market'].get('volume_basis')}: not comparable with event-total rows")
    if m["source"]["label"].startswith("CoinRithm"):
        f.append("third_party_price_source: price not read from Gemini directly")
    if m.get("terms_problem"):
        f.append(f"terms_not_read: {m['terms_problem']}")
    if m.get("reading_scores_unscored"):
        f.append("reading_scores_unscored: ambiguity, source, and correlation are left null")
    if m.get("analyst_id"):
        f.append(f"analyst={m['analyst_id']} (code rules, no LLM)")
    return f


def get_risk_analysis(contract_id: str, ctx: Optional[FixtureContext] = None) -> RiskAnalysisV1:
    ctx = ctx or FixtureContext.default()
    if contract_id not in ctx.markets:
        raise KeyError(f"unknown fixture contract_id {contract_id!r}")
    m = ctx.markets[contract_id]

    mk = m["market"]
    liq, liq_why, liq_null = liquidity_score(
        _dec(mk.get("volume_usd")), _dec(mk.get("best_bid")), _dec(mk.get("best_ask")),
        bool(mk.get("some_strikes_unquoted")),
        mk.get("volume_basis"),
    )
    a = m["analyst"]
    scores = Scores(
        ambiguity=CategoryScore(**a["ambiguity"]),
        source=CategoryScore(**a["source"]),
        liquidity=CategoryScore(score=liq, rationale=liq_why, null_reason=liq_null,
                                citation_ids=[e["id"] for e in m["rules_excerpts"] if "prices" in e["field_or_rule"]]),
        correlation=CategoryScore(**a["correlation"]),
    )
    rating = rate(scores)

    if rating.complete:
        action = _ACTION[rating.final_rating]  # type: ignore[index]
    else:
        action = "flag_for_human_review" if rating.possible_range[1] == "High" else "investigate"  # type: ignore[index]

    gaps = [EvidenceGap(**g) for g in m["evidence_gaps"]]
    unresolved = [g.question for g in gaps if g.material]
    if m["ticker_status"] != "confirmed":
        unresolved.append("Which Gemini event ticker and instrument symbol is this market?")

    conflicts = list(GLOBAL_WORKBOOK_CONFLICTS)
    wb = m.get("workbook")          # only fixtures carry a workbook row to compare with
    if wb and wb["scores"]["liquidity"] != liq:
        conflicts.append(f"Row {m['workbook_row']} liquidity is {wb['scores']['liquidity']}; the code computes {liq} from the same quotes.")
    if wb and rating.raw_total is not None and wb["total"] != rating.raw_total:
        conflicts.append(f"Row {m['workbook_row']} total is {wb['total']}; the code computes {rating.raw_total}.")
    if m["contract_id"] in ROW_CONFLICTS:
        conflicts.append(ROW_CONFLICTS[m["contract_id"]])

    label = rating.final_rating or f"incomplete ({rating.possible_range[0]}-{rating.possible_range[1]})"  # type: ignore[index]
    summary = (f"{label} resolution risk (total {rating.raw_total if rating.complete else str(rating.known_total) + '+?'}). "
               f"Research action: {action}. "
               + (f"{len(unresolved)} open question(s)." if unresolved else "No open resolution questions."))

    return RiskAnalysisV1(
        contract_id=contract_id,
        event_ticker=m["event_ticker"],
        instrument_symbol=m["instrument_symbol"],
        question=m["question"],
        expiry_utc=m["expiry_utc"],
        analyzed_at_utc=fmt_utc(ctx.clock.now()),
        snapshot=Snapshot(
            source_mode=m["source"]["mode"], source_label=m["source"]["label"],
            snapshot_date=m["source"]["snapshot_date"], snapshot_time_utc=m["source"]["snapshot_time_utc"],
            snapshot_hash=canonical_hash(m),
        ),
        quoted_price=_quoted_price(m),
        scores=scores,
        rating=rating,
        research_action=action,
        summary=summary,
        # An excerpt read from another document (the terms PDF) names it as its source.
        citations=[Citation(**{"source": m["source"]["url"], **e}) for e in m["rules_excerpts"]],
        evidence_gaps=gaps,
        unresolved_questions=unresolved,
        data_quality_flags=_flags(m),
        workbook_conflicts=conflicts,
    )
