"""generate_purchase_request(risk_analysis) -> PurchaseProposalV1 | None.

Gates, in order (every rejection is logged with its reason):
  1. The analysis has a confirmed ticker (unconfirmed markets cannot be bought for).
  2. The market is at least 1 hour from expiry on the fixture clock (Agent rule 11).
  3. The Excel Framework action is Investigate (Medium). Avoid/High and Trade
     normally/Low do not buy; research buys follow Investigate.
  4. Per material gap that affects *resolution* risk:
       a. no cached evidence already answers it,
       b. the free official-source check does not answer it,
       c. an allowlisted catalog item answers that gap type.
  Outcome-probability gaps (forecasts) are skipped: Verity is research-only and
  buys evidence about how a contract settles, not about what will happen.

The proposal is unsigned. The payment service owns policy, reservation and signing.
"""
from __future__ import annotations

import hashlib
import logging
import re
from datetime import datetime, timedelta
from decimal import Decimal
from typing import Any, Optional

from .fixtures import FixtureContext, fmt_utc, parse_utc
from .research import SFO_CHECK, ResearchResult, research_free_check, research_gap
from .schemas import PurchaseProposalV1, RiskAnalysisV1

log = logging.getLogger("verity.decisions")
MIN_TIME_TO_EXPIRY = timedelta(hours=1)


def _record(decision_log: Optional[list[str]], msg: str) -> None:
    log.info(msg)
    if decision_log is not None:
        decision_log.append(msg)


def _catalog_match(ctx: FixtureContext, ra: RiskAnalysisV1, gap_type: str) -> Optional[dict[str, Any]]:
    """Prefer a family SKU, else first allowlisted item on the requested payment rail."""
    allow = set(ctx.catalog["merchant_allowlist"])
    matches: list[dict[str, Any]] = []
    for item in ctx.catalog["items"]:
        live_contract = item.get("live_contract_id")
        if ra.snapshot.source_mode == "live" and live_contract != ra.contract_id:
            continue
        if ra.snapshot.source_mode != "live" and live_contract is not None:
            continue
        if (gap_type in item["answers_gap_types"] and item["affects"] == "resolution_risk"
                and item["merchant_id"] in allow and item.get("rail", "arc-eip3009") == ctx.payment_rail):
            matches.append(item)
    if not matches:
        return None
    preferred = _preferred_catalog_id(ra.event_ticker)
    if preferred:
        for item in matches:
            if item["id"] == preferred:
                return item
    return matches[0]


def _research_line(contract_id: str, gap_id: str, found: ResearchResult) -> str:
    sources = ", ".join(found.sources) if found.sources else "no url"
    excerpt = f" Excerpt: {found.excerpts[0][:160]}" if found.excerpts else ""
    return (f"[{contract_id}] {gap_id}: free research {found.status}. {found.conclusion} "
            f"Sources: {sources}.{excerpt}")


def _proposal_rationale(question: str, why: str, title: str, research_note: Optional[str]) -> str:
    if research_note:
        return (f"{question} {why} Free research left it open: {research_note} "
                f"Catalog item '{title}' answers exactly this gap type.")
    return (f"{question} {why} No cached or free official source answered it, "
            f"and catalog item '{title}' answers exactly this gap type.")


def _emit_proposal(
    decision_log: Optional[list[str]],
    ra: RiskAnalysisV1,
    gap: Any,
    item: dict[str, Any],
    ctx: FixtureContext,
    now: Any,
    research_note: Optional[str],
) -> Optional[PurchaseProposalV1]:
    params = _catalog_params(ra, item)
    missing = [name for name, value in params.items() if not value]
    if missing:
        _record(decision_log, f"[{ra.contract_id}] skip {gap.id}: catalog item {item['id']} needs {', '.join(missing)}, which this market does not supply; no proposal with blank parameters.")
        return None
    created = fmt_utc(now)
    proposal = PurchaseProposalV1(
        proposal_id="prop-" + hashlib.sha256(f"{ra.contract_id}|{gap.id}|{item['id']}|{created}".encode()).hexdigest()[:12],
        contract_id=ra.contract_id,
        evidence_gap_id=gap.id,
        catalog_item_id=item["id"],
        evidence_type=item["evidence_type"],
        catalog_parameters=params,
        rationale=_proposal_rationale(gap.question, gap.why, item["title"], research_note),
        max_amount_base_units=item["price_base_units"],
        fixture_label=_free_check_label(ctx.free_check_scenario, next(
            (ctx.free_checks[c]["scenarios"].get(ctx.free_check_scenario or "")
             for c in gap.free_checks if c in ctx.free_checks), None)),
        created_at_utc=created,
    )
    price = Decimal(item["price_base_units"]) / 1_000_000
    _record(decision_log, f"[{ra.contract_id}] PROPOSE {item['id']} for {gap.id}: max {item['price_base_units']} base units (= {price:f} USDC), unsigned.")
    return proposal


_WEATHER_HIGH_TICKER = re.compile(r"WXHIGH-(NYC|SFO|CHI|ATL|BOS)-(\d{10})")
_WEATHER_STATIONS = {
    "NYC": ("Central Park, NY (CLINYC)", 5),
    "SFO": ("San Francisco Airport, CA (CLISFO)", 8),
    "CHI": ("Chicago-Midway, IL (CLIMDW)", 6),
    "ATL": ("Atlanta, GA (CLIATL)", 5),
    "BOS": ("Boston, MA (CLIBOS)", 5),
}
_SPORTS_PREFIXES = (
    "NBA-", "NFL-", "NHL-", "MLB-", "NCAAM-", "NCAAF-", "NCAA-", "MLS-",
    "UCL-", "LIGAMX-", "EPL-", "ATP-", "WTA-", "UFC-", "F1-",
)
_COMMODITY_PREFIXES = ("BRENT", "WTI", "XAG", "XAU", "NGAS", "OIL", "COPPER", "CORN", "SOY", "WHEAT")
_CRYPTO_PREFIXES = ("BTC", "ETH", "SOL", "XRP", "DOGE", "ADA", "AVAX")


def _weather_market_params(event_ticker: Optional[str]) -> dict[str, str]:
    match = _WEATHER_HIGH_TICKER.fullmatch(event_ticker or "")
    if not match:
        return {}
    city, ticker_time = match.groups()
    station, offset = _WEATHER_STATIONS[city]
    # The ticker ends in a UTC close time during the station's climate day.
    try:
        close = datetime.strptime(ticker_time, "%y%m%d%H%M")
    except ValueError:
        return {}
    return {"station": station, "date": (close - timedelta(hours=offset)).date().isoformat()}


def _preferred_catalog_id(event_ticker: Optional[str]) -> Optional[str]:
    if not event_ticker:
        return None
    if event_ticker.startswith("WXHIGH-CHI"):
        return "cat-midway-vs-title-station-pack-v1"
    if event_ticker.startswith("WXHIGH-"):
        return "cat-nws-cli-settlement-version-v1"
    if any(event_ticker.startswith(p) for p in _SPORTS_PREFIXES):
        return "cat-sports-settlement-version-v1"
    if any(event_ticker.startswith(p) for p in _COMMODITY_PREFIXES):
        return "cat-commodity-settlement-version-v1"
    if any(event_ticker.startswith(p) for p in _CRYPTO_PREFIXES):
        return "cat-crypto-settlement-version-v1"
    return None


def _catalog_params(ra: RiskAnalysisV1, item: dict[str, Any]) -> dict[str, str]:
    """Parameters for the catalog item, taken from this market. A blank value means unknown."""
    ticker = ra.event_ticker or ""
    known = _weather_market_params(ticker)
    date = known.get("date") or ((ra.quoted_price.observed_date if ra.quoted_price else None) or "")
    if any(ticker.startswith(p) for p in _SPORTS_PREFIXES):
        known = {
            "league": ticker.split("-", 1)[0],
            "provider": "sports data provider",
            "event": ticker,
        }
    elif any(ticker.startswith(p) for p in _COMMODITY_PREFIXES):
        known = {"index": ticker.split("26", 1)[0], "provider": "commodity index", "date": date}
    elif any(ticker.startswith(p) for p in _CRYPTO_PREFIXES):
        known = {"asset": ticker[:3], "provider": "crypto reference rate", "date": date}
    return {p: known.get(p, "") for p in item["parameters"]}


def _free_check_label(scenario: Optional[str], res: Optional[dict[str, Any]]) -> Optional[str]:
    if not scenario:
        return None
    if res is not None and res.get("fixture_assumption") is False:
        return f"OBSERVED: free-check scenario '{scenario}' read from the official sources at {res.get('observed_utc')}"
    return f"FIXTURE: free-check scenario '{scenario}' (assumed, not observed)"


def generate_purchase_request(
    risk_analysis: RiskAnalysisV1,
    ctx: Optional[FixtureContext] = None,
    decision_log: Optional[list[str]] = None,
) -> Optional[PurchaseProposalV1]:
    ctx = ctx or FixtureContext.default()
    ra = risk_analysis
    now = ctx.clock.now()

    if ra.event_ticker is None:
        _record(decision_log, f"[{ra.contract_id}] no purchase: ticker not confirmed, so the evidence need cannot be validated against the live market.")
        return None

    left = parse_utc(ra.expiry_utc) - now
    if left < MIN_TIME_TO_EXPIRY:
        _record(decision_log, f"[{ra.contract_id}] no purchase: {left} to expiry is under 1h (Agent rule 11).")
        return None

    # Excel Framework: buy research on Investigate (Medium). Avoid (High) does not buy.
    if ra.rating.final_rating != "Medium" and ra.research_action != "investigate":
        label = ra.rating.final_rating or "incomplete"
        _record(
            decision_log,
            f"[{ra.contract_id}] no purchase: rating is {label} (Excel action needs Investigate); "
            f"research buys follow the Excel Investigate path.",
        )
        return None

    material = [g for g in ra.evidence_gaps if g.material and g.affects == "resolution_risk"]
    for g in ra.evidence_gaps:
        if g.affects == "outcome_probability":
            _record(decision_log, f"[{ra.contract_id}] skip {g.id}: outcome forecast changes event probability, not settlement risk; research-only, no trades.")
    if not material:
        _record(decision_log, f"[{ra.contract_id}] no purchase: no material resolution gap (research action: {ra.research_action}).")
        return None

    complete_json = ctx.complete_json if ctx.free_check_scenario is None else None
    for g in material:
        cached = ctx.cached_evidence.get((ra.contract_id, g.id))
        if cached:
            _record(decision_log, f"[{ra.contract_id}] skip {g.id}: cached evidence already answers it ({cached}).")
            continue

        if not g.free_checks and complete_json is None:
            _record(decision_log, f"[{ra.contract_id}] skip {g.id}: no free official-source check is configured for this gap, so free evidence was not ruled out.")
            continue

        answered = False
        research_note: Optional[str] = None
        skip_gap = False
        needs_issuance_confirmation = False
        for check_id in g.free_checks:
            if complete_json is not None and not (ctx.live_research and check_id == SFO_CHECK):
                continue
            if ctx.live_research and ctx.free_check_scenario is None:
                market = ctx.markets.get(ra.contract_id) or {}
                found = research_free_check(
                    check_id,
                    question=g.question,
                    terms_url=market.get("terms_url"),
                    fetch_text=ctx.fetch_text,
                    contract_text=next((c.quote for c in ra.citations if c.id == "C-CONTRACT"), ""),
                    market_date=_weather_market_params(ra.event_ticker).get("date") if check_id == SFO_CHECK else None,
                )
                _record(decision_log, _research_line(ra.contract_id, g.id, found))
                if found.status == "failed":
                    _record(decision_log, f"[{ra.contract_id}] no purchase: free research failed, so the gap was not validated.")
                    return None
                if found.status == "not_configured":
                    _record(decision_log, f"[{ra.contract_id}] skip {g.id}: no free official-source check is configured for this gap, so free evidence was not ruled out.")
                    skip_gap = True
                    break
                if found.resolved:
                    answered = True
                    break
                research_note = found.conclusion
                needs_issuance_confirmation |= found.needs_issuance_confirmation
                continue

            check = ctx.free_checks.get(check_id)
            if check is None:
                _record(decision_log, f"[{ra.contract_id}] {g.id}: free check {check_id!r} not configured.")
                continue
            scenario = ctx.free_check_scenario
            if scenario is None or scenario not in check["scenarios"]:
                _record(decision_log, f"[{ra.contract_id}] {g.id}: free check {check_id!r} has no result for scenario {scenario!r}; cannot validate the gap, so no purchase.")
                return None
            res = check["scenarios"][scenario]
            _record(decision_log, f"[{ra.contract_id}] {g.id}: free official-source check ({', '.join(check['sources'])}) -> {res['result']}. {res['finding']}")
            if res["result"] == "answered":
                answered = True
                break
        if skip_gap:
            continue
        if answered:
            _record(decision_log, f"[{ra.contract_id}] skip {g.id}: answered by the free check; nothing to buy.")
            continue

        if complete_json is not None and not needs_issuance_confirmation:
            market = ctx.markets.get(ra.contract_id) or {}
            found = research_gap(
                ra, g,
                terms_url=market.get("terms_url"),
                fetch_text=ctx.fetch_text,
                complete_json=complete_json,
            )
            _record(decision_log, _research_line(ra.contract_id, g.id, found))
            if found.status == "failed":
                _record(decision_log, f"[{ra.contract_id}] no purchase: model research failed, so the gap was not validated.")
                return None
            if found.resolved:
                _record(decision_log, f"[{ra.contract_id}] skip {g.id}: the model read resolved it; nothing to buy.")
                continue
            research_note = found.conclusion

        item = _catalog_match(ctx, ra, g.gap_type)
        if item is None:
            qualified = " for this live contract" if ra.snapshot.source_mode == "live" else ""
            _record(decision_log, f"[{ra.contract_id}] skip {g.id}: no allowlisted catalog item answers gap type {g.gap_type!r}{qualified}.")
            continue

        proposal = _emit_proposal(decision_log, ra, g, item, ctx, now, research_note)
        if proposal is None:
            continue
        return proposal

    _record(decision_log, f"[{ra.contract_id}] no purchase: every material gap was answered, cached, or had no catalog match.")
    return None
