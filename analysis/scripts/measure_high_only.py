"""Measure High-only proposal rate on the diversified sample pack."""
from __future__ import annotations

import json
import sys
from collections import Counter, defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from verity.fixtures import FixedClock, FixtureContext  # noqa: E402
from verity.proposals import generate_purchase_request  # noqa: E402
from verity.schemas import RiskAnalysisV1  # noqa: E402

PACK = ROOT / "samples" / "diversified_2026-11-19"


def main() -> None:
    idx = json.loads((PACK / "INDEX.json").read_text(encoding="utf-8"))
    samples = [s for s in idx["samples"] if "error" not in s]
    print("MIX", idx["mix"])
    print("n", len(samples))

    ratings: Counter[str] = Counter()
    by_rating_prop: dict[str, list[int]] = defaultdict(lambda: [0, 0])
    props = 0
    high_rows: list[dict] = []

    for s in samples:
        t = s["ticker"]
        data = json.loads((PACK / f"{t}.analysis.json").read_text(encoding="utf-8"))
        ev = json.loads((PACK / f"{t}.event.json").read_text(encoding="utf-8"))
        ra = RiskAnalysisV1.model_validate(data["risk_analysis"])
        rating = ra.rating.final_rating or "incomplete"
        ratings[rating] += 1

        ctx = FixtureContext.default(
            live_research=True,
            clock=FixedClock(ra.snapshot.snapshot_time_utc),
        )
        terms = next(
            (
                c.get("termsAndConditionsUrl")
                for c in (ev.get("contracts") or [])
                if c.get("termsAndConditionsUrl")
            ),
            None,
        )
        ctx.markets = {**ctx.markets, ra.contract_id: {"terms_url": terms}}
        prop = generate_purchase_request(ra, ctx, [])
        by_rating_prop[rating][0] += 1
        if prop:
            props += 1
            by_rating_prop[rating][1] += 1
            high_rows.append(
                {
                    "ticker": t,
                    "category": s.get("category"),
                    "title": s.get("title"),
                    "total": ra.rating.raw_total,
                    "item": prop.catalog_item_id,
                    "scores": {
                        "A": ra.scores.ambiguity.score,
                        "S": ra.scores.source.score,
                        "L": ra.scores.liquidity.score,
                        "C": ra.scores.correlation.score,
                    },
                }
            )

    pct = round(100 * props / max(len(samples), 1), 1)
    print("ratings", dict(ratings))
    print(f"High-only proposes: {props}/{len(samples)} ({pct}%)")
    for r, (n, p) in sorted(by_rating_prop.items()):
        print(f"  {r}: {p}/{n}")
    print("buys:")
    for row in high_rows:
        sc = row["scores"]
        print(
            f"  {row['ticker']} [{row['category']}] tot={row['total']} "
            f"A/S/L/C={sc['A']}/{sc['S']}/{sc['L']}/{sc['C']} -> {row['item']}"
        )

    out = {
        "n": len(samples),
        "mix": idx["mix"],
        "ratings": dict(ratings),
        "proposed": props,
        "propose_pct": pct,
        "gate": "High-only",
        "buys": high_rows,
    }
    (PACK / "HIGH_ONLY_100.json").write_text(json.dumps(out, indent=2) + "\n", encoding="utf-8")

    lines = [
        "# 100-market pack — High-only buys",
        "",
        f"Pack: **{len(samples)}** markets (80/20). Gate: **High-only**.",
        f"Proposals: **{props}/{len(samples)}** ({pct}%).",
        "",
        "## Rating mix",
        "",
    ]
    for r, n in ratings.most_common():
        p = by_rating_prop[r][1]
        lines.append(f"- **{r}**: {n} markets, {p} propose")
    lines += ["", "## Buys", ""]
    if not high_rows:
        lines.append("(none)")
    for row in high_rows:
        sc = row["scores"]
        lines.append(
            f"- `{row['ticker']}` — {row['title']} | {row['category']} | "
            f"A/S/L/C {sc['A']}/{sc['S']}/{sc['L']}/{sc['C']} total {row['total']} | "
            f"`{row['item']}`"
        )
    (PACK / "HIGH_ONLY_100.md").write_text("\n".join(lines) + "\n", encoding="utf-8")
    print("Wrote", PACK / "HIGH_ONLY_100.md")


if __name__ == "__main__":
    main()
