"""Gemini Market Risk Analysis.xlsx Framework scoring.

Excel factors are 0 / 1 / 2. They are stored on RiskAnalysisV1 as 1 / 2 / 3
(excel + 1) so the existing schema stays stable:

  ambiguity  <- Resolution criteria
  source     <- Source reliability
  liquidity  <- Liquidity
  correlation<- Outside events  (context; not in either composite)

Composites (Excel):
  settlement_edge = resolution_criteria + source_reliability   (0..4)
  execution_risk  = liquidity + price_and_data_quality         (0..4)

Action (Excel Scores!J formula):
  Avoid           if liquidity==2 OR execution_risk>=3 OR researchable==No
  Investigate     else if settlement_edge>=1 (and researchable)
  Trade normally  else

Mapped onto Low / Medium / High for the rest of Verity:
  Trade normally -> Low    -> no_further_research
  Investigate    -> Medium -> investigate  (research buys allowed)
  Avoid          -> High   -> flag_for_human_review (no research buy)
"""
from __future__ import annotations

from decimal import Decimal
from typing import Optional

from .schemas import AppliedOverride, CategoryScore, OverallRating, Rating, Scores

_ORDER: dict[Rating, int] = {"Low": 0, "Medium": 1, "High": 2}

# Human-readable checklist (Excel Framework factor table).
READING_RUBRIC = """
Resolution criteria (stored as Ambiguity, Excel 0-2 -> schema 1-3):
  0/1: Clear threshold, exact time, named source, simple fallback.
  1/2: Needs judgment: rounding, ties, a missing outcome, or a title that
       names a different place than the rule (Chicago vs Midway).
  2/3: The rule contradicts the title or leaves the outcome undefined.

Source reliability (stored as Source):
  0/1: Official source that measures the thing itself (NWS, league, Lukka).
  1/2: Index with a thinner feed, or a third-party copy of an official number.
  2/3: Proxy or private source: crypto perp for oil, Mecone nowcast for GDP.

Liquidity (Excel cutoffs):
  0/1: Bid and ask quoted, spread 5c or less, volume $1,000 or more.
  1/2: Spread 6 to 15c, or volume under $1,000 (including zero).
  2/3: No bid or no ask, or spread over 15c.

Price and data quality (used in execution risk; not a stored ASLC column):
  0: Thresholds priced in order, last trade near the quotes.
  1: Last trade stale, never traded, or one side missing.
  2: Prices contradict each other, or no prices at all.

Outside events (stored as Correlation; context only, not in either score):
  0/1: Nothing pending that could swing or delay it.
  1/2: Normal news risk before expiry (injuries, volatility).
  2/3: Depends on a data release that could be delayed.
""".strip()


def to_schema(excel_0_2: int) -> int:
    """Excel 0-2 -> schema 1-3."""
    if excel_0_2 not in (0, 1, 2):
        raise ValueError(f"excel factor must be 0-2, got {excel_0_2}")
    return excel_0_2 + 1


def to_excel(schema_1_3: int) -> int:
    """Schema 1-3 -> Excel 0-2."""
    if schema_1_3 not in (1, 2, 3):
        raise ValueError(f"schema score must be 1-3, got {schema_1_3}")
    return schema_1_3 - 1


def band(total: int) -> Rating:
    """Legacy ASLC band helper kept for unit tests that still sum 4-12."""
    if not 4 <= total <= 12:
        raise ValueError(f"total {total} is outside 4-12")
    if total <= 6:
        return "Low"
    if total <= 8:
        return "Medium"
    return "High"


def _max(a: Rating, b: Optional[Rating]) -> Rating:
    return a if b is None or _ORDER[a] >= _ORDER[b] else b


def _volume_phrase(volume_usd: Decimal, volume_basis: Optional[str]) -> str:
    if volume_basis == "24h":
        return f"24h volume ${volume_usd}"
    if volume_basis == "total":
        return f"event-total volume ${volume_usd}"
    return f"Volume ${volume_usd}"


def liquidity_score(
    volume_usd: Optional[Decimal],
    best_bid: Optional[Decimal],
    best_ask: Optional[Decimal],
    some_strikes_unquoted: bool = False,
    volume_basis: Optional[str] = None,
) -> tuple[Optional[int], str, Optional[str]]:
    """Excel Liquidity 0-2, returned as schema 1-3.

    null: no bid, no ask, and no volume. Or both prices present and volume missing.
    3 (excel 2): no two-sided quote, or spread over 15c.
    1 (excel 0): volume >= $1000, spread <= 5c, every strike quoted.
    2 (excel 1): any other two-sided quote.
    """
    volume = _volume_phrase(volume_usd, volume_basis) if volume_usd is not None else None

    if volume_usd is None and best_bid is None and best_ask is None:
        return None, "No volume or quotes in the snapshot.", "market data missing"
    if best_bid is None or best_ask is None:
        note = f" {volume} is on file." if volume else ""
        return 3, f"No two-sided quote.{note}", None

    spread_cents = (best_ask - best_bid) * 100
    spread = f"{spread_cents:.0f}c spread"
    if spread_cents > 15:
        return 3, f"{spread} is over 15c.", None
    if volume_usd is None:
        return None, f"{spread}, but volume is missing.", "volume missing"
    if volume_usd >= 1000 and spread_cents <= 5 and some_strikes_unquoted:
        return 2, f"{volume}, {spread}, but some strikes have no bid.", None
    if volume_usd >= 1000 and spread_cents <= 5:
        return 1, f"{volume} with a {spread}.", None
    return 2, f"{volume}, {spread}.", None


def price_data_quality_score(
    volume_usd: Optional[Decimal],
    best_bid: Optional[Decimal],
    best_ask: Optional[Decimal],
    last_trade: Optional[Decimal] = None,
    prices_contradict: bool = False,
) -> tuple[int, str]:
    """Excel Price and data quality 0-2 (not stored; feeds execution risk)."""
    if prices_contradict:
        return 2, "Prices contradict each other across contracts."
    if best_bid is None and best_ask is None:
        return 2, "No prices at all."
    if best_bid is None or best_ask is None:
        return 1, "One side of the book is missing."
    if volume_usd is not None and volume_usd == 0:
        return 1, "Never traded (volume is zero)."
    if last_trade is not None:
        mid = (best_bid + best_ask) / 2
        if abs(last_trade - mid) > Decimal("0.15"):
            return 1, "Last trade is more than 15c from the midpoint (Excel rule 3)."
    return 0, "Two-sided quotes look orderly."


def excel_action(
    resolution: int,
    source: int,
    liquidity: int,
    price_quality: int,
    researchable: Optional[bool],
) -> tuple[str, int, int, list[AppliedOverride]]:
    """Return (action, settlement_edge, execution_risk, overrides). Factors are Excel 0-2."""
    settlement_edge = resolution + source
    execution_risk = liquidity + price_quality
    overrides: list[AppliedOverride] = [
        AppliedOverride(
            rule="settlement_edge = resolution_criteria + source_reliability",
            triggered_by="ambiguity",
            effect=f"settlement_edge={settlement_edge}",
        ),
        AppliedOverride(
            rule="execution_risk = liquidity + price_and_data_quality",
            triggered_by="liquidity",
            effect=f"execution_risk={execution_risk}",
        ),
    ]

    # Excel: Avoid if Liquidity==2 OR execution>=3 OR researchable==No
    if liquidity == 2:
        overrides.append(AppliedOverride(
            rule="Avoid when Liquidity is 2 (no quote / spread over 15c)",
            triggered_by="liquidity",
            effect="action Avoid; market cannot really be traded",
        ))
        return "Avoid", settlement_edge, execution_risk, overrides
    if execution_risk >= 3:
        overrides.append(AppliedOverride(
            rule="Avoid when execution_risk >= 3",
            triggered_by="liquidity",
            effect="action Avoid; even a settlement edge cannot be traded cleanly",
        ))
        return "Avoid", settlement_edge, execution_risk, overrides
    if researchable is False:
        overrides.append(AppliedOverride(
            rule="Avoid when the ambiguity is not researchable",
            triggered_by="ambiguity",
            effect="action Avoid; research cannot settle the question",
        ))
        return "Avoid", settlement_edge, execution_risk, overrides

    if settlement_edge >= 1:
        overrides.append(AppliedOverride(
            rule="Investigate when settlement_edge >= 1 and the market is tradeable",
            triggered_by="source" if source >= resolution else "ambiguity",
            effect="action Investigate; buy research on the settlement edge",
        ))
        return "Investigate", settlement_edge, execution_risk, overrides

    overrides.append(AppliedOverride(
        rule="Trade normally when settlement_edge is 0 and the market is tradeable",
        triggered_by="ambiguity",
        effect="action Trade normally; no settlement edge",
    ))
    return "Trade normally", settlement_edge, execution_risk, overrides


_ACTION_TO_RATING: dict[str, Rating] = {
    "Trade normally": "Low",
    "Investigate": "Medium",
    "Avoid": "High",
}


def rate(
    scores: Scores,
    *,
    price_quality_excel: int = 0,
    researchable: Optional[bool] = None,
) -> OverallRating:
    """Excel decision engine. Schema scores are 1-3; converted to Excel 0-2 inside."""
    cats: dict[str, CategoryScore] = {
        "ambiguity": scores.ambiguity,
        "source": scores.source,
        "liquidity": scores.liquidity,
        "correlation": scores.correlation,
    }
    known = {k: v.score for k, v in cats.items() if v.score is not None}
    missing = [k for k in ("ambiguity", "source", "liquidity") if k not in known]
    # Outside events (correlation) is context-only; incompleteness ignores it for action.
    known_total = sum(v for v in known.values())

    if missing:
        return OverallRating(
            complete=False, known_total=known_total, raw_total=None, raw_rating=None,
            rating_floor=None, final_rating=None,
            possible_range=("Low", "High"),
            overrides=[],
        )

    resolution = to_excel(known["ambiguity"])
    source = to_excel(known["source"])
    liquidity = to_excel(known["liquidity"])
    if price_quality_excel not in (0, 1, 2):
        raise ValueError(f"price_quality_excel must be 0-2, got {price_quality_excel}")

    # If settlement edge is 0, researchable is n/a (treated as None / not blocking).
    edge = resolution + source
    res_flag = researchable
    if edge == 0:
        res_flag = None
    elif res_flag is None:
        # Default: researchable when there is an edge, unless resolution is undefined (excel 2).
        res_flag = resolution < 2

    action, settlement_edge, execution_risk, overrides = excel_action(
        resolution, source, liquidity, price_quality_excel, res_flag,
    )
    final = _ACTION_TO_RATING[action]
    # raw_total kept as schema sum for continuity in samples; raw_rating follows action.
    return OverallRating(
        complete=True,
        known_total=known_total,
        raw_total=known_total,
        raw_rating=final,
        rating_floor=None,
        final_rating=final,
        possible_range=None,
        overrides=overrides + [
            AppliedOverride(
                rule=f"Excel action '{action}' (settlement_edge={settlement_edge}, execution_risk={execution_risk})",
                triggered_by="ambiguity",
                effect=f"final_rating {final}",
            ),
        ],
    )
