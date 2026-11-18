"""Workbook rubric (Framework sheet), 1-3 per category.

Bands, from the workbook: total 4-6 Low, 7-8 Medium, 9-12 High.
Overrides, applied separately from the raw total:
  * Any 3 in Ambiguity or Source  -> rating is at least Medium.
  * 3 in Liquidity                -> trading rule ("never trade more than
    top-of-book"). Verity places no trades, so it is translated into a research
    note: the quoted price is unreliable as a signal. It does not move the rating.
"""
from __future__ import annotations

from decimal import Decimal
from typing import Optional

from .schemas import AppliedOverride, CategoryScore, OverallRating, Rating, Scores

_ORDER: dict[Rating, int] = {"Low": 0, "Medium": 1, "High": 2}


def band(total: int) -> Rating:
    if not 4 <= total <= 12:
        raise ValueError(f"total {total} is outside 4-12")
    if total <= 6:
        return "Low"
    if total <= 8:
        return "Medium"
    return "High"


def _max(a: Rating, b: Optional[Rating]) -> Rating:
    return a if b is None or _ORDER[a] >= _ORDER[b] else b


def liquidity_score(
    volume_usd: Optional[Decimal],
    best_bid: Optional[Decimal],
    best_ask: Optional[Decimal],
    some_strikes_unquoted: bool = False,
) -> tuple[Optional[int], str, Optional[str]]:
    """Framework liquidity row. Returns (score, rationale, null_reason)."""
    if volume_usd is None and best_bid is None and best_ask is None:
        return None, "No volume or quotes in the snapshot.", "market data missing"
    if best_bid is None or best_ask is None:
        return 3, "No two-sided live quote.", None
    spread_cents = (best_ask - best_bid) * 100
    if volume_usd is not None and volume_usd < 100:
        return 3, f"Volume ${volume_usd} is under $100 (spread {spread_cents:.0f}c).", None
    if spread_cents > 5:
        return 3, f"Spread {spread_cents:.0f}c is over 5c.", None
    if volume_usd is None:
        return None, f"Spread {spread_cents:.0f}c but volume unknown.", "volume missing"
    if volume_usd >= 1000 and spread_cents <= 2 and not some_strikes_unquoted:
        return 1, f"Volume ${volume_usd} with a {spread_cents:.0f}c spread.", None
    return 2, f"Volume ${volume_usd}, spread {spread_cents:.0f}c.", None


def rate(scores: Scores) -> OverallRating:
    cats: dict[str, CategoryScore] = {
        "ambiguity": scores.ambiguity,
        "source": scores.source,
        "liquidity": scores.liquidity,
        "correlation": scores.correlation,
    }
    known = {k: v.score for k, v in cats.items() if v.score is not None}
    missing = [k for k in cats if k not in known]
    known_total = sum(known.values())

    overrides: list[AppliedOverride] = []
    floor: Optional[Rating] = None
    for cat in ("ambiguity", "source"):
        if known.get(cat) == 3:
            floor = "Medium"
            overrides.append(AppliedOverride(
                rule="Any High (3) in Ambiguity or Source -> at least Medium",
                triggered_by=cat,
                effect="rating floor Medium; always seek evidence on the settlement rule",
            ))
    if known.get("liquidity") == 3:
        overrides.append(AppliedOverride(
            rule="High (3) in Liquidity -> never trade more than top-of-book",
            triggered_by="liquidity",
            effect="research translation: treat the quoted price as an unreliable signal; rating unchanged",
        ))

    if missing:
        lo = known_total + len(missing) * 1
        hi = known_total + len(missing) * 3
        return OverallRating(
            complete=False, known_total=known_total, raw_total=None, raw_rating=None,
            rating_floor=floor, final_rating=None,
            possible_range=(_max(band(lo), floor), _max(band(hi), floor)),
            overrides=overrides,
        )

    raw = band(known_total)
    return OverallRating(
        complete=True, known_total=known_total, raw_total=known_total, raw_rating=raw,
        rating_floor=floor, final_rating=_max(raw, floor), possible_range=None,
        overrides=overrides,
    )
