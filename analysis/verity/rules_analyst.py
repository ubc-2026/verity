"""Code-only analyst for live markets: no LLM, no API key.

Scores ambiguity, source and correlation from the Gemini Exchange record with
fixed rules taken from the workbook's Framework sheet, and names the evidence
gaps those rules imply. Liquidity is still computed in scoring.py.

When the record does not hold enough to apply a rule, the score is null with a
reason, so the rating shows as incomplete instead of guessing. Every score
cites the excerpt ids it relied on.
"""
from __future__ import annotations

import re
from typing import Any, Optional

ANALYST_ID = "verity-rules-v1"

# Framework Source row: (score, pattern, label). First match wins, highest risk first.
# Do NOT use a bare "revis" stem — sports/commodity PDFs often say "Revisions" in
# boilerplate and were falsely scored as revisable official data (Source=2).
# Kaiko commodity RFR / Hyperliquid perps are proxies (Excel Source reliability 2),
# not primary feeds — do not list bare "kaiko" as primary.
_SOURCE_RULES: list[tuple[int, re.Pattern[str], str]] = [
    (3, re.compile(r"leaderboard|lm ?arena|lmsys|social|followers|views|likes|ranking|"
                   r"\bmecone\b|nowcast", re.I),
     "third-party ranking, private index, or nowcast that can diverge from the official print"),
    (2, re.compile(
        r"\bnws\b|national weather service|climatolog|\bcli[a-z]{3}\b|"
        r"\bpreliminary\b|subject to revision|later revision|data revisions?|"
        r"revised (print|figure|estimate|issuance)|revisable|"
        r"\bbls\b|\bcpi\b|nonfarm|payrolls|\bgdp\b|bureau of|"
        r"hyperliquid|perpetual|\bperp\b|KK_RFR_|kaiko",
        re.I,
    ), "official but revisable data, or a proxy/thinner feed of the real underlying"),
    (1, re.compile(
        r"statscore|sportradar|lukka|"
        r"\bnba\b|\bnfl\b|\bnhl\b|\bmlb\b|\bncaa\b|\bmls\b|league|"
        r"federal reserve|\bfomc\b|governing body|official (result|score)",
        re.I,
    ), "official primary source"),
]
_PROXY_SOURCE = re.compile(r"hyperliquid|perpetual|\bperp\b|KK_RFR_|kaiko-equities|\bmecone\b|nowcast", re.I)
_TITLE_STATION = re.compile(r"\bmidway\b|\bo'?hare\b|\bairport\b", re.I)

# Issuance-style revision language (used to upgrade a primary feed to Source=2).
_REVISABLE_ISSUANCE = re.compile(
    r"\bpreliminary\b|subject to revision|later revision|data revisions?|"
    r"revised (print|figure|estimate|issuance)|which issuance|corrected issuance",
    re.I,
)

_JUDGMENT = re.compile(r"style control|top[- ]ranked|\bbest\b|at (its|the exchange's) (sole )?discretion|"
                       r"determined by gemini|subjective", re.I)
_BANDS = re.compile(r"\d+\s*°?\s*[fc]?\s*(to|-|–)\s*\d+\s*°|\bbetween\s+\$?\d[\d.,]*\S*\s+and\s+\$?\d|"
                    r"\d[\d.,]*\s*°?\s*[fc]?\s+or\s+(more|higher|above|less|lower|below)", re.I)
_SCHEDULED_DATA = re.compile(r"\bcpi\b|jobs report|nonfarm|payrolls|fomc|federal reserve|fed speak|"
                             r"injur|earnings|\bgdp\b", re.I)


def _cat(score: Optional[int], rationale: str, cites: list[str], null_reason: Optional[str] = None) -> dict[str, Any]:
    return {"score": score, "rationale": rationale,
            "null_reason": null_reason if score is None else None, "citation_ids": cites}


def _text(record: dict[str, Any]) -> tuple[str, list[str]]:
    """All rule text except prices, and the excerpt ids it came from."""
    ex = [e for e in record["rules_excerpts"] if e["id"] != "C-PRICES" and "prices" not in e["field_or_rule"]]
    return "\n".join(e["quote"] for e in ex), [e["id"] for e in ex]


def _ambiguity(record: dict[str, Any], text: str, ids: list[str]) -> dict[str, Any]:
    if not text.strip():
        return _cat(None, "No rule text in the record.", [], "no description or terms text to read")
    terms_read = any(e["id"] == "C-TERMS" for e in record["rules_excerpts"])
    if _JUDGMENT.search(text):
        return _cat(3, "Outcome depends on a setting, ranking or judgment named in the rules.", ids)
    missing = []
    if not terms_read:
        missing.append("terms PDF not read")
    if record.get("event_terms_url_present") is False:
        missing.append("event-level terms link is empty (Agent rule 3)")
    if _BANDS.search(record.get("outcome_label", "") + "\n" + text):
        missing.append("numeric band edges decide the outcome")
    # Excel Agent rule 6: title names a different place/measure than the rule.
    title = record.get("question") or record.get("title") or ""
    settlement = record.get("settlement_source") or ""
    if _TITLE_STATION.search(text + " " + settlement) and re.search(
        r"chicago|nyc|new york|boston|atlanta|temperature|high", title, re.I,
    ):
        missing.append("title names a city/measure that may differ from the settlement station (Excel rule 6)")
    if missing:
        return _cat(2, "Clear outcome, but " + "; ".join(missing) + ".", ids)
    return _cat(1, "Objective outcome; the terms were read and name the rule.", ids)


def _source(record: dict[str, Any], text: str, ids: list[str]) -> dict[str, Any]:
    settlement = record.get("settlement_source") or ""
    hay = " ".join(filter(None, [settlement, text]))
    if not hay.strip():
        return _cat(None, "No settlement source in the record.", [], "settlement source not stated")

    # Proxy / private index first (Excel Source reliability 1-2): Kaiko RFR perps, Mecone.
    proxy = _PROXY_SOURCE.search(settlement) or _PROXY_SOURCE.search(hay)
    if proxy:
        label = proxy.group(0)
        if re.search(r"mecone|nowcast", label, re.I):
            return _cat(3, f"Settlement source looks like a private/nowcast index (matched '{label}').", ids)
        return _cat(
            2,
            f"Settlement source looks like a proxy/thinner feed of the real underlying (matched '{label}').",
            ids,
        )

    # Prefer the named Gemini agency/index when it is a primary feed. Only raise to
    # Source=2 if the terms actually discuss preliminary/revisable issuance.
    primary = re.search(
        r"statscore|sportradar|lukka|\bnba\b|\bnfl\b|\bnhl\b|\bmlb\b|\bncaa\b|\bmls\b",
        settlement,
        re.I,
    )
    if primary:
        if _REVISABLE_ISSUANCE.search(text):
            return _cat(
                2,
                f"Primary feed '{primary.group(0)}', but terms discuss revisable/preliminary issuance.",
                ids,
            )
        return _cat(
            1,
            f"Settlement source looks like official primary source (matched '{primary.group(0)}').",
            ids,
        )

    for score, pat, label in _SOURCE_RULES:
        m = pat.search(hay)
        if m:
            return _cat(score, f"Settlement source looks like {label} (matched '{m.group(0)}').", ids)
    return _cat(None, "Settlement source is named but matches no Framework rule.", ids,
                "settlement source not recognized by the rules; a person should score it")

def _same_question_band_siblings(ticker: str, siblings: list[str]) -> bool:
    """Framework: sibling temperature/price bands of the same question stay Correlation 1."""
    if not ticker or not siblings:
        return False
    # Weather city ladder: WXHIGH-CHI-... with other WXHIGH-CHI-...
    if ticker.startswith("WXHIGH-"):
        parts = ticker.split("-")
        if len(parts) >= 2:
            city_prefix = f"{parts[0]}-{parts[1]}-"
            return all(s.startswith(city_prefix) for s in siblings)
    # Same-day crypto/commodity ladders share a letter prefix before the date digits.
    m = re.match(r"^([A-Z]+)\d{6,}", ticker)
    if m:
        stem = m.group(1)
        return all(re.match(rf"^{re.escape(stem)}\d{{6,}}", s) for s in siblings)
    return False


def _correlation(record: dict[str, Any], text: str, ids: list[str]) -> dict[str, Any]:
    sib = [s for s in (record.get("sibling_events") or []) if s]
    ticker = record.get("event_ticker") or ""
    if sib:
        if _same_question_band_siblings(ticker, sib):
            return _cat(
                1,
                f"{len(sib)} sibling band(s) of the same question; treated as stand-alone (Framework).",
                ids,
            )
        return _cat(3, f"{len(sib)} sibling event(s) on the same underlying (Agent rule 7).", ids)
    if _SCHEDULED_DATA.search(text + " " + record.get("question", "")):
        return _cat(2, "Driven by scheduled data or news named in the rules.", ids)
    return _cat(1, "No sibling events and no scheduled data named; treated as stand-alone.", ids)


def _gaps(source: dict[str, Any], ambiguity: dict[str, Any], hay: str) -> list[dict[str, Any]]:
    gaps = []
    if source["score"] == 2:
        gaps.append({
            "id": "GAP-1", "gap_type": "settlement_source_version", "affects": "resolution_risk", "material": True,
            "question": "Which issuance of the settlement data (preliminary, final, or a later correction) does Gemini use to settle?",
            "why": "The source can be revised after first publication, and the version used can decide the outcome.",
            "free_checks": [],
        })
    if source["score"] == 3 or (ambiguity["score"] == 3 and re.search(r"leaderboard|arena", hay, re.I)):
        gaps.append({
            "id": f"GAP-{len(gaps) + 1}", "gap_type": "leaderboard_snapshot", "affects": "resolution_risk", "material": True,
            "question": "Which view and timestamp of the leaderboard settles the contract?",
            "why": "The ranking moves continuously and settings change the order.",
            "free_checks": [],
        })
    return gaps


# Free checks research.py can run for a live gap, by event-ticker family.
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


def rules_analyst(record: dict[str, Any]) -> dict[str, Any]:
    """Write analyst scores and evidence gaps into a live record. Pure function of the record."""
    text, ids = _text(record)
    amb = _ambiguity(record, text, ids)
    src = _source(record, text, ids)
    cor = _correlation(record, text, ids)
    record["analyst"] = {"ambiguity": amb, "source": src, "correlation": cor}
    record["evidence_gaps"] = _gaps(src, amb, " ".join(filter(None, [record.get("settlement_source"), text])))
    _attach_free_checks(record, record["evidence_gaps"])
    record["analyst_id"] = ANALYST_ID
    return record
