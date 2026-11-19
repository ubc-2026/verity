"""Excel Framework rules-analyst: resolution / source / outside-events."""
from verity.rules_analyst import _outside_events, _resolution, _source, rules_analyst
from verity.scoring import to_excel


def _record(**kw):
    base = {
        "event_ticker": "NBA-2611190230-BOS-DEN-S",
        "settlement_source": "statscore-rest-api / Basketball",
        "outcome_label": "Boston",
        "question": "Boston vs Denver",
        "event_terms_url_present": True,
        "sibling_events": [],
        "rules_excerpts": [
            {
                "id": "C-TERMS",
                "field_or_rule": "terms",
                "quote": (
                    "Settles on the StatsScore official result. "
                    "Document Revisions may be published on the exchange website."
                ),
            }
        ],
    }
    base.update(kw)
    return base


def test_boilerplate_revisions_does_not_force_source_elevated():
    src = _source(
        _record(),
        _record()["rules_excerpts"][0]["quote"],
        ["C-TERMS"],
    )
    assert src["score"] == 1  # excel 0
    assert to_excel(src["score"]) == 0


def test_nws_scores_source_reliability_1():
    src = _source(
        {"settlement_source": "NWS / CLINYC", "rules_excerpts": []},
        "Settles on the National Weather Service Climatological Report (Daily).",
        ["C-TERMS"],
    )
    assert src["score"] == 2  # excel 1
    assert to_excel(src["score"]) == 1


def test_kaiko_commodity_perp_is_proxy_source_2():
    src = _source(
        {"settlement_source": "kaiko-equities KK_RFR_BRENTOILUSDC", "rules_excerpts": []},
        "Settles on a 60-second average of the Hyperliquid BRENTOIL-USDC perpetual.",
        ["C-TERMS"],
    )
    assert src["score"] == 3  # excel 2
    assert "proxy" in src["rationale"].lower() or "perp" in src["rationale"].lower()


def test_primary_feed_upgrades_when_terms_name_issuance_revision():
    src = _source(
        _record(settlement_source="sportradar-rest-api / Football"),
        "Settlement uses the preliminary official result subject to later revision.",
        ["C-TERMS"],
    )
    assert src["score"] == 2  # excel 1


def test_clear_sports_resolution_is_0():
    res = _resolution(
        _record(),
        _record()["rules_excerpts"][0]["quote"],
        ["C-TERMS"],
    )
    assert res["score"] == 1  # excel 0


def test_band_edges_need_judgment():
    res = _resolution(
        _record(outcome_label="62°F to 63°F", question="Highest temperature in NYC?"),
        "Settles on NWS CLINYC. Yes if the max is 62 or 63°F.",
        ["C-TERMS"],
    )
    assert res["score"] == 2  # excel 1


def test_weather_band_siblings_are_outside_events_0():
    cor = _outside_events(
        {
            "event_ticker": "WXHIGH-CHI-2611200459",
            "sibling_events": ["WXHIGH-CHI-2611200459-OTHER"],
            "question": "Highest temperature in Chicago?",
        },
        "",
        ["C-CONTRACT"],
    )
    assert cor["score"] == 1  # excel 0


def test_sports_line_siblings_are_outside_events_1():
    cor = _outside_events(
        {
            "event_ticker": "NBA-2611190230-BOS-DEN-M",
            "sibling_events": [
                "NBA-2611190230-BOS-DEN-S",
                "NBA-2611190230-BOS-DEN-T",
            ],
            "question": "Boston vs Denver",
        },
        "",
        ["C-CONTRACT"],
    )
    assert cor["score"] == 2  # excel 1


def test_rules_analyst_sports_record_no_gap_on_boilerplate():
    rec = rules_analyst(_record())
    assert rec["analyst"]["source"]["score"] == 1
    assert rec["evidence_gaps"] == []
    assert rec["researchable"] is None  # n/a — no settlement edge
    assert rec["analyst_id"] == "verity-excel-v1"
