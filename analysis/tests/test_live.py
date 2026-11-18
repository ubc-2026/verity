"""Live path with both APIs faked: no network, no key."""
import io
from datetime import datetime, timezone

import pytest

from verity import generate_purchase_request
from verity.live import analyze_live, build_live_record
from verity.llm import AnalystOut, apply_analyst, build_prompt

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


MODEL_JSON = {
    "ambiguity": {"score": 2, "rationale": "Band edges decide it.", "citation_ids": ["C-EVENT", "C-NOPE"]},
    "source": {"score": 2, "rationale": "NWS report can be corrected.", "citation_ids": ["C-EVENT"]},
    "correlation": {"score": 7, "rationale": "bad value", "citation_ids": []},
    "evidence_gaps": [
        {"question": "Which CLI issuance settles?", "gap_type": "settlement_source_version",
         "affects": "resolution_risk", "material": True, "why": "Corrections can cross a band edge."},
        {"question": "What will the max be?", "gap_type": "outcome_forecast",
         "affects": "outcome_probability", "material": True, "why": "Forecast."},
    ],
}


class FakeModels:
    def __init__(self):
        self.calls = []

    def generate_content(self, *, model, contents, config):
        self.calls.append({"model": model, "contents": contents, "config": config})
        class R:  # mimics GenerateContentResponse.parsed
            parsed = AnalystOut.model_validate(MODEL_JSON)
            text = ""
        return R()


class FakeClient:
    def __init__(self):
        self.models = FakeModels()


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


def test_prompt_excludes_prices_and_marks_data():
    p = build_prompt(build_live_record(EVENT, "62°F to 63°F", now=NOW))
    assert "C-PRICES" not in p and "0.54" not in p


def test_model_output_is_repaired_and_flagged():
    r = apply_analyst(build_live_record(EVENT, "62°F to 63°F", now=NOW), AnalystOut.model_validate(MODEL_JSON))
    assert r["analyst"]["correlation"]["score"] is None
    assert "outside 1-3" in r["analyst"]["correlation"]["null_reason"]
    assert r["analyst"]["ambiguity"]["citation_ids"] == ["C-EVENT"]
    assert "model_citation_dropped:ambiguity" in r["model_flags"]
    assert r["evidence_gaps"][1]["material"] is False  # forecasts never count as material


def test_analyze_live_end_to_end_with_fakes():
    client = FakeClient()
    ra, ctx = analyze_live("WXHIGH-NYC-2611190459", "62°F to 63°F",
                           http_get=fake_get, client=client, model="fake-model", now=NOW)
    call = client.models.calls[0]
    assert call["model"] == "fake-model" and call["config"]["response_schema"] is AnalystOut
    assert ra.snapshot.source_mode == "live"
    assert ra.scores.liquidity.score == 3                 # computed in code from $7 volume
    assert ra.rating.complete is False                    # correlation came back invalid
    assert ra.rating.possible_range == ("Medium", "High")   # known 7 + one unknown
    assert ra.rating.final_rating is None and ra.research_action == "flag_for_human_review"
    assert any(f.startswith("terms_not_read") for f in ra.data_quality_flags)
    assert "analyst=google-gemini (fake-model)" in ra.data_quality_flags
    assert ra.workbook_conflicts  # global notes still attached; no workbook row to compare

    log = []
    assert generate_purchase_request(ra, ctx, log) is None   # no live free check yet -> no purchase
    assert any("no free official-source check is configured" in l for l in log)


def test_missing_key_or_model_fails_clearly(monkeypatch):
    from verity.llm import gemini_analyst
    rec = build_live_record(EVENT, "62°F to 63°F", now=NOW)
    monkeypatch.delenv("VERITY_GEMINI_MODEL", raising=False)
    with pytest.raises(RuntimeError, match="VERITY_GEMINI_MODEL"):
        gemini_analyst(rec)
    monkeypatch.delenv("GEMINI_API_KEY", raising=False)
    with pytest.raises(RuntimeError, match="GEMINI_API_KEY"):
        gemini_analyst(rec, model="m")
