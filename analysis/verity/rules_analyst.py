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
_SOURCE_RULES: list[tuple[int, re.Pattern[str], str]] = [
    (3, re.compile(r"leaderboard|lm ?arena|lmsys|social|followers|views|likes|ranking", re.I),
     "third-party ranking that changes continuously or can be gamed"),
    (2, re.compile(r"\bnws\b|national weather service|climatolog|\bcli[a-z]{3}\b|preliminary|revis|"
                   r"\bbls\b|\bcpi\b|nonfarm|payrolls|\bgdp\b|bureau of", re.I),
     "official but revisable or preliminary data"),
    (1, re.compile(r"\bnba\b|\bnfl\b|\bnhl\b|\bmlb\b|\bncaa\b|\bmls\b|league|federal reserve|\bfomc\b|"
                   r"governing body|official (result|score)", re.I),
     "official primary source"),
]

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
    if missing:
        return _cat(2, "Clear outcome, but " + "; ".join(missing) + ".", ids)
    return _cat(1, "Objective outcome; the terms were read and name the rule.", ids)


def _source(record: dict[str, Any], text: str, ids: list[str]) -> dict[str, Any]:
    hay = " ".join(filter(None, [record.get("settlement_source"), text]))
    if not hay.strip():
        return _cat(None, "No settlement source in the record.", [], "settlement source not stated")
    for score, pat, label in _SOURCE_RULES:
        m = pat.search(hay)
        if m:
            return _cat(score, f"Settlement source looks like {label} (matched '{m.group(0)}').", ids)
    return _cat(None, "Settlement source is named but matches no Framework rule.", ids,
                "settlement source not recognized by the rules; a person should score it")


def _correlation(record: dict[str, Any], text: str, ids: list[str]) -> dict[str, Any]:
    sib = record.get("sibling_events") or []
    if sib:
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


def rules_analyst(record: dict[str, Any]) -> dict[str, Any]:
    """Write analyst scores and evidence gaps into a live record. Pure function of the record."""
    text, ids = _text(record)
    amb = _ambiguity(record, text, ids)
    src = _source(record, text, ids)
    cor = _correlation(record, text, ids)
    record["analyst"] = {"ambiguity": amb, "source": src, "correlation": cor}
    record["evidence_gaps"] = _gaps(src, amb, " ".join(filter(None, [record.get("settlement_source"), text])))
    record["analyst_id"] = ANALYST_ID
    return record
