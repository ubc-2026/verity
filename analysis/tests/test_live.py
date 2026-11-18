"""Live path with the exchange API faked: no network, no key."""
from datetime import datetime, timezone

import pytest

from verity import generate_purchase_request
from verity.live import analyze_live, build_live_record

NOW = datetime(2026, 11, 18, 1, 0, tzinfo=timezone.utc)

EVENT = {
    "ticker": "WXHIGH-NYC-2611190459",
    "title": "Highest temperature in NYC on November 18, 2026",
    "description": "Resolves on the NWS Climatological Report (Daily) maximum temperature at Central Park.",
    "expiryDate": "2026-11-19T04:59:00.000Z",
    "volume": 7,
    "termsAndConditionsUrl": "",
    "sourceDetails": {"agency": "NWS", "index": "CLINYC"},
    "contracts": [
        {"label": "62°F to 63°F", "instrumentSymbol": "GEMI-WXHIGH-NYC-2611190459-B62",
         "description": "Yes if the max is 62 or 63°F.",
         "termsAndConditionsUrl": "https://assets.gemini.com/predictions/terms_and_conditions/weather.pdf",
         "prices": {"bestBid": "0.54", "bestAsk": "0.58"}},
        {"label": "58°F to 59°F", "instrumentSymbol": "GEMI-WXHIGH-NYC-2611190459-B58",
         "prices": {"bestBid": None, "bestAsk": "0.03"}},
    ],
}


class FakeResp:
    def __init__(self, payload=None, content=b"", status=200):
        self._p, self.content, self.status_code = payload, content, status

    def json(self):
        return self._p

    def raise_for_status(self):
        if self.status_code >= 400:
            raise RuntimeError(f"HTTP {self.status_code}")


def fake_get(url, timeout=None):
    if url.endswith("/events/WXHIGH-NYC-2611190459"):
        return FakeResp(EVENT)
    if url.endswith(".pdf"):
        return FakeResp(status=404)  # terms unreadable -> flagged, not fatal
    raise AssertionError(url)


def test_live_record_has_time_symbol_and_real_text():
    r = build_live_record(EVENT, "62°F to 63°F", now=NOW)
    assert r["source"]["snapshot_time_utc"] == "2026-11-18T01:00:00Z"
    assert r["instrument_symbol"] == "GEMI-WXHIGH-NYC-2611190459-B62"
    assert r["market"]["best_bid"] == "0.54" and r["market"]["volume_usd"] == "7"
    assert r["market"]["some_strikes_unquoted"] is True
    assert r["event_terms_url_present"] is False
    assert r["analyst"]["ambiguity"]["score"] is None
    assert r["analyst"]["source"]["score"] is None
    assert r["analyst"]["correlation"]["score"] is None


def test_document_description_becomes_plain_text():
    event = dict(EVENT)
    event["description"] = {
        "nodeType": "document",
        "content": [{"nodeType": "text", "value": "Resolves on the official game result."}],
    }
    r = build_live_record(event, "62°F to 63°F", now=NOW)
    assert r["rules_excerpts"][0]["quote"] == "Resolves on the official game result."


def test_unknown_outcome_lists_labels():
    with pytest.raises(KeyError, match="labels"):
        build_live_record(EVENT, "Nope", now=NOW)


def test_analyze_live_end_to_end_with_fakes():
    ra, ctx = analyze_live("WXHIGH-NYC-2611190459", "62°F to 63°F", http_get=fake_get, now=NOW)
    assert ra.snapshot.source_mode == "live"
    assert ra.scores.ambiguity.score is None
    assert ra.scores.source.score is None
    assert ra.scores.correlation.score is None
    assert ra.scores.liquidity.score == 3  # computed in code from $7 volume
    assert ra.rating.complete is False
    assert ra.rating.final_rating is None
    assert ra.research_action == "flag_for_human_review"
    assert any(f.startswith("terms_not_read") for f in ra.data_quality_flags)
    assert any(f.startswith("reading_scores_unscored") for f in ra.data_quality_flags)
    assert ra.workbook_conflicts  # global notes still attached; no workbook row to compare

    log = []
    assert generate_purchase_request(ra, ctx, log) is None
    assert any("no material resolution gap" in line for line in log)
