"""Live path with the Gemini Exchange API faked: no network, no key, no LLM."""
from datetime import datetime, timezone

import pytest

from verity import generate_purchase_request
from verity.live import analyze_live, build_live_record
from verity.rules_analyst import ANALYST_ID, rules_analyst

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


def test_unknown_outcome_lists_labels():
    with pytest.raises(KeyError, match="labels"):
        build_live_record(EVENT, "Nope", now=NOW)


def test_rules_analyst_scores_weather_market():
    r = rules_analyst(build_live_record(EVENT, "62°F to 63°F", now=NOW))
    a = r["analyst"]
    assert a["ambiguity"]["score"] == 2 and "band edges" in a["ambiguity"]["rationale"]
    assert a["source"]["score"] == 2            # NWS daily report can be corrected
    assert a["correlation"]["score"] == 1
    assert "C-PRICES" not in a["ambiguity"]["citation_ids"]   # prices never feed the analyst
    gap = r["evidence_gaps"][0]
    assert gap["gap_type"] == "settlement_source_version" and gap["material"] is True
    assert r["analyst_id"] == ANALYST_ID


def test_rules_analyst_scores_game_with_siblings():
    r = rules_analyst(build_live_record(GAME, "Oklahoma City", now=NOW,
                                        terms_text="Settles on the official NBA final score."))
    a = r["analyst"]
    assert (a["ambiguity"]["score"], a["source"]["score"], a["correlation"]["score"]) == (1, 1, 3)
    assert r["evidence_gaps"] == []


def test_rules_analyst_leaderboard_is_high_risk():
    ev = {**GAME, "description": "Yes if Google has the top-ranked LLM on the LM Arena leaderboard.",
          "sourceDetails": {}, "events": []}
    r = rules_analyst(build_live_record(ev, "Oklahoma City", now=NOW))
    assert r["analyst"]["ambiguity"]["score"] == 3 and r["analyst"]["source"]["score"] == 3
    assert any(g["gap_type"] == "leaderboard_snapshot" for g in r["evidence_gaps"])


def test_unrecognized_source_is_null_not_guessed():
    ev = {**GAME, "description": "Pays Yes if the thing happens.", "sourceDetails": {"agency": "Acme Corp"}, "events": []}
    r = rules_analyst(build_live_record(ev, "Oklahoma City", now=NOW))
    assert r["analyst"]["source"]["score"] is None
    assert "not recognized" in r["analyst"]["source"]["null_reason"]


def test_analyze_live_end_to_end_with_fakes():
    ra, ctx = analyze_live("WXHIGH-NYC-2611190459", "62°F to 63°F", http_get=fake_get, now=NOW)
    assert ra.snapshot.source_mode == "live"
    assert ra.scores.liquidity.score == 3                 # computed in code from $7 volume
    assert ra.rating.complete is True and ra.rating.raw_total == 8
    assert ra.rating.final_rating == "Medium" and ra.research_action == "investigate"
    assert any(f.startswith("terms_not_read") for f in ra.data_quality_flags)
    assert f"analyst={ANALYST_ID} (code rules, no LLM)" in ra.data_quality_flags
    assert ra.workbook_conflicts  # global notes still attached; no workbook row to compare

    log = []
    assert generate_purchase_request(ra, ctx, log) is None   # no live free check yet -> no purchase
    assert any("no free official-source check is configured" in l for l in log)


def test_no_google_gemini_anywhere():
    import pathlib
    root = pathlib.Path(__file__).resolve().parent.parent
    assert not (root / "verity" / "llm.py").exists()
    for f in list((root / "verity").glob("*.py")) + [root / "requirements-live.txt", root / ".env.example"]:
        if f.exists():
            body = f.read_text(encoding="utf-8")
            assert "google-genai" not in body and "from google" not in body and "GEMINI_API_KEY" not in body, f


# --- real response shape (captured 2026-11-18) ---------------------------------

def _real_okc():
    import json, pathlib
    return json.loads((pathlib.Path(__file__).parent / "live_okc_event_2026-11-18.json").read_text(encoding="utf-8"))


def test_real_response_shape_is_parsed():
    r = build_live_record(_real_okc(), "Oklahoma City", now=NOW)
    contract = next(e for e in r["rules_excerpts"] if e["id"] == "C-CONTRACT")
    assert contract["quote"].startswith("If Oklahoma City wins")      # rich-text document flattened
    assert "nodeType" not in contract["quote"]
    assert r["event_terms_url_present"] is True                       # live API uses "termsLink"
    assert r["instrument_symbol"] == "GEMI-NBA-2611190100-ATL-OKC-M-OKC"
    assert len(r["sibling_events"]) == 5
    assert (r["market"]["best_bid"], r["market"]["best_ask"]) == ("0.69", "0.7")


def test_real_okc_scores_end_to_end():
    ev = _real_okc()
    ra, ctx = analyze_live("NBA-2611190100-ATL-OKC-M", "Oklahoma City",
                           http_get=lambda url, timeout=None: FakeResp(ev), read_terms=False, now=NOW)
    s = ra.scores
    assert (s.source.score, s.liquidity.score, s.correlation.score) == (1, 1, 3)
    assert s.ambiguity.score == 2 and "terms PDF not read" in s.ambiguity.rationale
    assert generate_purchase_request(ra, ctx) is None                 # no material resolution gap


def test_team_names_between_and_are_not_band_edges():
    from verity.rules_analyst import _BANDS
    assert not _BANDS.search("the game between Oklahoma City and Atlanta")
    assert _BANDS.search("62°F to 63°F") and _BANDS.search("between 62 and 63")
    assert _BANDS.search("$61,500 or above")


def test_real_okc_with_terms_read_is_low():
    ev = _real_okc()
    rec = rules_analyst(build_live_record(ev, "Oklahoma City", now=NOW,
                                          terms_text="Settles on the official result of the game between Oklahoma City and Atlanta."))
    assert rec["analyst"]["ambiguity"]["score"] == 1
