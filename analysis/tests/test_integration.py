"""Research and trends, the proposal handoff fields, reassessment, and the JSON CLI."""
import base64
import hashlib
import json
from datetime import timedelta

import pytest
from pydantic import ValidationError

from verity.analysis import get_risk_analysis
from verity.cli import analyze, reassess_from
from verity.fixtures import FixtureContext, parse_utc
from verity.proposals import generate_purchase_request
from verity.reassess import reassess
from verity.schemas import PurchaseProposalV1
from verity.trends import coverage_trend, exa_coverage_sample, load_coverage_samples, normalize_market, price_trend

NYC = "fx-nyc-high-20261118"
OKC = "fx-okc-moneyline-20261118"
NOW = parse_utc("2026-11-18T01:00:00Z")

# Same bytes the demo merchant serves for cat-nws-cli-settlement-version-v1 (src/payments/catalog.ts).
EVIDENCE = {
    "label": "FIXTURE", "source": "nws-cli", "gap_type": "settlement_source_version",
    "station": "Central Park, NY (CLINYC)", "date": "2026-11-18", "settling_issuance": "first_full_day_cli",
    "excludes": ["same-day partial CLINYC valid to 4 PM", "later corrections"], "corrections_count": False,
    "summary": "FIXTURE: the first full-day CLINYC report for 2026-11-18 settles the contract. "
               "The same-day partial report and later corrections do not count.",
}


def body_of(doc):
    return json.dumps(doc, separators=(",", ":")).encode()


def provenance(body, **over):
    p = {
        "purchase_id": "purchase-test", "contract_id": NYC, "evidence_gap_id": "GAP-NYC-SETTLE",
        "catalog_item_id": "cat-nws-cli-settlement-version-v1", "merchant_id": "verity-demo-merchant",
        "request_hash": "0x" + "11" * 32, "content_hash_keccak256": "0x" + "22" * 32,
        "content_sha256": "0x" + hashlib.sha256(body).hexdigest(), "receipt_digest": "0x" + "33" * 32,
        "receipt_signer": "0x" + "44" * 20, "tx_hash": "0x" + "55" * 32, "verified_by": "verifyDelivery",
        "data_label": "FIXTURE",
    }
    p.update(over)
    return p


def nyc():
    return get_risk_analysis(NYC, FixtureContext.default(free_check_scenario="observed-2026-11-18"))


# --- proposal handoff ---------------------------------------------------------

def test_proposal_carries_the_catalog_evidence_type_and_contract_parameters():
    c = FixtureContext.default(free_check_scenario="observed-2026-11-18")
    p = generate_purchase_request(get_risk_analysis(NYC, c), c)
    assert p is not None
    assert p.evidence_type == "settlement_source_version"
    assert p.catalog_parameters == {"station": "Central Park, NY (CLINYC)", "date": "2026-11-18"}


def test_proposal_rejects_an_empty_parameter():
    c = FixtureContext.default(free_check_scenario="observed-2026-11-18")
    p = generate_purchase_request(get_risk_analysis(NYC, c), c)
    with pytest.raises(ValidationError):
        PurchaseProposalV1.model_validate({**p.model_dump(), "catalog_parameters": {"station": "x", "date": " "}})


# --- research and trends --------------------------------------------------------

def test_normalized_market_names_what_is_missing():
    m = normalize_market(FixtureContext.default().markets[NYC])
    assert m.exchange == "gemini" and m.event_ticker == "WXHIGH-NYC-2611190459"
    assert m.instrument_symbol is None and m.observed_utc is None
    assert any(u.startswith("instrument_symbol") for u in m.unavailable)
    assert any(u.startswith("observed_utc") for u in m.unavailable)
    assert m.resolution.terms_url and "C-NYC-4" in m.resolution.rule_excerpt_ids


def test_coverage_counts_recent_against_prior_and_skips_undated_results():
    cov = coverage_trend(load_coverage_samples()[NYC], NOW)
    assert cov.status == "available" and cov.data_label == "CAPTURED"
    assert (cov.recent.count, cov.prior.count, cov.undated_excluded) == (5, 1, 2)
    assert cov.direction == "more_recent"
    assert len(cov.recent.samples) == 3
    assert [s.published_utc for s in cov.recent.samples] == sorted((s.published_utc for s in cov.recent.samples), reverse=True)
    assert "not a price trend" in cov.caveat


def test_coverage_without_a_sample_is_explicitly_unavailable():
    cov = coverage_trend(load_coverage_samples().get(OKC), NOW)
    assert cov.status == "unavailable" and cov.reason and cov.recent is None


def test_price_movement_needs_two_timestamped_prices_for_the_same_instrument():
    nyc_market = normalize_market(FixtureContext.default().markets[NYC])
    assert price_trend(nyc_market, []).status == "unavailable"
    m = nyc_market.model_copy(update={"instrument_symbol": "GEMI-X"})
    one = [{"instrument_symbol": "GEMI-X", "observed_utc": "2026-11-17T20:00:00Z", "mid": "0.50"}]
    assert price_trend(m, one).status == "unavailable"
    other = {"instrument_symbol": "GEMI-Y", "observed_utc": "2026-11-17T22:00:00Z", "mid": "0.90"}
    both = one + [other, {"instrument_symbol": "GEMI-X", "observed_utc": "2026-11-17T21:00:00Z", "mid": "0.56"}]
    t = price_trend(m, both)
    assert t.status == "available" and t.change == "+0.06" and len(t.points) == 2


def test_live_exa_search_is_pinned_and_injected():
    calls = []

    def post(url, body, headers, timeout):
        calls.append((url, body, headers, timeout))
        return {"results": [{"url": "https://example.org/a", "title": "A", "publishedDate": "2026-11-15T10:00:00.000Z"},
                            {"url": "https://example.org/b", "title": None, "publishedDate": None}]}

    sample = exa_coverage_sample("q", NOW, "test-key", post)
    url, body, headers, timeout = calls[0]
    assert url == "https://api.exa.ai/search" and headers["x-api-key"] == "test-key" and timeout <= 10
    assert body["startPublishedDate"] == "2026-11-04T01:00:00Z" and body["endPublishedDate"] == "2026-11-18T01:00:00Z"
    assert sample["data_label"] == "LIVE"
    assert sample["results"][0]["published_utc"] == "2026-11-15T10:00:00Z" and sample["results"][1]["published_utc"] is None


# --- reassessment ---------------------------------------------------------------

def test_verified_evidence_closes_the_gap_and_lowers_the_source_score():
    body = body_of(EVIDENCE)
    r = reassess(nyc(), body, provenance(body))
    assert r.status == "revised"
    assert r.revised.scores.source.score == 1 and r.original.scores.source.score == 2
    assert "GAP-NYC-SETTLE" not in [g.id for g in r.revised.evidence_gaps]
    # Excel Framework: after Source drops, settlement_edge stays Investigate → Medium.
    assert r.revised.rating.final_rating == "Medium"
    assert r.revised.rating.raw_total in (6, 7)
    assert r.evidence_citation.id == "GAP-NYC-SETTLE-EV1"
    assert "GAP-NYC-SETTLE-EV1" in r.revised.scores.source.citation_ids
    final = next(c for c in r.changes if c.finding == "rating.final_rating")
    assert final.changed is False and "Medium band" in final.reason


def test_bytes_that_differ_from_the_verified_delivery_are_rejected():
    body = body_of(EVIDENCE)
    r = reassess(nyc(), body + b" ", provenance(body))
    assert r.status == "evidence_rejected" and r.revised == r.original


def test_evidence_for_other_parameters_is_rejected():
    body = body_of({**EVIDENCE, "date": "2026-11-19"})
    r = reassess(nyc(), body, provenance(body))
    assert r.status == "evidence_rejected" and "needs" in r.reason


def test_unnamed_issuance_leaves_the_assessment_unchanged():
    body = body_of({**EVIDENCE, "settling_issuance": "unknown"})
    r = reassess(nyc(), body, provenance(body))
    assert r.status == "unchanged" and r.revised == r.original


def test_corrections_that_still_count_keep_the_source_score():
    body = body_of({**EVIDENCE, "corrections_count": True})
    r = reassess(nyc(), body, provenance(body))
    assert r.revised.scores.source.score == 2
    assert next(c for c in r.changes if c.finding == "scores.source").changed is False


def test_evidence_for_a_gap_that_is_not_open_or_with_duplicate_keys_is_rejected():
    body = body_of(EVIDENCE)
    assert reassess(nyc(), body, provenance(body, evidence_gap_id="GAP-NOPE")).status == "evidence_rejected"
    dup = b'{"label":"FIXTURE","label":"LIVE"}'
    assert reassess(nyc(), dup, provenance(dup)).status == "evidence_rejected"
    assert reassess(nyc(), body, {"purchase_id": "x"}).status == "evidence_rejected"


# --- CLI ------------------------------------------------------------------------

def test_cli_analyze_reports_the_proposal_or_a_specific_reason():
    out = analyze(NYC, "observed-2026-11-18")
    assert out["purchase_proposal"]["evidence_type"] == "settlement_source_version"
    assert out["research"]["price_trend"]["status"] == "unavailable"
    assert "answered by the free check" in analyze(NYC, "free-check-answers")["no_purchase_reason"]
    okc_reason = analyze(OKC, None)["no_purchase_reason"]
    assert ("no material resolution gap" in okc_reason
            or "Excel action needs Investigate" in okc_reason
            or "rating is Low" in okc_reason)


def test_cli_reassess_round_trip():
    body = body_of(EVIDENCE)
    out = reassess_from({"risk_analysis": nyc().model_dump(mode="json"), "body_b64": base64.b64encode(body).decode(),
                         "provenance": provenance(body)})
    assert out["status"] == "revised"
    json.dumps(out)  # serializable
