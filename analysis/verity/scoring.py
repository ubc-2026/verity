"""Workbook rubric (Framework sheet), 1-3 per category.

Bands, from the workbook: total 4-6 Low, 7-8 Medium, 9-12 High.
Overrides, applied separately from the raw total:
  * Any 3 in Ambiguity or Source  -> rating is at least Medium.
  * 3 in Correlation              -> rating is at least High (overlapping
    markets can flip together; raw totals of 8 otherwise stall at Medium).
  * 3 in Liquidity                -> trading rule ("never trade more than
    top-of-book"). Verity places no trades, so it is translated into a research
    note: the quoted price is unreliable as a signal. It does not move the rating.

READING_RUBRIC is the checklist for ambiguity, source, and correlation.
Those three are stored on each fixture. Liquidity is computed by liquidity_score.
"""
from __future__ import annotations

from decimal import Decimal
from typing import Optional

from .schemas import AppliedOverride, CategoryScore, OverallRating, Rating, Scores

_ORDER: dict[Rating, int] = {"Low": 0, "Medium": 1, "High": 2}

# Checklist for the three scores a person writes. Liquidity is not in this list.
READING_RUBRIC = """
Ambiguity: could two careful readers disagree on the outcome?
  1: The outcome, the measurement, the cutoff, and the tie rule are all explicit.
     A game winner, or a price at 5pm ET.
  2: The outcome is clear, but a rule is missing or hard to find.
     A missing cutoff or time zone, a missing rounding rule, a missing tie rule,
     a band edge, or an empty event terms link. An empty terms link is at least 2.
     A missing cancellation or postponement rule is a 2.
  3: The outcome depends on a judgment, a name, or a setting.
     "Top-ranked", a leaderboard toggle, or company versus model.
     The exchange may set the payout itself, for example after a cancellation.
  A conflict between the contract wording and the settlement source is recorded
  on the snapshot. It is not also scored here.

Source: is the settlement source official, stable, and checkable?
  1: An official primary source with named fallbacks.
     A league, the Federal Reserve, or a stated price index.
  2: Official, but preliminary, revisable, or delayed.
     An NWS daily report, or economic data that is revised.
  3: A third-party ranking that changes continuously or can be gamed.
     LM Arena, or a social metric.
  null: No settlement source is named. Do not guess a score.

Correlation: do other contracts overlap this one? This is not a portfolio score.
  1: The outcome stands alone. Routine news does not count.
     Sibling buckets of the same question, such as other temperature bands, stay 1.
     News that moves the price but not the settlement rule stays 1.
  2: Scheduled data or named news drives the settlement.
     CPI, jobs, Fed speakers, or injury reports.
  3: The contract overlaps other markets, or one announcement can flip several.
     A spread plus a moneyline plus a total, or a model launch that changes who is number one.
""".strip()


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


def _volume_phrase(volume_usd: Decimal, volume_basis: Optional[str]) -> str:
    """Name the volume window. total and 24h are not converted into each other."""
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
    """How reliable the quoted price is. Returns (score, rationale, null_reason).

    null: no bid, no ask, and no volume. Or both prices are present and volume is missing.
    3: either price is missing, volume is under $100, or the spread is over 5c.
    1: volume is at least $1000, the spread is at most 2c, and every strike has a bid.
    2: any other two-sided quote.
    """
    volume = _volume_phrase(volume_usd, volume_basis) if volume_usd is not None else None

    if volume_usd is None and best_bid is None and best_ask is None:
        return None, "No volume or quotes in the snapshot.", "market data missing"
    if best_bid is None or best_ask is None:
        note = f" {volume} is on file." if volume else ""
        return 3, f"No two-sided quote.{note}", None

    spread_cents = (best_ask - best_bid) * 100
    spread = f"{spread_cents:.0f}c spread"
    if volume_usd is not None and volume_usd < 100:
        return 3, f"{volume} is under $100 ({spread}).", None
    if spread_cents > 5:
        return 3, f"{spread} is over 5c.", None
    if volume_usd is None:
        return None, f"{spread}, but volume is missing.", "volume missing"
    if volume_usd >= 1000 and spread_cents <= 2 and some_strikes_unquoted:
        return 2, f"{volume}, {spread}, but some strikes have no bid.", None
    if volume_usd >= 1000 and spread_cents <= 2:
        return 1, f"{volume} with a {spread}.", None
    return 2, f"{volume}, {spread}.", None


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
    if known.get("correlation") == 3:
        floor = _max("High", floor)
        overrides.append(AppliedOverride(
            rule="High (3) in Correlation -> at least High",
            triggered_by="correlation",
            effect="rating floor High; overlapping markets can flip together",
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
