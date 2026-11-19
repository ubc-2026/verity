import pytest
from pydantic import ValidationError

from verity import FixedClock, FixtureContext, generate_purchase_request, get_risk_analysis
from verity.schemas import CategoryScore, PurchaseProposalV1, Scores
from verity.scoring import READING_RUBRIC, band, liquidity_score, rate
from decimal import Decimal

OKC = "fx-okc-moneyline-20261118"
NYC = "fx-nyc-high-20261118"


def ctx(**kw):
    return FixtureContext.default(**kw)


def _with_high_rating(ra):
    return ra.model_copy(update={
        "rating": ra.rating.model_copy(update={
            "final_rating": "High", "raw_rating": "High", "raw_total": 9, "complete": True,
        }),
        "research_action": "flag_for_human_review",
    })


# --- scoring -------------------------------------------------------------

def test_bands():
    assert [band(t) for t in (4, 6, 7, 8, 9, 12)] == ["Low", "Low", "Medium", "Medium", "High", "High"]


def _s(a, s, l, c):
    mk = lambda v: CategoryScore(score=v, rationale="t") if v else CategoryScore(score=None, rationale="t", null_reason="missing")
    return Scores(ambiguity=mk(a), source=mk(s), liquidity=mk(l), correlation=mk(c))


def test_override_floor_applied_separately_from_raw_total():
    r = rate(_s(3, 1, 1, 1))
    assert (r.raw_total, r.raw_rating, r.rating_floor, r.final_rating) == (6, "Low", "Medium", "Medium")


def test_correlation_3_floors_rating_at_high():
    """Sibling/overlapping markets (C=3) should not stall at Medium when raw total is 8."""
    r = rate(_s(1, 1, 3, 3))
    assert (r.raw_total, r.raw_rating, r.rating_floor, r.final_rating) == (8, "Medium", "High", "High")
    assert any(o.triggered_by == "correlation" for o in r.overrides)


def test_source_2_and_ambiguity_2_floor_high():
    """Excel-style settlement edge with unclear criteria -> High research attention."""
    r = rate(_s(2, 2, 1, 1))
    assert (r.raw_total, r.raw_rating, r.rating_floor, r.final_rating) == (6, "Low", "High", "High")


def test_liquidity_3_floors_at_medium():
    r = rate(_s(1, 1, 3, 1))
    assert (r.raw_total, r.raw_rating, r.rating_floor, r.final_rating) == (6, "Low", "Medium", "Medium")


def test_incomplete_rating_is_not_silently_low():
    r = rate(_s(1, 1, None, 1))
    assert not r.complete and r.final_rating is None and r.raw_total is None
    assert r.possible_range == ("Low", "Low")
    r2 = rate(_s(2, 2, None, 2))           # known 6, range 7..9; Source>=2+Amb>=2 floors High
    assert r2.possible_range == ("High", "High") and r2.rating_floor == "High"
    r3 = rate(_s(3, 1, None, 1))           # known 5, range 6..8, floor Medium
    assert r3.possible_range == ("Medium", "Medium") and r3.rating_floor == "Medium"


def test_null_score_requires_reason():
    with pytest.raises(ValidationError):
        CategoryScore(score=None, rationale="x")


def test_liquidity_thresholds_match_framework():
    assert liquidity_score(Decimal("1071"), Decimal("0.69"), Decimal("0.70"))[0] == 1
    # Thin but quoted with a tight spread is Excel Liquidity mid (our 2), not max.
    assert liquidity_score(Decimal("7"), Decimal("0.54"), Decimal("0.58"))[0] == 2
    assert liquidity_score(Decimal("857.53"), Decimal("0.51"), Decimal("0.54"), True)[0] == 2
    assert liquidity_score(Decimal("20"), None, None)[0] == 3
    # Both prices missing is a 3 when any volume is present, and null only when nothing is present.
    assert liquidity_score(None, None, None)[0] is None
    assert liquidity_score(None, Decimal("0.40"), Decimal("0.44"))[0] is None
    # A tight, busy book is still a 2 when some strikes have no bid.
    assert liquidity_score(Decimal("5000"), Decimal("0.40"), Decimal("0.41"), True)[0] == 2
    # Spread over 15c is Excel Avoid / our Liquidity 3.
    assert liquidity_score(Decimal("500"), Decimal("0.40"), Decimal("0.60"))[0] == 3
    # Thin volume with a two-sided <=15c quote stays 2.
    assert liquidity_score(Decimal("100"), Decimal("0.40"), Decimal("0.45"))[0] == 2


def test_liquidity_rationale_names_the_volume_window():
    score, why, _ = liquidity_score(Decimal("1071"), Decimal("0.69"), Decimal("0.70"), False, "total")
    assert score == 1 and why.startswith("event-total volume")
    score, why, _ = liquidity_score(Decimal("20"), None, None, False, "24h")
    assert score == 3 and "24h volume" in why


def test_reading_rubric_keeps_the_edge_cases():
    assert "empty event terms link" in READING_RUBRIC
    assert "exchange may set the payout" in READING_RUBRIC
    assert "No settlement source is named" in READING_RUBRIC
    assert "not a portfolio" in READING_RUBRIC
    assert "Sibling buckets" in READING_RUBRIC


# --- OKC -------------------------------------------------------------------

def test_okc_low_and_no_purchase():
    c = ctx()
    ra = get_risk_analysis(OKC, c)
    assert ra.rating.final_rating == "Low" and ra.rating.raw_total == 4
    assert ra.research_action == "no_further_research"
    log = []
    assert generate_purchase_request(ra, c, log) is None
    assert any("limited to High-risk markets" in l for l in log)
    # Even if forced High, OKC has no material resolution gap to buy for.
    log2 = []
    assert generate_purchase_request(_with_high_rating(ra), c, log2) is None
    assert any("no material resolution gap" in l for l in log2)


def test_price_is_separate_from_risk():
    ra = get_risk_analysis(OKC, ctx())
    assert ra.quoted_price.mid == "0.695"
    assert "price" not in Scores.model_fields


# --- NYC -------------------------------------------------------------------

def test_nyc_source_ambiguity_floors_high():
    """NWS + band edges: Source>=2 and Ambiguity>=2 floor final to High (Excel settlement edge)."""
    ra = get_risk_analysis(NYC, ctx())
    assert (ra.rating.raw_total, ra.rating.final_rating, ra.research_action) == (7, "High", "flag_for_human_review")
    assert ra.rating.rating_floor == "High"
    assert any("Source >= 2 and Ambiguity >= 2" in o.rule for o in ra.rating.overrides)
    assert "event_terms_url_empty" in ra.data_quality_flags


def test_nyc_free_check_answers_means_no_purchase():
    c = ctx(free_check_scenario="free-check-answers")
    log = []
    assert generate_purchase_request(_with_high_rating(get_risk_analysis(NYC, c)), c, log) is None
    assert any("free official-source check" in l for l in log)
    assert any("GAP-NYC-FORECAST" in l and "not settlement risk" in l for l in log)


def test_nyc_high_proposes_when_free_check_inconclusive():
    c = ctx(free_check_scenario="free-check-inconclusive")
    ra = get_risk_analysis(NYC, c)
    assert ra.rating.final_rating == "High"
    log = []
    p = generate_purchase_request(ra, c, log)
    assert p is not None and p.catalog_item_id == "cat-nws-cli-settlement-version-v1"


def test_medium_rating_still_blocks_research_buy():
    c = ctx(free_check_scenario="free-check-inconclusive")
    ra = get_risk_analysis(NYC, c).model_copy(update={
        "rating": get_risk_analysis(NYC, c).rating.model_copy(update={
            "final_rating": "Medium", "raw_rating": "Medium", "rating_floor": None,
        }),
        "research_action": "investigate",
    })
    log = []
    assert generate_purchase_request(ra, c, log) is None
    assert any("limited to High-risk markets" in line for line in log)


def test_nyc_gap_remains_proposes_005_usdc_unsigned():
    c = ctx(free_check_scenario="free-check-inconclusive")
    p = generate_purchase_request(_with_high_rating(get_risk_analysis(NYC, c)), c)
    assert isinstance(p, PurchaseProposalV1)
    assert p.max_amount_base_units == "50000" and p.signed is False
    assert p.evidence_gap_id == "GAP-NYC-SETTLE"
    assert p.catalog_item_id == "cat-nws-cli-settlement-version-v1"
    assert p.fixture_label and "FIXTURE" in p.fixture_label


def test_forecast_item_is_never_proposed():
    c = ctx(free_check_scenario="free-check-inconclusive")
    p = generate_purchase_request(_with_high_rating(get_risk_analysis(NYC, c)), c)
    assert p.catalog_item_id != "cat-point-forecast-v1"


def test_no_scenario_means_gap_cannot_be_validated():
    c = ctx(free_check_scenario=None)
    assert generate_purchase_request(get_risk_analysis(NYC, c), c) is None


def test_cached_evidence_blocks_purchase():
    c = ctx(free_check_scenario="free-check-inconclusive",
            cached_evidence={(NYC, "GAP-NYC-SETTLE"): "evidence-cache-001"})
    assert generate_purchase_request(get_risk_analysis(NYC, c), c) is None


def test_under_one_hour_to_expiry_blocks_purchase():
    c = ctx(free_check_scenario="free-check-inconclusive", clock=FixedClock("2026-11-19T04:30:00Z"))
    log = []
    assert generate_purchase_request(get_risk_analysis(NYC, c), c, log) is None
    assert "under 1h" in log[-1]


def test_catalog_off_allowlist_blocks_purchase():
    c = ctx(free_check_scenario="free-check-inconclusive")
    c.catalog = {**c.catalog, "merchant_allowlist": []}
    assert generate_purchase_request(get_risk_analysis(NYC, c), c) is None


# --- fixtures and flags ----------------------------------------------------

def test_missing_tickers_flagged_and_block_purchase():
    c = ctx()
    for cid in ("fx-fed-dec-hike25-2026", "fx-best-ai-2026-gemini"):
        ra = get_risk_analysis(cid, c)
        assert any(f.startswith("ticker_missing") for f in ra.data_quality_flags)
        assert generate_purchase_request(ra, c) is None


def test_all_five_fixtures_validate_and_match_workbook_totals():
    c = ctx()
    # NYC workbook scored Liquidity 3; Excel-aligned thresholds compute 2 from the same quotes.
    known_raw_drift = {"fx-nyc-high-20261118": 7}
    for cid, m in c.markets.items():
        ra = get_risk_analysis(cid, c)
        expected = known_raw_drift.get(cid, m["workbook"]["total"])
        assert ra.rating.raw_total == expected, cid
        assert ra.snapshot.snapshot_hash.startswith("sha256:")


def test_snapshot_hash_is_stable():
    assert get_risk_analysis(OKC, ctx()).snapshot.snapshot_hash == get_risk_analysis(OKC, ctx()).snapshot.snapshot_hash


def test_nyc_observed_check_is_inconclusive_and_labeled_observed():
    c = ctx(free_check_scenario="observed-2026-11-18")
    log = []
    p = generate_purchase_request(_with_high_rating(get_risk_analysis(NYC, c)), c, log)
    assert p is not None and p.catalog_item_id == "cat-nws-cli-settlement-version-v1"
    assert p.fixture_label.startswith("OBSERVED") and "FIXTURE" not in p.fixture_label
    assert any("first published version" in l for l in log)


def test_nyc_fixture_quotes_real_terms():
    m = ctx().markets[NYC]
    q = {e["id"]: e["quote"] for e in m["rules_excerpts"]}
    assert "first published version" in q["C-NYC-4"]
    assert len(q["C-NYC-4"].split()) < 15
