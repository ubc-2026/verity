import pytest
from pydantic import ValidationError

from verity import FixedClock, FixtureContext, generate_purchase_request, get_risk_analysis
from verity.schemas import CategoryScore, PurchaseProposalV1, Scores
from verity.scoring import READING_RUBRIC, band, excel_action, liquidity_score, rate, to_excel, to_schema
from decimal import Decimal

OKC = "fx-okc-moneyline-20261118"
NYC = "fx-nyc-high-20261118"


def ctx(**kw):
    return FixtureContext.default(**kw)


def _with_investigate(ra):
    """Force Excel Investigate so purchase-path tests can isolate other gates."""
    return ra.model_copy(update={
        "rating": ra.rating.model_copy(update={
            "final_rating": "Medium", "raw_rating": "Medium", "raw_total": 7, "complete": True,
        }),
        "research_action": "investigate",
    })


# --- scoring -------------------------------------------------------------

def test_bands():
    assert [band(t) for t in (4, 6, 7, 8, 9, 12)] == ["Low", "Low", "Medium", "Medium", "High", "High"]


def test_excel_schema_roundtrip():
    assert [to_schema(x) for x in (0, 1, 2)] == [1, 2, 3]
    assert [to_excel(x) for x in (1, 2, 3)] == [0, 1, 2]


def _s(a, s, l, c):
    mk = lambda v: CategoryScore(score=v, rationale="t") if v else CategoryScore(score=None, rationale="t", null_reason="missing")
    return Scores(ambiguity=mk(a), source=mk(s), liquidity=mk(l), correlation=mk(c))


def test_excel_trade_normally_when_no_settlement_edge():
    r = rate(_s(1, 1, 1, 1), price_quality_excel=0)
    assert r.final_rating == "Low" and r.raw_rating == "Low"
    assert any("Trade normally" in o.rule for o in r.overrides)


def test_excel_investigate_when_settlement_edge():
    # schema 2,2 = excel 1,1 -> edge 2; tradeable liquidity schema 1 = excel 0
    r = rate(_s(2, 2, 1, 1), price_quality_excel=0, researchable=True)
    assert r.final_rating == "Medium"
    assert any("Investigate" in o.rule for o in r.overrides)


def test_excel_avoid_when_liquidity_worst():
    # schema liquidity 3 = excel 2 -> Avoid
    r = rate(_s(1, 1, 3, 1), price_quality_excel=0)
    assert r.final_rating == "High"
    assert any("Avoid" in o.rule and "Liquidity" in o.rule for o in r.overrides)


def test_excel_avoid_when_not_researchable():
    r = rate(_s(3, 2, 1, 1), price_quality_excel=0, researchable=False)
    assert r.final_rating == "High"
    assert any("not researchable" in o.rule for o in r.overrides)


def test_excel_action_helper():
    action, edge, exe, _ = excel_action(0, 2, 0, 0, True)
    assert action == "Investigate" and edge == 2 and exe == 0


def test_incomplete_rating_is_not_silently_low():
    r = rate(_s(1, 1, None, 1))
    assert not r.complete and r.final_rating is None and r.raw_total is None
    assert r.possible_range == ("Low", "High")


def test_null_score_requires_reason():
    with pytest.raises(ValidationError):
        CategoryScore(score=None, rationale="x")


def test_liquidity_thresholds_match_framework():
    assert liquidity_score(Decimal("1071"), Decimal("0.69"), Decimal("0.70"))[0] == 1
    assert liquidity_score(Decimal("7"), Decimal("0.54"), Decimal("0.58"))[0] == 2
    assert liquidity_score(Decimal("857.53"), Decimal("0.51"), Decimal("0.54"), True)[0] == 2
    assert liquidity_score(Decimal("20"), None, None)[0] == 3
    assert liquidity_score(None, None, None)[0] is None
    assert liquidity_score(None, Decimal("0.40"), Decimal("0.44"))[0] is None
    assert liquidity_score(Decimal("5000"), Decimal("0.40"), Decimal("0.41"), True)[0] == 2
    assert liquidity_score(Decimal("500"), Decimal("0.40"), Decimal("0.60"))[0] == 3
    assert liquidity_score(Decimal("100"), Decimal("0.40"), Decimal("0.45"))[0] == 2


def test_liquidity_rationale_names_the_volume_window():
    score, why, _ = liquidity_score(Decimal("1071"), Decimal("0.69"), Decimal("0.70"), False, "total")
    assert score == 1 and why.startswith("event-total volume")
    score, why, _ = liquidity_score(Decimal("20"), None, None, False, "24h")
    assert score == 3 and "24h volume" in why


def test_reading_rubric_mentions_excel_factors():
    assert "Resolution criteria" in READING_RUBRIC
    assert "Source reliability" in READING_RUBRIC
    assert "Chicago vs Midway" in READING_RUBRIC
    assert "crypto perp" in READING_RUBRIC.lower() or "Proxy" in READING_RUBRIC


# --- OKC -------------------------------------------------------------------

def test_okc_trade_normally_and_no_purchase():
    c = ctx()
    ra = get_risk_analysis(OKC, c)
    assert ra.rating.final_rating == "Low"
    assert ra.research_action == "no_further_research"
    log = []
    assert generate_purchase_request(ra, c, log) is None
    assert any("Investigate" in l for l in log)
    # Avoid (High) also does not buy; OKC has no material gap either.
    log2 = []
    forced = ra.model_copy(update={
        "rating": ra.rating.model_copy(update={"final_rating": "High", "raw_rating": "High"}),
        "research_action": "flag_for_human_review",
    })
    assert generate_purchase_request(forced, c, log2) is None


def test_price_is_separate_from_risk():
    ra = get_risk_analysis(OKC, ctx())
    assert ra.quoted_price.mid == "0.695"
    assert "price" not in Scores.model_fields


# --- NYC -------------------------------------------------------------------

def test_nyc_investigate_on_settlement_edge():
    ra = get_risk_analysis(NYC, ctx())
    assert ra.rating.final_rating == "Medium"
    assert ra.research_action == "investigate"
    assert any("Investigate" in o.rule for o in ra.rating.overrides)
    assert "event_terms_url_empty" in ra.data_quality_flags


def test_nyc_free_check_answers_means_no_purchase():
    c = ctx(free_check_scenario="free-check-answers")
    log = []
    assert generate_purchase_request(_with_investigate(get_risk_analysis(NYC, c)), c, log) is None
    assert any("free official-source check" in l for l in log)
    assert any("GAP-NYC-FORECAST" in l and "not settlement risk" in l for l in log)


def test_nyc_investigate_proposes_when_free_check_inconclusive():
    c = ctx(free_check_scenario="free-check-inconclusive")
    ra = get_risk_analysis(NYC, c)
    assert ra.rating.final_rating == "Medium"
    p = generate_purchase_request(ra, c, [])
    assert p is not None and p.catalog_item_id == "cat-nws-cli-settlement-version-v1"


def test_avoid_rating_blocks_research_buy():
    c = ctx(free_check_scenario="free-check-inconclusive")
    ra = get_risk_analysis(NYC, c).model_copy(update={
        "rating": get_risk_analysis(NYC, c).rating.model_copy(update={
            "final_rating": "High", "raw_rating": "High",
        }),
        "research_action": "flag_for_human_review",
    })
    log = []
    assert generate_purchase_request(ra, c, log) is None
    assert any("Investigate" in line for line in log)


def test_nyc_gap_remains_proposes_005_usdc_unsigned():
    c = ctx(free_check_scenario="free-check-inconclusive")
    p = generate_purchase_request(_with_investigate(get_risk_analysis(NYC, c)), c)
    assert isinstance(p, PurchaseProposalV1)
    assert p.max_amount_base_units == "50000" and p.signed is False
    assert p.evidence_gap_id == "GAP-NYC-SETTLE"
    assert p.catalog_item_id == "cat-nws-cli-settlement-version-v1"
    assert p.fixture_label and "FIXTURE" in p.fixture_label


def test_forecast_item_is_never_proposed():
    c = ctx(free_check_scenario="free-check-inconclusive")
    p = generate_purchase_request(_with_investigate(get_risk_analysis(NYC, c)), c)
    assert p.catalog_item_id != "cat-point-forecast-v1"


def test_no_scenario_means_gap_cannot_be_validated():
    c = ctx(free_check_scenario=None)
    # NYC is Investigate, but fixture free-check scenario missing -> no purchase
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


def test_all_five_fixtures_validate():
    c = ctx()
    for cid in c.markets:
        ra = get_risk_analysis(cid, c)
        assert ra.rating.complete
        assert ra.rating.final_rating in ("Low", "Medium", "High")
        assert ra.snapshot.snapshot_hash.startswith("sha256:")


def test_snapshot_hash_is_stable():
    assert get_risk_analysis(OKC, ctx()).snapshot.snapshot_hash == get_risk_analysis(OKC, ctx()).snapshot.snapshot_hash


def test_nyc_observed_check_is_inconclusive_and_labeled_observed():
    c = ctx(free_check_scenario="observed-2026-11-18")
    log = []
    p = generate_purchase_request(_with_investigate(get_risk_analysis(NYC, c)), c, log)
    assert p is not None and p.catalog_item_id == "cat-nws-cli-settlement-version-v1"
    assert p.fixture_label.startswith("OBSERVED") and "FIXTURE" not in p.fixture_label
    assert any("first published version" in l for l in log)


def test_nyc_fixture_quotes_real_terms():
    m = ctx().markets[NYC]
    q = {e["id"]: e["quote"] for e in m["rules_excerpts"]}
    assert "first published version" in q["C-NYC-4"]
    assert len(q["C-NYC-4"].split()) < 15
