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

GAME = {
    "ticker": "NBA-2611190100-ATL-OKC-M",
    "title": "Atlanta vs Oklahoma City",
    "description": "Pays Yes if the named team wins the game, per the official NBA result.",
    "expiryDate": "2026-11-20T13:00:00.000Z",
    "volume": 1071,
    "termsAndConditionsUrl": "https://assets.gemini.com/predictions/terms_and_conditions/nba.pdf",
    "sourceDetails": {"agency": "NBA"},
    "contracts": [{"label": "Oklahoma City", "instrumentSymbol": "GEMI-NBA-OKC",
                   "prices": {"bestBid": "0.69", "bestAsk": "0.70"}}],
    "events": [{"ticker": "NBA-2611190100-ATL-OKC-T"}],
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
    ra, ctx = analyze_live("WXHIGH-NYC-2611190459", "62°F to 63°F", http_get=fake_get, now=NOW, analyst="none")
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


def test_real_okc_response_shape_is_parsed():
    """Trimmed copy of a real Gemini Exchange response captured 2026-11-18."""
    import json, pathlib
    ev = json.loads((pathlib.Path(__file__).parent / "live_okc_event_2026-11-18.json").read_text(encoding="utf-8"))
    r = build_live_record(ev, "Oklahoma City", now=NOW)
    contract = next(e for e in r["rules_excerpts"] if e["id"] == "C-CONTRACT")
    assert contract["quote"].startswith("If Oklahoma City wins") and "nodeType" not in contract["quote"]
    assert r["event_terms_url_present"] is True          # live API uses "termsLink"
    assert r["instrument_symbol"] == "GEMI-NBA-2611190100-ATL-OKC-M-OKC"
    assert len(r["sibling_events"]) == 5
    assert (r["market"]["best_bid"], r["market"]["best_ask"]) == ("0.69", "0.7")


# --- rules analyst on live markets ------------------------------------------

def _real_okc_event():
    import json, pathlib
    return json.loads((pathlib.Path(__file__).parent / "live_okc_event_2026-11-18.json").read_text(encoding="utf-8"))


def test_live_rules_analyst_scores_nyc_by_default():
    ra, ctx = analyze_live("WXHIGH-NYC-2611190459", "62°F to 63°F", http_get=fake_get, now=NOW)
    s = ra.scores
    assert (s.ambiguity.score, s.source.score, s.liquidity.score, s.correlation.score) == (2, 2, 3, 1)
    assert ra.rating.complete and ra.rating.raw_total == 8 and ra.rating.final_rating == "Medium"
    assert "analyst=verity-rules-v1 (code rules, no LLM)" in ra.data_quality_flags
    assert not any(f.startswith("reading_scores_unscored") for f in ra.data_quality_flags)
    gap = next(g for g in ra.evidence_gaps if g.gap_type == "settlement_source_version")
    assert gap.material and gap.free_checks == ["nyc-settlement-version"]   # hooks into research.py


def test_live_rules_analyst_on_real_okc_response():
    ev = _real_okc_event()
    pdf_text = "Settles on the official result of the game between Oklahoma City and Atlanta."

    def get(url, timeout=None):
        return FakeResp(ev)

    import verity.live as live
    orig = live.fetch_terms_text
    live.fetch_terms_text = lambda url, http_get=None: (pdf_text, None)
    try:
        ra, ctx = analyze_live("NBA-2611190100-ATL-OKC-M", "Oklahoma City", http_get=get, now=NOW)
    finally:
        live.fetch_terms_text = orig
    s = ra.scores
    assert (s.ambiguity.score, s.source.score, s.liquidity.score, s.correlation.score) == (1, 1, 1, 3)
    assert ra.rating.raw_total == 6 and ra.rating.final_rating == "Low"
    assert ra.research_action == "no_further_research"
    assert generate_purchase_request(ra, ctx) is None


def test_unknown_analyst_is_rejected():
    with pytest.raises(ValueError):
        analyze_live("X", "Y", http_get=fake_get, now=NOW, analyst="gpt")
