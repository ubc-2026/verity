"""Free research uses injected document text. No network and no model."""
from verity import FixtureContext, generate_purchase_request, get_risk_analysis
from verity.research import (
    ATL_CHECK,
    CHI_MIDWAY_CHECK,
    NWS_CLIATL_URL,
    NWS_CLIMDW_URL,
    NWS_CLINYC_URL,
    SPORTS_CHECK,
    named_issuance,
    research_free_check,
)
from verity.schemas import EvidenceGap, PurchaseProposalV1

NYC = "fx-nyc-high-20261118"
TERMS = "https://assets.gemini.com/predictions/terms_and_conditions/Weather_Terms_and_Conditions_67323dd4-5775-48d5-bea0-c33d672d1f74.pdf"
NAMED = "Settlement shall use the final issuance of the NWS Climatological Report (Daily) for Central Park."
UNNAMED = "Resolves on the NWS Climatological Report (Daily) maximum temperature at Central Park."
REPORT = "CLINYC climatological report for Central Park. The latest daily issuance is shown here."


def _fetch(pages):
    def fetch(url):
        if url not in pages:
            return None, f"unexpected url {url}"
        text, problem = pages[url]
        return text, problem
    return fetch


def _nyc(pages, **overrides):
    ctx = FixtureContext.default(live_research=True, fetch_text=_fetch(pages), **overrides)
    return ctx, get_risk_analysis(NYC, ctx)


def _with_high_rating(ra):
    """Spend-control tests: buys require High; NYC fixture is Medium by default."""
    return ra.model_copy(update={
        "rating": ra.rating.model_copy(update={
            "final_rating": "High", "raw_rating": "High", "raw_total": 9, "complete": True,
        }),
        "research_action": "flag_for_human_review",
    })


def test_named_issuance_requires_an_explicit_phrase():
    assert named_issuance(NAMED)
    assert named_issuance(UNNAMED) is None


def test_medium_rating_does_not_propose_even_when_gap_is_open():
    ctx, ra = _nyc({TERMS: (UNNAMED, None), NWS_CLINYC_URL: (REPORT, None)})
    assert ra.rating.final_rating == "Medium"
    log = []
    assert generate_purchase_request(ra, ctx, log) is None
    assert any("limited to High-risk markets" in line for line in log)


def test_free_read_resolves_the_gap_and_proposes_nothing():
    ctx, ra = _nyc({TERMS: (NAMED, None), NWS_CLINYC_URL: (REPORT, None)})
    log = []
    assert generate_purchase_request(_with_high_rating(ra), ctx, log) is None
    assert any("free research resolved" in line for line in log)
    assert any(TERMS in line and NWS_CLINYC_URL in line for line in log)
    assert any("final issuance" in line for line in log)


def test_inconclusive_read_proposes_the_existing_unsigned_item():
    ctx, ra = _nyc({TERMS: (UNNAMED, None), NWS_CLINYC_URL: (REPORT, None)})
    log = []
    proposal = generate_purchase_request(_with_high_rating(ra), ctx, log)
    assert isinstance(proposal, PurchaseProposalV1)
    assert proposal.catalog_item_id == "cat-nws-cli-settlement-version-v1"
    assert proposal.max_amount_base_units == "50000" and proposal.signed is False
    assert proposal.fixture_label is None
    assert any("free research unresolved" in line for line in log)
    assert "do not name the preliminary, final, or corrected issuance" in proposal.rationale


def test_missing_catalog_match_proposes_nothing():
    ctx, ra = _nyc({TERMS: (UNNAMED, None), NWS_CLINYC_URL: (REPORT, None)})
    gap = EvidenceGap(
        id="GAP-OKC-SOURCE",
        question="Which source list controls?",
        gap_type="other",
        affects="resolution_risk",
        material=True,
        why="The description and the terms name different agencies.",
        free_checks=["okc-source-list"],
    )
    ra = _with_high_rating(ra.model_copy(update={"evidence_gaps": [gap]}))
    log = []
    assert generate_purchase_request(ra, ctx, log) is None
    assert any("not_configured" in line for line in log)
    assert any("no free official-source check is configured" in line for line in log)
    direct = research_free_check("okc-source-list", question=gap.question, terms_url=TERMS, fetch_text=_fetch({}))
    assert direct.status == "not_configured" and direct.resolved is False


def test_unreadable_source_does_not_propose():
    ctx, ra = _nyc({TERMS: (None, "fetch failed: HTTPError"), NWS_CLINYC_URL: (REPORT, None)})
    log = []
    assert generate_purchase_request(_with_high_rating(ra), ctx, log) is None
    assert any("free research failed" in line for line in log)
    assert any("gap was not validated" in line for line in log)


def test_research_result_records_sources_and_excerpts():
    found = research_free_check(
        "nyc-settlement-version",
        question="Which issuance settles the contract?",
        terms_url=TERMS,
        fetch_text=_fetch({TERMS: (UNNAMED, None), NWS_CLINYC_URL: (REPORT, None)}),
    )
    assert found.status == "unresolved" and found.resolved is False
    assert found.sources == [TERMS, NWS_CLINYC_URL]
    assert len(found.excerpts) == 2
    assert "Climatological Report" in found.excerpts[0]
    assert found.question == "Which issuance settles the contract?"


def test_midway_free_check_inconclusive_proposes_nws_catalog_item():
    """Chicago-Midway uses the same issuance logic against the Midway CLI URL."""
    midway_report = "CLIMDW climatological report for Chicago-Midway. Latest daily issuance."
    found = research_free_check(
        CHI_MIDWAY_CHECK,
        question="Which Midway issuance settles the contract?",
        terms_url=TERMS,
        fetch_text=_fetch({TERMS: (UNNAMED, None), NWS_CLIMDW_URL: (midway_report, None)}),
    )
    assert found.status == "unresolved" and found.resolved is False
    assert found.sources == [TERMS, NWS_CLIMDW_URL]

    # Attach Midway free-check onto the NYC fixture row shape isn't needed: call research path via a
    # live-style ctx by swapping the NYC gap's free_checks list.
    ctx, ra = _nyc({TERMS: (UNNAMED, None), NWS_CLIMDW_URL: (midway_report, None)})
    gap = next(g for g in ra.evidence_gaps if g.gap_type == "settlement_source_version")
    ra = ra.model_copy(update={
        "event_ticker": "WXHIGH-CHI-2611200459",
        "evidence_gaps": [gap.model_copy(update={"free_checks": [CHI_MIDWAY_CHECK]})],
    })
    ctx.markets[ra.contract_id] = {**ctx.markets[ra.contract_id], "terms_url": TERMS}
    log = []
    proposal = generate_purchase_request(_with_high_rating(ra), ctx, log)
    assert isinstance(proposal, PurchaseProposalV1)
    assert proposal.catalog_item_id == "cat-midway-vs-title-station-pack-v1"
    assert proposal.catalog_parameters.get("station") == "Chicago-Midway, IL (CLIMDW)"
    assert any("free research unresolved" in line for line in log)


def _model_ctx(answer, calls=None):
    def complete(system, user, schema):
        if calls is not None:
            calls.append({"system": system, "user": user, "schema": schema})
        if callable(answer):
            return answer(system, user, schema)
        return answer
    return FixtureContext.default(
        complete_json=complete,
        fetch_text=lambda url: ("fetched terms without an issuance phrase", None),
    )


def test_model_unresolved_quote_proposes_the_existing_item():
    ctx = _model_ctx(None)
    ra = get_risk_analysis(NYC, ctx)
    quote = next(c.quote for c in ra.citations if c.id == "C-NYC-1")

    def answer(system, user, schema):
        assert "0.54" not in user and "bestBid" not in user
        assert quote in user
        return {
            "resolved": False,
            "conclusion": "The issuance is not named.",
            "reasoning": "The excerpt names the report only.",
            "sources": [],
            "excerpts": [quote[:48]],
            "confidence": 0.4,
        }

    ctx.complete_json = lambda system, user, schema: answer(system, user, schema)
    log = []
    proposal = generate_purchase_request(_with_high_rating(ra), ctx, log)
    assert isinstance(proposal, PurchaseProposalV1)
    assert proposal.catalog_item_id == "cat-nws-cli-settlement-version-v1"
    assert proposal.max_amount_base_units == "50000" and proposal.signed is False
    assert proposal.fixture_label is None
    assert any("model research failed" not in line and "unresolved" in line for line in log)


def test_model_resolved_quote_proposes_nothing():
    ctx = _model_ctx(None)
    ra = get_risk_analysis(NYC, ctx)
    quote = next(c.quote for c in ra.citations if c.id == "C-NYC-1")
    ctx.complete_json = lambda system, user, schema: {
        "resolved": True,
        "conclusion": "The text answers the question.",
        "reasoning": "Quoted from the excerpt.",
        "sources": [],
        "excerpts": [quote[:48]],
    }
    assert generate_purchase_request(_with_high_rating(ra), ctx, []) is None


def test_invented_excerpt_or_url_or_bad_json_proposes_nothing():
    ctx = _model_ctx(None)
    ra = _with_high_rating(get_risk_analysis(NYC, ctx))
    for bad in (
        {"resolved": False, "conclusion": "x", "reasoning": "y", "sources": [], "excerpts": ["not in the documents"]},
        {"resolved": False, "conclusion": "x", "reasoning": "y", "sources": ["https://example.com/not-fetched"], "excerpts": []},
        {"resolved": "yes"},
        {"resolved": True, "conclusion": "x", "reasoning": "y", "sources": [], "excerpts": []},
    ):
        ctx.complete_json = lambda system, user, schema, payload=bad: payload
        log = []
        assert generate_purchase_request(ra, ctx, log) is None
        assert any("model research failed" in line for line in log)


def test_model_without_a_catalog_match_proposes_nothing():
    ctx = _model_ctx(None)
    ra = get_risk_analysis(NYC, ctx)
    quote = next(c.quote for c in ra.citations if c.id == "C-NYC-1")
    gap = EvidenceGap(
        id="GAP-OKC-SOURCE",
        question="Which source list controls?",
        gap_type="other",
        affects="resolution_risk",
        material=True,
        why="The description and the terms name different agencies.",
        free_checks=[],
    )
    ra = _with_high_rating(ra.model_copy(update={"evidence_gaps": [gap]}))
    ctx.complete_json = lambda system, user, schema: {
        "resolved": False,
        "conclusion": "The two lists disagree.",
        "reasoning": "Both names are in the excerpt.",
        "sources": [],
        "excerpts": [quote[:48]],
    }
    log = []
    assert generate_purchase_request(ra, ctx, log) is None
    assert any("gap type 'other'" in line for line in log)


def test_fixture_scenario_wins_over_the_model():
    called = []
    ctx = FixtureContext.default(
        free_check_scenario="free-check-inconclusive",
        complete_json=lambda system, user, schema: called.append(1),
    )
    proposal = generate_purchase_request(_with_high_rating(get_risk_analysis(NYC, ctx)), ctx, [])
    assert called == []
    assert proposal is not None and proposal.catalog_item_id == "cat-nws-cli-settlement-version-v1"


def test_sports_terms_inconclusive_proposes_sports_catalog_item():
    sports_terms = "Settles on the StatsScore official result. Revisions may occur after first publication."
    found = research_free_check(
        SPORTS_CHECK,
        question="Which sports feed version settles?",
        terms_url=TERMS,
        fetch_text=_fetch({TERMS: (sports_terms, None)}),
    )
    assert found.status == "unresolved" and found.resolved is False

    ctx, ra = _nyc({TERMS: (sports_terms, None)})
    gap = next(g for g in ra.evidence_gaps if g.gap_type == "settlement_source_version")
    ra = _with_high_rating(ra.model_copy(update={
        "event_ticker": "NBA-2611190230-BOS-DEN-S",
        "evidence_gaps": [gap.model_copy(update={"free_checks": [SPORTS_CHECK]})],
    }))
    ctx.markets[ra.contract_id] = {**ctx.markets[ra.contract_id], "terms_url": TERMS}
    log = []
    proposal = generate_purchase_request(ra, ctx, log)
    assert isinstance(proposal, PurchaseProposalV1)
    assert proposal.catalog_item_id == "cat-sports-settlement-version-v1"
    assert any("free research unresolved" in line for line in log)


def test_atl_weather_free_check_reads_atlanta_cli():
    atl_report = "CLIATL climatological report for Atlanta. Latest daily issuance."
    found = research_free_check(
        ATL_CHECK,
        question="Which Atlanta issuance settles?",
        terms_url=TERMS,
        fetch_text=_fetch({TERMS: (UNNAMED, None), NWS_CLIATL_URL: (atl_report, None)}),
    )
    assert found.status == "unresolved" and found.sources == [TERMS, NWS_CLIATL_URL]
