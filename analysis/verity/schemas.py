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
    evidence_type: str                 # copied from the catalog item; the payment service re-checks it
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
        empty = [k for k, v in self.catalog_parameters.items() if not v.strip()]
        if empty:
            raise ValueError(f"catalog parameters must not be empty: {', '.join(empty)}")
        return self


# --- Research and trends -------------------------------------------------------

DataLabel = Literal["FIXTURE", "CAPTURED", "LIVE"]


class ResolutionTerms(Strict):
    settlement_source: Optional[str]
    terms_url: Optional[str]
    terms_url_note: Optional[str]
    rule_excerpt_ids: list[str]


class MarketQuote(Strict):
    best_bid: Optional[str]
    best_ask: Optional[str]
    volume_usd: Optional[str]
    volume_basis: Literal["total", "24h", "unknown"]


class NormalizedMarket(Strict):
    """The Gemini Exchange market as one record: event, selected instrument, terms, and when it was read."""
    exchange: Literal["gemini"] = "gemini"
    contract_id: str
    event_ticker: Optional[str]
    ticker_status: str
    instrument_symbol: Optional[str]   # null means the snapshot did not record which instrument was priced
    outcome_label: str
    question: str
    expiry_utc: str
    resolution: ResolutionTerms
    observed_date: str
    observed_utc: Optional[str]        # null when only the date was recorded
    quote: MarketQuote
    source_mode: SourceMode
    source_label: str
    source_url: str
    unavailable: list[str]             # each field that is missing, with the reason


class CoverageItem(Strict):
    url: str
    title: str
    published_utc: str
    provider: Literal["exa"] = "exa"


class CoverageWindow(Strict):
    start_utc: str
    end_utc: str
    count: int
    samples: list[CoverageItem]


class CoverageTrend(Strict):
    """News coverage over time. This is not a market price trend."""
    status: Literal["available", "unavailable"]
    reason: Optional[str]
    data_label: Optional[DataLabel]
    query: Optional[str]
    captured_utc: Optional[str]
    recent: Optional[CoverageWindow]
    prior: Optional[CoverageWindow]
    undated_excluded: int
    direction: Optional[Literal["more_recent", "less_recent", "flat"]]
    caveat: Optional[str]


class PricePoint(Strict):
    instrument_symbol: str
    observed_utc: str
    mid: str


class PriceTrend(Strict):
    """Only reported from timestamped prices for one instrument; otherwise unavailable with a reason."""
    status: Literal["available", "unavailable"]
    reason: Optional[str]
    instrument_symbol: Optional[str]
    points: list[PricePoint]
    change: Optional[str]


class MarketResearchV1(Strict):
    version: Literal["verity-market-research-v1"] = "verity-market-research-v1"
    market: NormalizedMarket
    coverage: CoverageTrend
    price_trend: PriceTrend
    citations: list[CoverageItem]


# --- Reassessment after a verified delivery ------------------------------------

class EvidenceProvenance(Strict):
    """What the payment side proved before the bytes reached the analyst."""
    purchase_id: str
    contract_id: str
    evidence_gap_id: str
    catalog_item_id: str
    merchant_id: str
    request_hash: str
    content_hash_keccak256: str
    content_sha256: str
    receipt_digest: str
    receipt_signer: str
    tx_hash: Optional[str] = None      # direct rail: the settlement tx the receipt signs
    verified_by: Literal["verifyDelivery", "verifyGatewayDelivery"]
    data_label: DataLabel
    payment_rail: Literal["arc-eip3009", "circle-gateway-batched"] = "arc-eip3009"
    payment_ref: Optional[str] = None  # Gateway rail: Circle transfer ID the V2 receipt signs

    @model_validator(mode="after")
    def _rail_reference(self) -> "EvidenceProvenance":
        if self.payment_rail == "arc-eip3009" and (not self.tx_hash or self.verified_by != "verifyDelivery"):
            raise ValueError("direct-rail evidence needs tx_hash and verifyDelivery")
        if self.payment_rail == "circle-gateway-batched" and (not self.payment_ref or self.verified_by != "verifyGatewayDelivery"):
            raise ValueError("Gateway evidence needs payment_ref and verifyGatewayDelivery")
        return self


class FindingChange(Strict):
    finding: str
    before: Optional[str]
    after: Optional[str]
    changed: bool
    reason: str


class ReassessmentV1(Strict):
    version: Literal["verity-reassessment-v1"] = "verity-reassessment-v1"
    contract_id: str
    status: Literal["revised", "unchanged", "evidence_rejected"]
    reason: str
    provenance: Optional[EvidenceProvenance]
    evidence_citation: Optional[Citation]
    original: RiskAnalysisV1
    revised: RiskAnalysisV1
    changes: list[FindingChange]
