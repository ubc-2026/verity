"""Versioned contracts shared by the analyst, decision engine and payment service.

Every model forbids unknown fields, so a schema drift fails loudly instead of
silently passing bad data downstream.
"""
from __future__ import annotations

from typing import Literal, Optional

from pydantic import BaseModel, ConfigDict, Field, model_validator

Score = Literal[1, 2, 3]
Rating = Literal["Low", "Medium", "High"]
ResearchAction = Literal["no_further_research", "investigate", "flag_for_human_review"]
Category = Literal["ambiguity", "source", "liquidity", "correlation"]
SourceMode = Literal["fixture", "live"]


class Strict(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)


class CategoryScore(Strict):
    """One 1-3 score, or null with a reason when data is missing or not applicable."""

    score: Optional[Score]
    rationale: str
    null_reason: Optional[str] = None
    citation_ids: list[str] = Field(default_factory=list)

    @model_validator(mode="after")
    def _null_needs_reason(self) -> "CategoryScore":
        if self.score is None and not self.null_reason:
            raise ValueError("a null score must carry null_reason")
        if self.score is not None and self.null_reason:
            raise ValueError("null_reason is only allowed when score is null")
        return self


class Scores(Strict):
    ambiguity: CategoryScore
    source: CategoryScore
    liquidity: CategoryScore
    correlation: CategoryScore


class AppliedOverride(Strict):
    rule: str
    triggered_by: Category
    effect: str


class OverallRating(Strict):
    """Raw total and override-adjusted rating are kept apart on purpose."""

    complete: bool
    known_total: int
    raw_total: Optional[int]           # null unless all four scores are known
    raw_rating: Optional[Rating]       # straight from the 4-6 / 7-8 / 9-12 bands
    rating_floor: Optional[Rating]     # from overrides, applied separately
    final_rating: Optional[Rating]     # max(raw_rating, rating_floor) when complete
    possible_range: Optional[tuple[Rating, Rating]]  # bounds when incomplete
    overrides: list[AppliedOverride]


class QuotedPrice(Strict):
    """Market price, deliberately outside the risk scores."""

    outcome_label: str
    best_bid: Optional[str]
    best_ask: Optional[str]
    mid: Optional[str]
    implied_probability: Optional[str]
    volume_usd: Optional[str]
    volume_basis: Literal["total", "24h", "unknown"]
    observed_date: str
    observed_time_utc: Optional[str]


class Citation(Strict):
    id: str
    source: str
    field_or_rule: str
    quote: str


class EvidenceGap(Strict):
    id: str
    question: str
    gap_type: str
    affects: Literal["resolution_risk", "outcome_probability"]
    material: bool
    why: str
    free_checks: list[str]


class Snapshot(Strict):
    source_mode: SourceMode
    source_label: str
    snapshot_date: str
    snapshot_time_utc: Optional[str]
    snapshot_hash: str                 # sha256 of the canonical fixture record
    hash_alg: Literal["sha256"] = "sha256"


class RiskAnalysisV1(Strict):
    version: Literal["verity-risk-analysis-v1"] = "verity-risk-analysis-v1"
    contract_id: str
    event_ticker: Optional[str]
    instrument_symbol: Optional[str]
    question: str
    expiry_utc: str
    analyzed_at_utc: str
    snapshot: Snapshot
    quoted_price: QuotedPrice
    scores: Scores
    rating: OverallRating
    research_action: ResearchAction
    summary: str
    citations: list[Citation]
    evidence_gaps: list[EvidenceGap]
    unresolved_questions: list[str]
    data_quality_flags: list[str]
    workbook_conflicts: list[str]


class PurchaseProposalV1(Strict):
    """Unsigned. The payment service derives URL, recipient, asset and network
    from the allowlisted catalog; nothing here authorizes a payment."""

    version: Literal["verity-purchase-proposal-v1"] = "verity-purchase-proposal-v1"
    proposal_id: str
    contract_id: str
    evidence_gap_id: str
    catalog_item_id: str
    catalog_parameters: dict[str, str]
    rationale: str
    max_amount_base_units: str         # integer USDC base units as a decimal string
    asset: Literal["USDC"] = "USDC"
    network_label: Literal["arc-testnet"] = "arc-testnet"
    fixture_label: Optional[str]
    signed: Literal[False] = False
    created_at_utc: str

    @model_validator(mode="after")
    def _integer_amount(self) -> "PurchaseProposalV1":
        if not self.max_amount_base_units.isdigit() or int(self.max_amount_base_units) <= 0:
            raise ValueError("max_amount_base_units must be a positive integer string")
        return self
