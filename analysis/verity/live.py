"""Live market read from the public Gemini Exchange API (no key needed).

`build_live_record()` turns one event and one outcome into the same record shape
the fixtures use. The feed supplies the contract text, the price, and the
expiry. It does not score ambiguity, source, or correlation, so those stay null.
Liquidity is computed later from the quotes.
"""
from __future__ import annotations

import io
from datetime import datetime, timezone
from typing import Any, Callable, Optional

from .fixtures import fmt_utc

BASE = "https://api.gemini.com/v1/prediction-markets"
TERMS_MAX_CHARS = 6000

HttpGet = Callable[..., Any]  # requests.get-compatible


def _default_get() -> HttpGet:
    import requests  # imported lazily so fixture mode needs no extra package
    return requests.get


def fetch_event(event_ticker: str, http_get: Optional[HttpGet] = None) -> dict[str, Any]:
    get = http_get or _default_get()
    r = get(f"{BASE}/events/{event_ticker}", timeout=15)
    r.raise_for_status()
    return r.json()


def fetch_terms_text(url: str, http_get: Optional[HttpGet] = None) -> tuple[Optional[str], Optional[str]]:
    """Return (text, problem). Needs pypdf; a missing package or a bad PDF is reported, not raised."""
    try:
        from pypdf import PdfReader
    except ImportError:
        return None, "pypdf not installed; terms PDF not read"
    get = http_get or _default_get()
    try:
        r = get(url, timeout=20)
        r.raise_for_status()
        reader = PdfReader(io.BytesIO(r.content))
        text = "\n".join((p.extract_text() or "") for p in reader.pages).strip()
    except Exception as e:  # network, HTTP or PDF errors all lower confidence instead of crashing
        return None, f"terms PDF unreadable: {type(e).__name__}"
    if not text:
        return None, "terms PDF had no extractable text"
    return text[:TERMS_MAX_CHARS], None


def _s(x: Any) -> Optional[str]:
    return None if x in (None, "") else str(x)


def _event_terms_url(event: dict[str, Any]) -> Optional[str]:
    # The live API puts the event-level link in "termsLink"; older docs used "termsAndConditionsUrl".
    return _s(event.get("termsLink")) or _s(event.get("termsAndConditionsUrl"))


def _plain_text(value: Any) -> Optional[str]:
    """Exchange descriptions are a string, or a small document tree with text nodes."""
    if value in (None, ""):
        return None
    if isinstance(value, str):
        text = value.strip()
        return text or None
    if isinstance(value, dict):
        parts: list[str] = []
        if isinstance(value.get("value"), str):
            parts.append(value["value"])
        for child in value.get("content") or []:
            child_text = _plain_text(child)
            if child_text:
                parts.append(child_text)
        text = " ".join(parts).strip()
        return text or None
    return None


def _unscored(name: str) -> dict[str, Any]:
    """A reading score we refuse to invent. Missing is null, not zero."""
    return {
        "score": None,
        "rationale": "The exchange snapshot stores the contract text for a person to read.",
        "null_reason": f"The Gemini Exchange feed does not score {name}.",
        "citation_ids": [],
    }


def build_live_record(
    event: dict[str, Any],
    outcome_label: str,
    *,
    now: Optional[datetime] = None,
    terms_text: Optional[str] = None,
    terms_problem: Optional[str] = None,
) -> dict[str, Any]:
    now = now or datetime.now(timezone.utc)
    contracts = event.get("contracts") or []
    matches = [c for c in contracts if c.get("label") == outcome_label]
    if not matches:
        labels = ", ".join(repr(c.get("label")) for c in contracts) or "none"
        raise KeyError(f"outcome {outcome_label!r} not in event {event.get('ticker')!r}; labels: {labels}")
    c = matches[0]
    p = c.get("prices") or {}
    url = f"{BASE}/events/{event.get('ticker')}"
    terms_url = _s(c.get("termsAndConditionsUrl")) or _event_terms_url(event)

    excerpts = []
    event_text = _plain_text(event.get("description"))
    if event_text:
        excerpts.append({"id": "C-EVENT", "field_or_rule": "event.description", "quote": event_text})
    contract_text = _plain_text(c.get("description"))
    if contract_text:
        excerpts.append({"id": "C-CONTRACT", "field_or_rule": "contract.description", "quote": contract_text})
    if terms_text:
        excerpts.append({"id": "C-TERMS", "field_or_rule": "termsAndConditionsUrl (PDF text, truncated)", "quote": terms_text})
    excerpts.append({"id": "C-PRICES", "field_or_rule": "contract.prices",
                     "quote": f"bestBid {_s(p.get('bestBid'))}, bestAsk {_s(p.get('bestAsk'))}; event volume {_s(event.get('volume'))}"})

    sd = event.get("sourceDetails") or {}
    return {
        "contract_id": c.get("instrumentSymbol") or f"{event.get('ticker')}:{outcome_label}",
        "source": {
            "mode": "live",
            "label": "Gemini Exchange events API",
            "url": url,
            "snapshot_date": now.date().isoformat(),
            "snapshot_time_utc": fmt_utc(now),
        },
        "event_ticker": event.get("ticker"),
        "ticker_status": "confirmed" if event.get("ticker") else "missing",
        "instrument_symbol": c.get("instrumentSymbol"),
        "question": event.get("title") or outcome_label,
        "outcome_label": outcome_label,
        "expiry_utc": c.get("expiryDate") or event.get("expiryDate"),
        "market": {
            "best_bid": _s(p.get("bestBid")),
            "best_ask": _s(p.get("bestAsk")),
            "volume_usd": _s(event.get("volume")),
            "volume_basis": "total",
            "some_strikes_unquoted": any(not (x.get("prices") or {}).get("bestBid") for x in contracts),
        },
        "settlement_source": " / ".join(str(v) for v in (sd.get("agency"), sd.get("index")) if v) or None,
        "terms_url": terms_url,
        "event_terms_url_present": bool(_event_terms_url(event)),
        "terms_problem": terms_problem,
        "rules_excerpts": excerpts,
        "sibling_events": [e.get("ticker") for e in (event.get("events") or []) if e.get("ticker")],
        "evidence_gaps": [],
        "reading_scores_unscored": True,
        "analyst": {
            "ambiguity": _unscored("ambiguity"),
            "source": _unscored("source"),
            "correlation": _unscored("correlation"),
        },
    }


def analyze_live(
    event_ticker: str,
    outcome_label: str,
    *,
    http_get: Optional[HttpGet] = None,
    read_terms: bool = True,
    now: Optional[datetime] = None,
    analyst: str = "rules",
):
    """Fetch one Gemini Exchange event and run the code scoring path.

    analyst="rules" (default) scores ambiguity, source and correlation with the
    code-only Framework rules in rules_analyst.py and names evidence gaps.
    analyst="none" leaves those three scores null for a person to read.
    No LLM and no API key either way.

    Returns (risk_analysis, ctx). Pass the same ctx to generate_purchase_request
    so it uses the same clock and catalog.
    """
    if analyst not in ("rules", "none"):
        raise ValueError(f"analyst must be 'rules' or 'none', not {analyst!r}")
    from .analysis import get_risk_analysis
    from .fixtures import FixedClock, FixtureContext

    now = now or datetime.now(timezone.utc)
    event = fetch_event(event_ticker, http_get)
    contract = next((c for c in event.get("contracts") or [] if c.get("label") == outcome_label), {})
    terms_url = _s(contract.get("termsAndConditionsUrl")) or _event_terms_url(event)
    text, problem = (None, "no terms URL in the event") if not terms_url else (
        fetch_terms_text(terms_url, http_get) if read_terms else (None, "terms reading disabled"))
    record = build_live_record(event, outcome_label, now=now, terms_text=text, terms_problem=problem)
    if analyst == "rules":
        from .rules_analyst import rules_analyst
        record = rules_analyst(record)
        record["reading_scores_unscored"] = False

    ctx = FixtureContext.default(clock=FixedClock(fmt_utc(now)))
    ctx.markets = {**ctx.markets, record["contract_id"]: record}
    return get_risk_analysis(record["contract_id"], ctx), ctx
