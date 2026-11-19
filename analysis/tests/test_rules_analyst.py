"""Rules-analyst scoring fixes: Source false positives and band siblings."""
from verity.rules_analyst import _correlation, _source, rules_analyst


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


def test_boilerplate_revisions_does_not_force_source_2():
    """Bare 'Revisions' in PDF boilerplate used to match 'revis' and score Source=2."""
    src = _source(
        _record(),
        _record()["rules_excerpts"][0]["quote"],
        ["C-TERMS"],
    )
    assert src["score"] == 1
    assert "statscore" in src["rationale"].lower()


def test_nws_still_scores_source_2():
    src = _source(
        {
            "settlement_source": "NWS / CLINYC",
            "rules_excerpts": [],
        },
        "Settles on the National Weather Service Climatological Report (Daily).",
        ["C-TERMS"],
    )
    assert src["score"] == 2


def test_primary_feed_upgrades_when_terms_name_issuance_revision():
    src = _source(
        _record(settlement_source="sportradar-rest-api / Football"),
        "Settlement uses the preliminary official result subject to later revision.",
        ["C-TERMS"],
    )
    assert src["score"] == 2
    assert "revisable" in src["rationale"].lower() or "preliminary" in src["rationale"].lower()


def test_weather_band_siblings_are_correlation_1():
    cor = _correlation(
        {
            "event_ticker": "WXHIGH-CHI-2611200459",
            "sibling_events": [
                "WXHIGH-CHI-2611200459-OTHER",
                "WXHIGH-CHI-2611190459",
            ],
            "question": "Highest temperature in Chicago?",
        },
        "",
        ["C-CONTRACT"],
    )
    assert cor["score"] == 1
    assert "same question" in cor["rationale"].lower()


def test_sports_line_siblings_are_correlation_3():
    cor = _correlation(
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
    assert cor["score"] == 3


def test_rules_analyst_sports_record_no_longer_opens_version_gap_on_boilerplate():
    rec = rules_analyst(_record())
    assert rec["analyst"]["source"]["score"] == 1
    assert rec["evidence_gaps"] == []
