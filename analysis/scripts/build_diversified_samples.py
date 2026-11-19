"""Build a live sample pack that follows Gemini's real category mix.

Target: ~80% Sports / ~20% non-sports (Weather + Commodities + Crypto),
matching the live board (~80% sports).
"""
from __future__ import annotations

import json
import sys
import urllib.request
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from verity.live import analyze_live, fetch_event  # noqa: E402
from verity.proposals import generate_purchase_request  # noqa: E402

# 100 samples => 80 sports + 20 non-sports  (80/20)
N_SPORTS = 80
N_NON_SPORTS = 20

# Prefer these non-sports anchors when still live (demo-relevant).
PREFERRED_NON_SPORTS = [
    "WXHIGH-CHI-2611200459",  # Midway story
    "WXHIGH-NYC-2611200459",
    "BRENT2611192200",
    "BTC2611192200",
    "XAG2611192200",
    "ETH2611192200",
    "WTI2611192200",
    "SOL2611192200",
    "NGAS2611192200",
    "WXHIGH-ATL-2611200459",
    "WXHIGH-BOS-2611200459",
]


def pick_outcome(contracts: list[dict]) -> str | None:
    scored: list[tuple[int, str]] = []
    for c in contracts:
        label = c.get("label")
        if not label:
            continue
        p = c.get("prices") or {}
        bid, ask, last = p.get("bestBid"), p.get("bestAsk"), p.get("lastTradePrice")
        score = 0
        if bid is not None and ask is not None:
            score += 3
        if last is not None:
            score += 1
        try:
            if bid is not None and ask is not None:
                mid = (float(bid) + float(ask)) / 2
                if 0.2 <= mid <= 0.8:
                    score += 2
        except Exception:
            pass
        scored.append((score, label))
    scored.sort(reverse=True)
    return scored[0][1] if scored else None


def list_events(limit_pages: int = 20) -> list[dict]:
    events: list[dict] = []
    offset = 0
    for _ in range(limit_pages):
        url = f"https://api.gemini.com/v1/prediction-markets/events?limit=50&offset={offset}"
        req = urllib.request.Request(url, headers={"User-Agent": "verity-samples/1.0"})
        with urllib.request.urlopen(req, timeout=30) as resp:
            data = json.loads(resp.read().decode())
        batch = data.get("data") or []
        if not batch:
            break
        events.extend(batch)
        offset += len(batch)
    return events


def has_tradeable_outcome(event: dict) -> bool:
    return pick_outcome(event.get("contracts") or []) is not None


def sports_family(ticker: str) -> str:
    """Coarse league/family for diversified sports picks (NBA, NFL, MLS, …)."""
    head = (ticker or "").split("-", 1)[0]
    return head or "OTHER"


def _unique(tickers: list[str]) -> list[str]:
    seen: set[str] = set()
    out: list[str] = []
    for t in tickers:
        if t in seen:
            continue
        seen.add(t)
        out.append(t)
    return out


def choose_tickers(events: list[dict]) -> tuple[list[str], list[str]]:
    by_ticker = {e.get("ticker"): e for e in events if e.get("ticker")}
    sports = _unique(
        [
            e["ticker"]
            for e in events
            if e.get("category") == "Sports" and e.get("ticker") and has_tradeable_outcome(e)
        ]
    )
    non = _unique(
        [
            e["ticker"]
            for e in events
            if e.get("category") != "Sports" and e.get("ticker") and has_tradeable_outcome(e)
        ]
    )

    # Prefer demo anchors for the non-sports 20%.
    non_selected: list[str] = []
    for t in PREFERRED_NON_SPORTS:
        if t in by_ticker and by_ticker[t].get("category") != "Sports" and has_tradeable_outcome(by_ticker[t]):
            if t not in non_selected:
                non_selected.append(t)
        if len(non_selected) >= N_NON_SPORTS:
            break
    for t in non:
        if t not in non_selected:
            non_selected.append(t)
        if len(non_selected) >= N_NON_SPORTS:
            break

    # Round-robin across sports families so the pack is not all one league.
    by_family: dict[str, list[str]] = defaultdict(list)
    for t in sports:
        by_family[sports_family(t)].append(t)
    sports_selected: list[str] = []
    families = sorted(by_family.keys())
    while len(sports_selected) < N_SPORTS and any(by_family.values()):
        for fam in families:
            bucket = by_family[fam]
            if not bucket:
                continue
            sports_selected.append(bucket.pop(0))
            if len(sports_selected) >= N_SPORTS:
                break

    # If not enough in listed pages, keep what we have (mix note will show actual %).
    return sports_selected, non_selected[:N_NON_SPORTS]


def analyze_one(ticker: str) -> dict:
    ev = fetch_event(ticker)
    outcome = pick_outcome(ev.get("contracts") or [])
    if not outcome:
        return {"ticker": ticker, "error": "no outcome"}
    ra, ctx = analyze_live(ticker, outcome, read_terms=True, analyst="rules")
    log: list[str] = []
    prop = generate_purchase_request(ra, ctx, decision_log=log)
    return {
        "ticker": ticker,
        "event": ev,
        "ra": ra,
        "prop": prop,
        "log": log,
        "row": {
            "ticker": ticker,
            "category": ev.get("category"),
            "title": ev.get("title"),
            "outcome": outcome,
            "sourceDetails": ev.get("sourceDetails"),
            "action": ra.research_action,
            "scores": {
                "ambiguity": ra.scores.ambiguity.score,
                "source": ra.scores.source.score,
                "liquidity": ra.scores.liquidity.score,
                "correlation": ra.scores.correlation.score,
            },
            "has_proposal": prop is not None,
            "proposal_item": None if prop is None else prop.catalog_item_id,
        },
    }


def main() -> None:
    day = datetime.now(timezone.utc).date().isoformat()
    out = ROOT / "samples" / f"diversified_{day}"
    if out.exists():
        for p in out.iterdir():
            if p.is_file():
                p.unlink()
    out.mkdir(parents=True, exist_ok=True)

    print("Listing live Gemini events...")
    events = list_events()
    sports, non_sports = choose_tickers(events)
    tickers = sports + non_sports
    print(f"Selected {len(sports)} sports + {len(non_sports)} non-sports = {len(tickers)}")

    rows: list[dict] = []
    for ticker in tickers:
        try:
            result = analyze_one(ticker)
            if "error" in result:
                rows.append(result)
                print("SKIP", ticker, result["error"])
                continue
            ev, ra, prop, log, row = (
                result["event"],
                result["ra"],
                result["prop"],
                result["log"],
                result["row"],
            )
            safe = ticker.replace("/", "-")
            (out / f"{safe}.event.json").write_text(json.dumps(ev, indent=2), encoding="utf-8")
            (out / f"{safe}.analysis.json").write_text(
                json.dumps(
                    {
                        "risk_analysis": ra.model_dump(mode="json"),
                        "purchase_proposal": None if prop is None else prop.model_dump(mode="json"),
                        "decision_log": log,
                    },
                    indent=2,
                    ensure_ascii=False,
                )
                + "\n",
                encoding="utf-8",
            )
            rows.append(row)
            print(
                f"OK {str(row['category']):12} {ticker} "
                f"proposal={row['has_proposal']} item={row['proposal_item']}"
            )
        except Exception as ex:
            print("ERR", ticker, type(ex).__name__, ex)
            rows.append({"ticker": ticker, "error": f"{type(ex).__name__}: {ex}"})

    ok = [r for r in rows if "error" not in r]
    sports_n = sum(1 for r in ok if r.get("category") == "Sports")
    other_n = len(ok) - sports_n
    total = max(len(ok), 1)
    mix = {
        "target": "80% sports / 20% non-sports (follow live Gemini board)",
        "sports": sports_n,
        "non_sports": other_n,
        "sports_pct": round(100 * sports_n / total, 1),
        "non_sports_pct": round(100 * other_n / total, 1),
    }

    (out / "INDEX.json").write_text(
        json.dumps({"mix": mix, "samples": rows}, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )

    by: dict[str, list[dict]] = defaultdict(list)
    for r in rows:
        key = r.get("category") or ("ERROR" if "error" in r else "?")
        by[key].append(r)

    lines = [
        f"# Diversified Gemini samples ({day})",
        "",
        f"Target mix: **80% sports / 20% non-sports** "
        f"(actual {mix['sports_pct']}% / {mix['non_sports_pct']}% "
        f"= {sports_n}/{other_n} of {len(ok)}).",
        "Follows the live Gemini board split (~80% sports).",
        "",
    ]
    for cat in ["Sports", "Weather", "Commodities", "Crypto", "ERROR", "?"]:
        if cat not in by:
            continue
        lines.append(f"## {cat} ({len(by[cat])})")
        for r in by[cat]:
            if "error" in r:
                lines.append(f"- `{r['ticker']}` ERROR: {r['error']}")
                continue
            prop = r["proposal_item"] if r["has_proposal"] else "none"
            sc = r["scores"]
            lines.append(
                f"- `{r['ticker']}` — {r['title']} | outcome `{r['outcome']}` | "
                f"A/S/L/C {sc['ambiguity']}/{sc['source']}/{sc['liquidity']}/{sc['correlation']} | "
                f"{r['action']} | proposal `{prop}`"
            )
        lines.append("")

    (out / "INDEX.md").write_text("\n".join(lines) + "\n", encoding="utf-8")
    print("MIX", mix)
    print("Wrote", out)


if __name__ == "__main__":
    main()
