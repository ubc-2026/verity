"""Offline scoring-mix experiments on the diversified pack."""
from __future__ import annotations

import json
import re
from collections import Counter
from pathlib import Path

from verity.schemas import RiskAnalysisV1

ROOT = Path(__file__).resolve().parents[1]
PACK = ROOT / "samples" / "diversified_2026-11-19"


def _max(a, b):
    order = {"Low": 0, "Medium": 1, "High": 2}
    return a if b is None or order[a] >= order[b] else b


def soft_liquidity(rationale: str, old: int | None) -> int:
    rat = rationale or ""
    if "No two-sided" in rat:
        return 3
    m = re.search(r"(\d+)c spread", rat)
    if not m:
        return old or 2
    spread = int(m.group(1))
    if spread > 15:
        return 3
    vol_m = re.search(r"\$([0-9.,]+)", rat)
    vol = float(vol_m.group(1).replace(",", "")) if vol_m else 0.0
    if vol >= 1000 and spread <= 5:
        return 1
    return 2


def rate(a, s, l, c, p):
    tot = a + s + l + c
    floor = None
    if p.get("amb_src3_med") and (a == 3 or s == 3):
        floor = "Medium"
    if p.get("src2_med") and s >= 2:
        floor = _max("Medium", floor)
    if p.get("liq3_med") and l == 3:
        floor = _max("Medium", floor)
    if p.get("corr3_high") and c == 3:
        floor = _max("High", floor)
    if p.get("src2_amb2_high") and s >= 2 and a >= 2:
        floor = _max("High", floor)
    if p.get("dual3_high") and sum(1 for v in (a, s, l, c) if v == 3) >= 2:
        floor = _max("High", floor)
    if p.get("amb2_liq3_high") and a >= 2 and l == 3:
        floor = _max("High", floor)
    hi = p.get("hi", 9)
    med = p.get("med", 7)
    raw = "High" if tot >= hi else "Medium" if tot >= med else "Low"
    return _max(raw, floor), raw, tot, floor


def load_rows():
    idx = json.loads((PACK / "INDEX.json").read_text(encoding="utf-8"))
    rows = []
    for row in idx["samples"]:
        if "error" in row:
            continue
        data = json.loads((PACK / f"{row['ticker']}.analysis.json").read_text(encoding="utf-8"))
        ra = RiskAnalysisV1.model_validate(data["risk_analysis"])
        ep = PACK / f"{row['ticker']}.event.json"
        ev = json.loads(ep.read_text(encoding="utf-8")) if ep.exists() else {}
        sd = ev.get("sourceDetails") or {}
        settlement = " ".join(str(x) for x in (sd.values() if isinstance(sd, dict) else [sd]) if x)
        A = ra.scores.ambiguity.score
        S = ra.scores.source.score
        C = ra.scores.correlation.score
        L = soft_liquidity(ra.scores.liquidity.rationale, ra.scores.liquidity.score)
        if re.search(r"hyperliquid|perp|KK_RFR|mecone|nowcast", settlement, re.I):
            S = max(S or 1, 2)
        if re.search(r"mecone|nowcast", settlement, re.I):
            S = max(S or 1, 3)
        rows.append({
            "t": row["ticker"], "cat": row.get("category"),
            "A": A, "S": S, "L": L, "C": C,
            "oldL": ra.scores.liquidity.score,
        })
    return rows


def main():
    rows = load_rows()
    print("L remap", Counter(r["L"] for r in rows), "was", Counter(r["oldL"] for r in rows))
    print("S after proxy", Counter(r["S"] for r in rows))
    cands = {
        "softL only current floors": {"amb_src3_med": 1, "corr3_high": 1, "hi": 9, "med": 7},
        "softL + src2med + liq3med": {"amb_src3_med": 1, "corr3_high": 1, "src2_med": 1, "liq3_med": 1, "hi": 9, "med": 7},
        "softL + src2med + liq3med + src2amb2H": {
            "amb_src3_med": 1, "corr3_high": 1, "src2_med": 1, "liq3_med": 1, "src2_amb2_high": 1, "hi": 9, "med": 7,
        },
        "softL + src2amb2H + dual3 + hi8": {
            "amb_src3_med": 1, "corr3_high": 1, "src2_med": 1, "liq3_med": 1,
            "src2_amb2_high": 1, "dual3_high": 1, "hi": 8, "med": 7,
        },
        "softL + src2amb2H no liq floor": {
            "amb_src3_med": 1, "corr3_high": 1, "src2_med": 1, "src2_amb2_high": 1, "hi": 9, "med": 7,
        },
        "PICK softL+src2med+liq3med+src2amb2H+dual3": {
            "amb_src3_med": 1, "corr3_high": 1, "src2_med": 1, "liq3_med": 1,
            "src2_amb2_high": 1, "dual3_high": 1, "hi": 9, "med": 7,
        },
    }
    for name, p in cands.items():
        ctr = Counter()
        highs, lows = [], []
        for r in rows:
            final, raw, tot, floor = rate(r["A"], r["S"], r["L"], r["C"], p)
            ctr[final] += 1
            tip = (r["t"], (r["A"], r["S"], r["L"], r["C"]), tot, floor, r["cat"])
            if final == "High":
                highs.append(tip)
            if final == "Low":
                lows.append(tip)
        print(f"\n{name}\n  L={ctr['Low']:3} M={ctr['Medium']:3} H={ctr['High']:3}")
        print("  High cats", dict(Counter(h[4] for h in highs)))
        print("  Highs:", len(highs))
        for h in highs[:8]:
            print("   ", h)
        print("  Low sample:", lows[:4])


if __name__ == "__main__":
    main()
