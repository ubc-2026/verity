"""Live path with the exchange API faked: no network, no key."""
import hashlib
import json
from copy import deepcopy
from datetime import datetime, timezone

import pytest

from verity import generate_purchase_request
from verity.live import analyze_live, build_live_record
from verity.reassess import reassess
from verity.research import NWS_CLISFO_URL

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
        self.text = content.decode("utf-8")

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


def _sfo_research(monkeypatch, *, selection="The first published version of the applicable report is used.", report_status=200):
    event = deepcopy(EVENT)
    event["ticker"] = "WXHIGH-SFO-2611200459"
    event["title"] = "Highest temperature in San Francisco on November 19, 2026?"
    event["expiryDate"] = "2026-11-20T04:59:59Z"
    event["sourceDetails"] = {"agency": "NWS", "index": "CLISFO"}
    contract = event["contracts"][0]
    contract["instrumentSymbol"] = "GEMI-WXHIGH-SFO-2611200459-58TO59"
    contract["termsAndConditionsUrl"] = ""
    url = "https://assets.gemini.com/predictions/terms_and_conditions/weather.pdf"
    contract["description"] = f"San Francisco Airport uses the NWS daily climate report. {selection} [Full rules]({url})."
    calls = []

    def get(target, timeout=None):
        calls.append(target)
        if target.endswith("/events/" + event["ticker"]):
            return FakeResp(event)
        assert target == NWS_CLISFO_URL
        return FakeResp(content=b"CLISFO\nSAN FRANCISCO AIRPORT CLIMATE SUMMARY\nVALID TODAY AS OF 0400 PM LOCAL TIME.", status=report_status)

    def terms(target, _get):
        assert target == url
        calls.append(target)
        return "Gemini's official weather terms.", None

    monkeypatch.setattr("verity.live.fetch_terms_text", terms)
    risk, ctx = analyze_live(event["ticker"], contract["label"], http_get=get, now=NOW)
    assert ctx.markets[risk.contract_id]["terms_url"] == url
    assert risk.evidence_gaps[0].free_checks == ["sfo-settlement-version"]
    return risk, ctx, calls


def test_sfo_live_free_sources_precede_exact_live_catalog(monkeypatch):
    risk, ctx, calls = _sfo_research(monkeypatch)
    log = []
    assert generate_purchase_request(risk, ctx, log) is None
    assert calls[-1] == NWS_CLISFO_URL
    assert len(calls) == 3  # market, linked PDF, station report
    assert any("free research unresolved" in line for line in log)
    assert any("for this live contract" in line for line in log)

    # Simulated operator-approved catalog entry. The repository ships no such live artifact.
    original = ctx.catalog["items"][0]
    ctx.payment_rail = "circle-gateway-batched"
    item = {**original, "id": "sfo-live-test-evidence", "live_contract_id": risk.contract_id,
            "rail": ctx.payment_rail, "price_base_units": "1000"}
    ctx.catalog["items"] = [{**item, "id": "unrelated-live-test-evidence", "live_contract_id": "different-contract"}, item]
    log = []
    proposal = generate_purchase_request(risk, ctx, log)
    assert proposal is not None and proposal.catalog_item_id == item["id"]
    assert proposal.catalog_parameters == {"station": "San Francisco Airport, CA (CLISFO)", "date": "2026-11-19"}
    assert proposal.max_amount_base_units == "1000" and proposal.signed is False
    assert any("0.001 USDC" in line for line in log)

    # The receipt verifier supplies this provenance in a real run.
    doc = {"source": "test merchant", "gap_type": proposal.evidence_type, **proposal.catalog_parameters,
           "settling_issuance": "first full-day report", "excludes": [], "corrections_count": False,
           "summary": "The first full-day report controls."}
    provenance = {"purchase_id": "purchase-test", "contract_id": risk.contract_id,
                  "evidence_gap_id": proposal.evidence_gap_id, "catalog_item_id": proposal.catalog_item_id,
                  "merchant_id": item["merchant_id"], "request_hash": "request", "content_hash_keccak256": "content",
                  "receipt_digest": "digest", "receipt_signer": "signer", "verified_by": "verifyGatewayDelivery",
                  "payment_rail": ctx.payment_rail, "payment_ref": "test-transfer"}
    for label, status in [("FIXTURE", "evidence_rejected"), ("LIVE", "revised")]:
        body = json.dumps({**doc, "label": label}).encode()
        result = reassess(risk, body, {**provenance, "data_label": label,
                                      "content_sha256": "0x" + hashlib.sha256(body).hexdigest()}, ctx)
        assert result.status == status, result.reason
    assert result.revised.scores.source.score == 1


@pytest.mark.parametrize("selection,report_status,status", [
    ("Settlement shall use the first full-day NWS daily report.", 200, "resolved"),
    ("The first published version of the applicable report is used.", 404, "failed"),
])
def test_sfo_recognizes_resolved_or_failed_official_checks(monkeypatch, selection, report_status, status):
    risk, ctx, _calls = _sfo_research(monkeypatch, selection=selection, report_status=report_status)
    ctx.catalog["items"][0]["live_contract_id"] = risk.contract_id
    log = []
    assert generate_purchase_request(risk, ctx, log) is None
    assert any(f"free research {status}" in line for line in log)


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
