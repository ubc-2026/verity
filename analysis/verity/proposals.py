"""generate_purchase_request(risk_analysis) -> PurchaseProposalV1 | None.

Gates, in order (every rejection is logged with its reason):
  1. The analysis has a confirmed ticker (unconfirmed markets cannot be bought for).
  2. The market is at least 1 hour from expiry on the fixture clock (Agent rule 11).
  3. Per material gap that affects *resolution* risk:
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
from datetime import timedelta
from typing import Any, Optional

from .fixtures import FixtureContext, fmt_utc, parse_utc
from .schemas import PurchaseProposalV1, RiskAnalysisV1

log = logging.getLogger("verity.decisions")
MIN_TIME_TO_EXPIRY = timedelta(hours=1)


def _record(decision_log: Optional[list[str]], msg: str) -> None:
    log.info(msg)
    if decision_log is not None:
        decision_log.append(msg)


def _catalog_match(ctx: FixtureContext, gap_type: str) -> Optional[dict[str, Any]]:
    allow = set(ctx.catalog["merchant_allowlist"])
    for item in ctx.catalog["items"]:
        if (gap_type in item["answers_gap_types"] and item["affects"] == "resolution_risk"
                and item["merchant_id"] in allow):
            return item
    return None


def _catalog_params(ra: RiskAnalysisV1, item: dict[str, Any]) -> dict[str, str]:
    # Fixture mapping for the NWS item; other items take their params from the contract.
    known = {"station": "Central Park, NY (CLINYC)", "date": "2026-11-18"} if ra.event_ticker and ra.event_ticker.startswith("WXHIGH-NYC") else {}
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

    material = [g for g in ra.evidence_gaps if g.material and g.affects == "resolution_risk"]
    for g in ra.evidence_gaps:
        if g.affects == "outcome_probability":
            _record(decision_log, f"[{ra.contract_id}] skip {g.id}: outcome forecast changes event probability, not settlement risk; research-only, no trades.")
    if not material:
        _record(decision_log, f"[{ra.contract_id}] no purchase: no material resolution gap (research action: {ra.research_action}).")
        return None

    for g in material:
        cached = ctx.cached_evidence.get((ra.contract_id, g.id))
        if cached:
            _record(decision_log, f"[{ra.contract_id}] skip {g.id}: cached evidence already answers it ({cached}).")
            continue

        if not g.free_checks:
            _record(decision_log, f"[{ra.contract_id}] skip {g.id}: no free official-source check is configured for this gap, so free evidence was not ruled out.")
            continue

        answered = False
        res: Optional[dict[str, Any]] = None
        for check_id in g.free_checks:
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
        if answered:
            _record(decision_log, f"[{ra.contract_id}] skip {g.id}: answered by the free check; nothing to buy.")
            continue

        item = _catalog_match(ctx, g.gap_type)
        if item is None:
            _record(decision_log, f"[{ra.contract_id}] skip {g.id}: no allowlisted catalog item answers gap type {g.gap_type!r}.")
            continue

        created = fmt_utc(now)
        pid = "prop-" + hashlib.sha256(f"{ra.contract_id}|{g.id}|{item['id']}|{created}".encode()).hexdigest()[:12]
        proposal = PurchaseProposalV1(
            proposal_id=pid,
            contract_id=ra.contract_id,
            evidence_gap_id=g.id,
            catalog_item_id=item["id"],
            catalog_parameters=_catalog_params(ra, item),
            rationale=f"{g.question} {g.why} No cached or free official source answered it, and catalog item '{item['title']}' answers exactly this gap type.",
            max_amount_base_units=item["price_base_units"],
            fixture_label=_free_check_label(ctx.free_check_scenario, res),
            created_at_utc=created,
        )
        _record(decision_log, f"[{ra.contract_id}] PROPOSE {item['id']} for {g.id}: max {item['price_base_units']} base units (= {int(item['price_base_units']) / 1_000_000:.2f} USDC), unsigned.")
        return proposal

    _record(decision_log, f"[{ra.contract_id}] no purchase: every material gap was answered, cached, or had no catalog match.")
    return None
