"""Code-only analyst for live markets: no LLM, no API key.

Scores Resolution criteria, Source reliability, and Outside events from the
Gemini Exchange record using the Gemini Market Risk Analysis.xlsx Framework
(0-2 per factor). Stored on the record as schema 1-3 (excel + 1) so the rest
of Verity keeps working. Liquidity and price quality are computed in scoring.py.
"""
from __future__ import annotations

import re
from typing import Any, Optional

from .scoring import to_schema

ANALYST_ID = "verity-excel-v1"

# Source reliability (Excel 0-2). Highest risk first.
_SOURCE_RULES: list[tuple[int, re.Pattern[str], str]] = [
    (2, re.compile(r"leaderboard|lm ?arena|lmsys|social|followers|views|likes|ranking|"
                   r"\bmecone\b|nowcast|hyperliquid|perpetual|\bperp\b|KK_RFR_", re.I),
     "proxy or private source"),
    (1, re.compile(
        r"\bnws\b|national weather service|climatolog|\bcli[a-z]{3}\b|"
        r"\bpreliminary\b|subject to revision|later revision|data revisions?|"
        r"revised (print|figure|estimate|issuance)|revisable|"
        r"\bbls\b|\bcpi\b|nonfarm|payrolls|\bgdp\b|bureau of|kaiko",
        re.I,
    ), "thinner feed, third-party copy, or revisable official data"),
    (0, re.compile(
        r"statscore|sportradar|lukka|"
        r"\bnba\b|\bnfl\b|\bnhl\b|\bmlb\b|\bncaa\b|\bmls\b|league|"
        r"federal reserve|\bfomc\b|governing body|official (result|score)",
        re.I,
    ), "official source that measures the thing itself"),
]

_REVISABLE_ISSUANCE = re.compile(
    r"\bpreliminary\b|subject to revision|later revision|data revisions?|"
    r"revised (print|figure|estimate|issuance)|which issuance|corrected issuance",
    re.I,
)
_PROXY_SOURCE = re.compile(r"hyperliquid|perpetual|\bperp\b|KK_RFR_|kaiko-equities|\bmecone\b|nowcast", re.I)

_JUDGMENT = re.compile(
    r"style control|top[- ]ranked|\bbest\b|at (its|the exchange's) (sole )?discretion|"
    r"determined by gemini|subjective|never defines|left undefined",
    re.I,
)
_BANDS = re.compile(
    r"\d+\s*°?\s*[fc]?\s*(to|-|–)\s*\d+\s*°|\bbetween\s+\$?\d[\d.,]*\S*\s+and\s+\$?\d|"
    r"\d[\d.,]*\s*°?\s*[fc]?\s+or\s+(more|higher|above|less|lower|below)",
    re.I,
)
_SCHEDULED_DATA = re.compile(
    r"\bcpi\b|jobs report|nonfarm|payrolls|fomc|federal reserve|fed speak|"
    r"injur|earnings|\bgdp\b|\bbls\b|\bbea\b",
    re.I,
)
_TITLE_STATION = re.compile(r"\bmidway\b|\bo'?hare\b|\bairport\b", re.I)
_UNDEFINED = re.compile(r"never defines|left undefined|does not define|not defined", re.I)


def _cat(excel: Optional[int], rationale: str, cites: list[str], null_reason: Optional[str] = None) -> dict[str, Any]:
    score = None if excel is None else to_schema(excel)
    return {
        "score": score,
        "rationale": rationale,
        "null_reason": null_reason if score is None else None,
        "citation_ids": cites,
        "excel_0_2": excel,
    }


def _text(record: dict[str, Any]) -> tuple[str, list[str]]:
    ex = [e for e in record["rules_excerpts"] if e["id"] != "C-PRICES" and "prices" not in e["field_or_rule"]]
    return "\n".join(e["quote"] for e in ex), [e["id"] for e in ex]


def _resolution(record: dict[str, Any], text: str, ids: list[str]) -> dict[str, Any]:
    """Excel Resolution criteria 0-2."""
    if not text.strip():
        return _cat(None, "No rule text in the record.", [], "no description or terms text to read")
    if _UNDEFINED.search(text) or (_JUDGMENT.search(text) and re.search(r"up/?down|undefined", text, re.I)):
        return _cat(2, "The rule leaves the outcome undefined or contradictory.", ids)

    terms_read = any(e["id"] == "C-TERMS" for e in record["rules_excerpts"])
    needs = []
    if _JUDGMENT.search(text):
        needs.append("judgment / ranking / discretion in the rules")
    if not terms_read:
        needs.append("terms PDF not read")
    if record.get("event_terms_url_present") is False:
        needs.append("event-level terms link is empty")
    if _BANDS.search(record.get("outcome_label", "") + "\n" + text):
        needs.append("numeric band edges decide the outcome")
    title = record.get("question") or record.get("title") or ""
    settlement = record.get("settlement_source") or ""
    if _TITLE_STATION.search(text + " " + settlement) and re.search(
        r"chicago|nyc|new york|boston|atlanta|temperature|high", title, re.I,
    ):
        needs.append("title names a city/measure that may differ from the settlement station")
    if needs:
        return _cat(1, "Needs judgment: " + "; ".join(needs) + ".", ids)
    return _cat(0, "Clear threshold, exact time, named source, simple fallback.", ids)


def _source(record: dict[str, Any], text: str, ids: list[str]) -> dict[str, Any]:
    """Excel Source reliability 0-2."""
    settlement = record.get("settlement_source") or ""
    hay = " ".join(filter(None, [settlement, text]))
    if not hay.strip():
        return _cat(None, "No settlement source in the record.", [], "settlement source not stated")

    proxy = _PROXY_SOURCE.search(settlement) or _PROXY_SOURCE.search(hay)
    if proxy:
        label = proxy.group(0)
        if re.search(r"mecone|nowcast", label, re.I):
            return _cat(2, f"Private/nowcast index (matched '{label}').", ids)
        return _cat(2, f"Proxy source: crypto perp / RFR index (matched '{label}').", ids)

    primary = re.search(
        r"statscore|sportradar|lukka|\bnba\b|\bnfl\b|\bnhl\b|\bmlb\b|\bncaa\b|\bmls\b",
        settlement,
        re.I,
    )
    if primary:
        if _REVISABLE_ISSUANCE.search(text):
            return _cat(
                1,
                f"Primary feed '{primary.group(0)}', but terms discuss revisable/preliminary issuance.",
                ids,
            )
        return _cat(0, f"Official primary source (matched '{primary.group(0)}').", ids)

    for excel, pat, label in _SOURCE_RULES:
        m = pat.search(hay)
        if m:
            return _cat(excel, f"Settlement source looks like {label} (matched '{m.group(0)}').", ids)
    return _cat(None, "Settlement source is named but matches no Framework rule.", ids,
                "settlement source not recognized by the rules; a person should score it")


def _outside_events(record: dict[str, Any], text: str, ids: list[str]) -> dict[str, Any]:
    """Excel Outside events 0-2 (stored as correlation). Context only."""
    hay = text + " " + (record.get("question") or "")
    if _SCHEDULED_DATA.search(hay):
        if re.search(r"\bbls\b|\bbea\b|\bgdp\b|\bcpi\b|payrolls", hay, re.I):
            return _cat(2, "Depends on a government data release that could be delayed.", ids)
        return _cat(1, "Normal news risk before expiry (scheduled data / injuries named).", ids)
    sib = [s for s in (record.get("sibling_events") or []) if s]
    if sib and not _same_question_band_siblings(record.get("event_ticker") or "", sib):
        # Overlapping markets: Excel Agent rule 11 (sizing). Treat as mild outside context.
        return _cat(1, f"{len(sib)} sibling event(s) on the same underlying (exposure context).", ids)
    return _cat(0, "Nothing pending that looks likely to swing or delay settlement.", ids)


def _same_question_band_siblings(ticker: str, siblings: list[str]) -> bool:
    if not ticker or not siblings:
        return False
    if ticker.startswith("WXHIGH-"):
        parts = ticker.split("-")
        if len(parts) >= 2:
            city_prefix = f"{parts[0]}-{parts[1]}-"
            return all(s.startswith(city_prefix) for s in siblings)
    m = re.match(r"^([A-Z]+)\d{6,}", ticker)
    if m:
        stem = m.group(1)
        return all(re.match(rf"^{re.escape(stem)}\d{{6,}}", s) for s in siblings)
    return False


def _gaps(source: dict[str, Any], resolution: dict[str, Any], hay: str) -> list[dict[str, Any]]:
    gaps = []
    # Source excel >= 1 (schema >= 2): settlement edge worth researching
    if source.get("excel_0_2") is not None and source["excel_0_2"] >= 1:
        gaps.append({
            "id": "GAP-1", "gap_type": "settlement_source_version", "affects": "resolution_risk", "material": True,
            "question": "Which issuance / underlying does Gemini use to settle, and how does it differ from the headline?",
            "why": "Source reliability is elevated: revisable official data or a proxy feed.",
            "free_checks": [],
        })
    if source.get("excel_0_2") == 2 or (
        resolution.get("excel_0_2") == 2 and re.search(r"leaderboard|arena", hay, re.I)
    ):
        gaps.append({
            "id": f"GAP-{len(gaps) + 1}", "gap_type": "leaderboard_snapshot", "affects": "resolution_risk", "material": True,
            "question": "Which view and timestamp of the ranking or private index settles the contract?",
            "why": "The ranking/index can move or diverge from the official print.",
            "free_checks": [],
        })
    return gaps


_WEATHER_FREE_CHECKS = {
    "WXHIGH-NYC": "nyc-settlement-version",
    "WXHIGH-CHI": "chi-midway-settlement-version",
    "WXHIGH-ATL": "atl-settlement-version",
    "WXHIGH-BOS": "bos-settlement-version",
}
_SPORTS_PREFIXES = (
    "NBA-", "NFL-", "NHL-", "MLB-", "NCAAM-", "NCAAF-", "NCAA-", "MLS-",
    "UCL-", "LIGAMX-", "EPL-", "ATP-", "WTA-", "UFC-", "F1-",
)
_COMMODITY_PREFIXES = ("BRENT", "WTI", "XAG", "XAU", "NGAS", "OIL", "COPPER", "CORN", "SOY", "WHEAT")
_CRYPTO_PREFIXES = ("BTC", "ETH", "SOL", "XRP", "DOGE", "ADA", "AVAX")


def _check_for_ticker(ticker: str, gap_type: str) -> Optional[str]:
    if gap_type != "settlement_source_version" or not ticker:
        return None
    for prefix, check in _WEATHER_FREE_CHECKS.items():
        if ticker.startswith(prefix):
            return check
    if any(ticker.startswith(p) for p in _SPORTS_PREFIXES):
        return "sports-settlement-version"
    if any(ticker.startswith(p) for p in _COMMODITY_PREFIXES):
        return "commodity-settlement-version"
    if any(ticker.startswith(p) for p in _CRYPTO_PREFIXES):
        return "crypto-settlement-version"
    return None


def _attach_free_checks(record: dict[str, Any], gaps: list[dict[str, Any]]) -> None:
    ticker = record.get("event_ticker") or ""
    for g in gaps:
        check = _check_for_ticker(ticker, g["gap_type"])
        if check:
            g["free_checks"] = [check]


def _researchable(resolution: dict[str, Any], source: dict[str, Any], gaps: list[dict[str, Any]]) -> Optional[bool]:
    """Excel Researchable?: Yes / No / n/a."""
    res_x = resolution.get("excel_0_2")
    src_x = source.get("excel_0_2")
    if res_x is None or src_x is None:
        return None
    if res_x + src_x == 0:
        return None  # n/a — no settlement edge
    if res_x == 2:
        return False  # undefined outcome — research cannot settle it
    if gaps:
        return True
    return True


def rules_analyst(record: dict[str, Any]) -> dict[str, Any]:
    """Write analyst scores and evidence gaps into a live record. Pure function of the record."""
    text, ids = _text(record)
    resolution = _resolution(record, text, ids)
    source = _source(record, text, ids)
    outside = _outside_events(record, text, ids)
    # Schema field names stay ambiguity / source / correlation.
    amb = {k: v for k, v in resolution.items() if k != "excel_0_2"}
    src = {k: v for k, v in source.items() if k != "excel_0_2"}
    cor = {k: v for k, v in outside.items() if k != "excel_0_2"}
    record["analyst"] = {"ambiguity": amb, "source": src, "correlation": cor}
    record["evidence_gaps"] = _gaps(source, resolution, " ".join(filter(None, [record.get("settlement_source"), text])))
    _attach_free_checks(record, record["evidence_gaps"])
    record["researchable"] = _researchable(resolution, source, record["evidence_gaps"])
    record["excel_factors"] = {
        "resolution_criteria": resolution.get("excel_0_2"),
        "source_reliability": source.get("excel_0_2"),
        "outside_events": outside.get("excel_0_2"),
    }
    record["analyst_id"] = ANALYST_ID
    return record
