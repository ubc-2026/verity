"""Research and trends: the normalized market, news coverage over time, and price movement.

Coverage and price are kept apart. Coverage counts dated search results in a
recent window and the window before it. Price movement is reported only from
timestamped prices for the same instrument. Anything missing is returned as
`unavailable` with the reason, never filled in.
"""
from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from pathlib import Path
from typing import Any, Callable, Optional

from .fixtures import fmt_utc, parse_utc
from .schemas import (
    CoverageItem,
    CoverageTrend,
    CoverageWindow,
    MarketQuote,
    MarketResearchV1,
    NormalizedMarket,
    PricePoint,
    PriceTrend,
    ResolutionTerms,
)

FIXTURES = Path(__file__).resolve().parent.parent / "fixtures"
EXA_SEARCH_URL = "https://api.exa.ai/search"
COVERAGE_WINDOW = timedelta(days=7)
MAX_SAMPLES = 3


def normalize_market(m: dict[str, Any]) -> NormalizedMarket:
    src = m["source"]
    mk = m.get("market") or {}
    unavailable: list[str] = []
    if m.get("instrument_symbol") is None:
        unavailable.append("instrument_symbol: the snapshot did not record which instrument was priced")
    if src.get("snapshot_time_utc") is None:
        unavailable.append(f"observed_utc: only the date {src['snapshot_date']} was recorded")
    if not m.get("event_terms_url_present", True):
        unavailable.append("event terms link: empty on the event; terms_url comes from the contract rules")
    if m.get("ticker_status") != "confirmed":
        unavailable.append("event_ticker: not confirmed against Gemini")
    return NormalizedMarket(
        contract_id=m["contract_id"],
        event_ticker=m.get("event_ticker"),
        ticker_status=m.get("ticker_status", "unknown"),
        instrument_symbol=m.get("instrument_symbol"),
        outcome_label=m["outcome_label"],
        question=m["question"],
        expiry_utc=m["expiry_utc"],
        resolution=ResolutionTerms(
            settlement_source=m.get("settlement_source"),
            terms_url=m.get("terms_url") or None,
            terms_url_note=m.get("terms_url_note"),
            rule_excerpt_ids=[e["id"] for e in m.get("rules_excerpts", [])],
        ),
        observed_date=src["snapshot_date"],
        observed_utc=src.get("snapshot_time_utc"),
        quote=MarketQuote(
            best_bid=mk.get("best_bid"),
            best_ask=mk.get("best_ask"),
            volume_usd=mk.get("volume_usd"),
            volume_basis=mk.get("volume_basis") or "unknown",
        ),
        source_mode=src["mode"],
        source_label=src["label"],
        source_url=src["url"],
        unavailable=unavailable,
    )


def _unavailable_coverage(reason: str) -> CoverageTrend:
    return CoverageTrend(status="unavailable", reason=reason, data_label=None, query=None, captured_utc=None,
                         recent=None, prior=None, undated_excluded=0, direction=None, caveat=None)


def coverage_trend(sample: Optional[dict[str, Any]], as_of: datetime) -> CoverageTrend:
    """Recent window = the 7 days before `as_of`; prior window = the 7 days before that."""
    if not sample:
        return _unavailable_coverage(
            "no coverage sample for this contract (none recorded, and live Exa search is not configured)")
    recent_start, prior_start = as_of - COVERAGE_WINDOW, as_of - 2 * COVERAGE_WINDOW
    recent: list[CoverageItem] = []
    prior: list[CoverageItem] = []
    undated = 0
    for r in sample["results"]:
        if not r.get("published_utc"):
            undated += 1
            continue
        item = CoverageItem(url=r["url"], title=r["title"], published_utc=r["published_utc"])
        published = parse_utc(r["published_utc"])
        if recent_start <= published < as_of:
            recent.append(item)
        elif prior_start <= published < recent_start:
            prior.append(item)
    recent.sort(key=lambda i: i.published_utc, reverse=True)
    prior.sort(key=lambda i: i.published_utc, reverse=True)
    if len(recent) == len(prior):
        direction = "flat"
    else:
        direction = "more_recent" if len(recent) > len(prior) else "less_recent"
    return CoverageTrend(
        status="available",
        reason=None,
        data_label=sample["data_label"],
        query=sample["query"],
        captured_utc=sample.get("captured_utc"),
        recent=CoverageWindow(start_utc=fmt_utc(recent_start), end_utc=fmt_utc(as_of), count=len(recent),
                              samples=recent[:MAX_SAMPLES]),
        prior=CoverageWindow(start_utc=fmt_utc(prior_start), end_utc=fmt_utc(recent_start), count=len(prior),
                             samples=prior[:MAX_SAMPLES]),
        undated_excluded=undated,
        direction=direction,
        caveat=(f"Counts come from one ranked search of {len(sample['results'])} results, not total coverage, "
                "and search ranking favors recent pages. This is a coverage trend, not a price trend."),
    )


def price_trend(market: NormalizedMarket, history: list[dict[str, Any]]) -> PriceTrend:
    """Movement needs two or more timestamped mid prices for the market's own instrument."""
    symbol = market.instrument_symbol
    if symbol is None:
        return PriceTrend(status="unavailable",
                          reason="instrument symbol not recorded, so prices cannot be tied to one instrument",
                          instrument_symbol=None, points=[], change=None)
    points = sorted(
        (PricePoint(instrument_symbol=p["instrument_symbol"], observed_utc=p["observed_utc"], mid=str(p["mid"]))
         for p in history
         if p.get("instrument_symbol") == symbol and p.get("observed_utc") and p.get("mid") is not None),
        key=lambda p: p.observed_utc,
    )
    if len(points) < 2:
        return PriceTrend(status="unavailable",
                          reason=f"{len(points)} timestamped price(s) for {symbol}; movement needs at least 2",
                          instrument_symbol=symbol, points=points, change=None)
    change = Decimal(points[-1].mid) - Decimal(points[0].mid)
    return PriceTrend(status="available", reason=None, instrument_symbol=symbol, points=points, change=f"{change:+}")


def load_coverage_samples() -> dict[str, Any]:
    return json.loads((FIXTURES / "exa_coverage.json").read_text(encoding="utf-8"))["contracts"]


def research_market(m: dict[str, Any], as_of: datetime, coverage: Optional[dict[str, Any]] = None,
                    price_history: Optional[list[dict[str, Any]]] = None) -> MarketResearchV1:
    market = normalize_market(m)
    samples = load_coverage_samples() if coverage is None else coverage
    cov = coverage_trend(samples.get(m["contract_id"]), as_of)
    citations = (cov.recent.samples + cov.prior.samples) if cov.recent and cov.prior else []
    return MarketResearchV1(
        market=market,
        coverage=cov,
        price_trend=price_trend(market, price_history or []),
        citations=citations,
    )


# --- Live Exa search. The fixture workflow does not call it. ----------------------------

PostJson = Callable[[str, dict[str, Any], dict[str, str], float], dict[str, Any]]


def exa_coverage_sample(query: str, as_of: datetime, api_key: str, post: PostJson) -> dict[str, Any]:
    """One Exa search covering both windows. `post` and the key are injected; nothing is read from the environment."""
    body = {
        "query": query,
        "numResults": 25,
        "startPublishedDate": fmt_utc(as_of - 2 * COVERAGE_WINDOW),
        "endPublishedDate": fmt_utc(as_of),
    }
    response = post(EXA_SEARCH_URL, body, {"x-api-key": api_key, "content-type": "application/json"}, 10.0)
    results = []
    for r in response.get("results", []):
        published = r.get("publishedDate")
        results.append({
            "title": str(r.get("title") or r["url"]),
            "url": str(r["url"]),
            "published_utc": fmt_utc(parse_utc(published.replace(".000Z", "Z"))) if published else None,
        })
    return {"data_label": "LIVE", "captured_utc": fmt_utc(datetime.now(timezone.utc)), "query": query, "results": results}
