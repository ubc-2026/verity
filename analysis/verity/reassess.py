"""Reassess a risk analysis with evidence the payment side has already verified.

The analyst never sees bytes the buyer did not accept: the caller passes the
delivered bytes plus the provenance proved by `verifyDelivery` (merchant
signature, request binding, keccak256 content hash). This module re-hashes the
bytes with SHA-256 against that provenance, checks the evidence answers an open
gap for this contract with the parameters derived from the contract, and only
then changes findings. Every change, and every finding left as it was, is
listed with its reason.
"""
from __future__ import annotations

import hashlib
import json
from typing import Any, Callable, Literal, Optional

from pydantic import ValidationError

from .analysis import _ACTION
from .fixtures import FixtureContext, fmt_utc
from .proposals import _catalog_params
from .schemas import (
    CategoryScore,
    Citation,
    EvidenceGap,
    EvidenceProvenance,
    FindingChange,
    ReassessmentV1,
    RiskAnalysisV1,
    Scores,
    Strict,
)
from .scoring import rate


class SettlementVersionEvidence(Strict):
    """Document shape the settlement-version catalog item delivers."""
    label: Literal["FIXTURE", "LIVE"]
    source: str
    gap_type: Literal["settlement_source_version"]
    station: str
    date: str
    settling_issuance: str
    excludes: list[str]
    corrections_count: bool
    summary: str


def _strict_json(body: bytes) -> Any:
    def no_duplicates(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
        keys = [k for k, _ in pairs]
        if len(keys) != len(set(keys)):
            raise ValueError("duplicate JSON key in evidence")
        return dict(pairs)
    return json.loads(body.decode("utf-8"), object_pairs_hook=no_duplicates)


def _result(status: str, reason: str, original: RiskAnalysisV1, revised: Optional[RiskAnalysisV1] = None,
            prov: Optional[EvidenceProvenance] = None, citation: Optional[Citation] = None,
            changes: Optional[list[FindingChange]] = None) -> ReassessmentV1:
    return ReassessmentV1(contract_id=original.contract_id, status=status, reason=reason, provenance=prov,  # type: ignore[arg-type]
                          evidence_citation=citation, original=original, revised=revised or original,
                          changes=changes or [])


def _score(s: CategoryScore) -> Optional[str]:
    return None if s.score is None else str(s.score)


def _settlement_version(original: RiskAnalysisV1, gap: EvidenceGap, doc: Any, prov: EvidenceProvenance,
                        ctx: FixtureContext) -> ReassessmentV1:
    try:
        ev = SettlementVersionEvidence.model_validate(doc)
    except ValidationError as error:
        return _result("evidence_rejected", f"evidence does not match the settlement-version document shape: {error.errors()[0]['msg']}",
                       original, prov=prov)

    item = next((i for i in ctx.catalog.get("items", []) if i["id"] == prov.catalog_item_id), None)
    if item is None:
        return _result("evidence_rejected", f"catalog item {prov.catalog_item_id} is not in the allowlisted catalog", original, prov=prov)
    expected = _catalog_params(original, item)
    got = {"station": ev.station, "date": ev.date}
    if any(not v for v in expected.values()) or {k: got.get(k) for k in expected} != expected:
        return _result("evidence_rejected",
                       f"evidence is for {got}, but this contract needs {expected}; a document for other parameters does not answer the gap",
                       original, prov=prov)

    if not ev.settling_issuance.strip() or ev.settling_issuance.strip().lower() == "unknown":
        return _result("unchanged", f"the document does not name a settling issuance, so {gap.id} stays open", original, prov=prov)

    cid = f"{gap.id}-EV1"
    citation = Citation(
        id=cid,
        source=f"merchant {prov.merchant_id}, purchase {prov.purchase_id}, receipt {prov.receipt_digest}",
        field_or_rule=(
            f"{prov.data_label} evidence from catalog item {prov.catalog_item_id} "
            + (f"(DeliveryReceiptV1 verified, tx {prov.tx_hash})" if prov.payment_rail == "arc-eip3009"
               else f"(DeliveryReceiptV2 verified, Circle Gateway transfer {prov.payment_ref})")
        ),
        quote=ev.summary,
    )

    changes: list[FindingChange] = [FindingChange(
        finding=f"evidence_gaps.{gap.id}", before="open", after="closed", changed=True,
        reason=f"the receipt-verified document names the settling issuance: {ev.settling_issuance}",
    )]

    src = original.scores.source
    new_source = src
    if src.score == 2 and ev.corrections_count is False:
        new_source = CategoryScore(
            score=1,
            rationale=("Official NWS source. The purchased document names the issuance that settles "
                       f"({ev.settling_issuance}) and states that later corrections do not count, so a revision "
                       "can no longer change the outcome (Agent rule 9 no longer applies)."),
            citation_ids=[*src.citation_ids, cid],
        )
        changes.append(FindingChange(finding="scores.source", before="2", after="1", changed=True,
                                     reason="revision risk resolved: settling issuance named and corrections excluded"))
    else:
        why = ("later corrections can still change the settled value" if ev.corrections_count
               else f"the source score was {_score(src)}, not the revision-risk 2 this evidence addresses")
        changes.append(FindingChange(finding="scores.source", before=_score(src), after=_score(src), changed=False, reason=why))

    scores = Scores(ambiguity=original.scores.ambiguity, source=new_source,
                    liquidity=original.scores.liquidity, correlation=original.scores.correlation)
    rating = rate(scores)
    if rating.complete:
        action = _ACTION[rating.final_rating]  # type: ignore[index]
    else:
        action = "flag_for_human_review" if rating.possible_range[1] == "High" else "investigate"  # type: ignore[index]

    keep = [f"ambiguity {_score(scores.ambiguity)}", f"liquidity {_score(scores.liquidity)}", f"correlation {_score(scores.correlation)}"]
    changes.append(FindingChange(
        finding="rating.raw_total", before=str(original.rating.raw_total), after=str(rating.raw_total),
        changed=original.rating.raw_total != rating.raw_total, reason="sum of the four category scores",
    ))
    same_band = original.rating.final_rating == rating.final_rating
    changes.append(FindingChange(
        finding="rating.final_rating", before=original.rating.final_rating, after=rating.final_rating, changed=not same_band,
        reason=(f"total {rating.raw_total} is still in the {rating.final_rating} band; {', '.join(keep)} are unchanged by this evidence"
                if same_band else f"total moved from {original.rating.raw_total} to {rating.raw_total}"),
    ))
    changes.append(FindingChange(
        finding="research_action", before=original.research_action, after=action, changed=original.research_action != action,
        reason="follows the final rating",
    ))

    gaps = [g for g in original.evidence_gaps if g.id != gap.id]
    unresolved = [q for q in original.unresolved_questions if q != gap.question]
    label = rating.final_rating or "incomplete"
    summary = (f"{label} resolution risk (total {rating.raw_total}). Research action: {action}. "
               + (f"{len(unresolved)} open question(s)." if unresolved else "No open resolution questions.")
               + f" Reassessed with receipt-verified evidence for {gap.id}.")
    revised = original.model_copy(update={
        "analyzed_at_utc": fmt_utc(ctx.clock.now()),
        "scores": scores,
        "rating": rating,
        "research_action": action,
        "summary": summary,
        "citations": [*original.citations, citation],
        "evidence_gaps": gaps,
        "unresolved_questions": unresolved,
    })
    revised = RiskAnalysisV1.model_validate(revised.model_dump())
    any_change = any(c.changed for c in changes)
    return _result("revised" if any_change else "unchanged",
                   "evidence applied" if any_change else "evidence verified but no finding changed",
                   original, revised, prov, citation, changes)


HANDLERS: dict[str, Callable[[RiskAnalysisV1, EvidenceGap, Any, EvidenceProvenance, FixtureContext], ReassessmentV1]] = {
    "settlement_source_version": _settlement_version,
}


def reassess(original: RiskAnalysisV1, body: bytes, provenance: dict[str, Any],
             ctx: Optional[FixtureContext] = None) -> ReassessmentV1:
    ctx = ctx or FixtureContext.default()
    try:
        prov = EvidenceProvenance.model_validate(provenance)
    except ValidationError as error:
        return _result("evidence_rejected", f"provenance is incomplete: {error.errors()[0]['loc']}", original)
    digest = "0x" + hashlib.sha256(body).hexdigest()
    if digest != prov.content_sha256.lower():
        return _result("evidence_rejected", "the bytes differ from the delivery the buyer verified", original, prov=prov)
    if prov.contract_id != original.contract_id:
        return _result("evidence_rejected", f"evidence is for {prov.contract_id}, not {original.contract_id}", original, prov=prov)
    gap = next((g for g in original.evidence_gaps if g.id == prov.evidence_gap_id), None)
    if gap is None:
        return _result("evidence_rejected", f"{prov.evidence_gap_id} is not an open gap on this analysis", original, prov=prov)
    try:
        doc = _strict_json(body)
    except (ValueError, UnicodeDecodeError) as error:
        return _result("evidence_rejected", f"evidence is not strict UTF-8 JSON: {error}", original, prov=prov)
    handler = HANDLERS.get(gap.gap_type)
    if handler is None:
        return _result("unchanged", f"no reassessment rule for gap type {gap.gap_type!r}; findings left as they were",
                       original, prov=prov)
    return handler(original, gap, doc, prov, ctx)
