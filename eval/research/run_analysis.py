"""Scores evaluation records with the Verity analysis code. Reads fixtures only; no network, no keys.

  python eval/research/run_analysis.py < jobs.json > results.json

Each job: {"id", "record", "analyst": "code" | "given", "free_check_scenario", "evidence"}.
"code" clears the record's analyst scores and gaps and runs the code-only rules analyst;
"given" keeps them. "evidence" (optional) is {"body_utf8", "provenance"}; the string
"$PROPOSAL_GAP" in provenance.evidence_gap_id becomes the gap the analysis proposed to buy.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "analysis"))

from verity.analysis import get_risk_analysis  # noqa: E402
from verity.fixtures import FixtureContext  # noqa: E402
from verity.proposals import generate_purchase_request  # noqa: E402
from verity.reassess import reassess  # noqa: E402
from verity.rules_analyst import rules_analyst  # noqa: E402


def run(job: dict) -> dict:
    record = json.loads(json.dumps(job["record"]))
    if job.get("analyst", "code") == "code":
        record.pop("analyst", None)
        record.pop("evidence_gaps", None)
        record.pop("workbook", None)
        rules_analyst(record)
    cid = record["contract_id"]
    ctx = FixtureContext.default(free_check_scenario=job.get("free_check_scenario"))
    ctx.markets = {cid: record}
    ra = get_risk_analysis(cid, ctx)
    log: list[str] = []
    proposal = generate_purchase_request(ra, ctx, decision_log=log)
    out = {
        "id": job["id"],
        "scores": {k: getattr(ra.scores, k).score for k in ("ambiguity", "source", "liquidity", "correlation")},
        "null_reasons": {k: getattr(ra.scores, k).null_reason for k in ("ambiguity", "source", "liquidity", "correlation")},
        "score_citations": {k: getattr(ra.scores, k).citation_ids for k in ("ambiguity", "source", "liquidity", "correlation")},
        "rating": {"final": ra.rating.final_rating, "total": ra.rating.raw_total, "complete": ra.rating.complete},
        "research_action": ra.research_action,
        "citations": [{"id": c.id, "field_or_rule": c.field_or_rule, "quote": c.quote} for c in ra.citations],
        "rationales": {k: getattr(ra.scores, k).rationale for k in ("ambiguity", "source", "liquidity", "correlation")},
        "gaps": [{"id": g.id, "gap_type": g.gap_type, "material": g.material, "affects": g.affects} for g in ra.evidence_gaps],
        "quoted_price": ra.quoted_price.model_dump(mode="json") if ra.quoted_price else None,
        "decision": "buy" if proposal else "abstain",
        "decision_log": log,
        "proposal": {"gap_id": proposal.evidence_gap_id, "catalog_item_id": proposal.catalog_item_id} if proposal else None,
        "reassessment": None,
    }
    ev = job.get("evidence")
    if ev:
        prov = dict(ev["provenance"])
        if prov.get("evidence_gap_id") == "$PROPOSAL_GAP":
            prov["evidence_gap_id"] = proposal.evidence_gap_id if proposal else "GAP-NONE"
        r = reassess(ra, ev["body_utf8"].encode("utf-8"), prov, ctx)
        out["reassessment"] = {
            "status": r.status,
            "reason": r.reason,
            "changes": [c.model_dump(mode="json") for c in r.changes],
            "evidence_citation": r.evidence_citation.model_dump(mode="json") if r.evidence_citation else None,
            "revised_scores": {k: getattr(r.revised.scores, k).score for k in ("ambiguity", "source", "liquidity", "correlation")},
            "revised_score_citations": {k: getattr(r.revised.scores, k).citation_ids for k in ("ambiguity", "source", "liquidity", "correlation")},
            "revised_rating": {"final": r.revised.rating.final_rating, "total": r.revised.rating.raw_total},
        }
    return out


def main() -> int:
    jobs = json.loads(sys.stdin.buffer.read().decode("utf-8"))
    results = []
    for job in jobs:
        try:
            results.append(run(job))
        except Exception as error:  # report, do not hide, a crash on one case
            results.append({"id": job["id"], "error": f"{type(error).__name__}: {error}"})
    sys.stdout.buffer.write(json.dumps(results, ensure_ascii=False).encode("utf-8"))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
