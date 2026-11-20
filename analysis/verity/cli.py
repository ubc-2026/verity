"""JSON command line for the connected workflow. The live command reads public sources.

  python -m verity.cli analyze --contract fx-nyc-high-20261118 [--free-check-scenario observed-2026-11-18]
  python -m verity.cli analyze-live --event WXHIGH-SFO-2611200459 --outcome '58°F to 59°F'
  python -m verity.cli reassess < request.json

`reassess` reads {"risk_analysis": {...}, "body_b64": "...", "provenance": {...}} on stdin.
Both commands print one JSON object on stdout.
"""
from __future__ import annotations

import argparse
import base64
import json
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .analysis import get_risk_analysis
from .fixtures import FixedClock, FixtureContext, fmt_utc
from .live import analyze_live
from .proposals import generate_purchase_request
from .reassess import reassess
from .schemas import RiskAnalysisV1
from .trends import research_market


def _emit(value: Any) -> None:
    sys.stdout.buffer.write(json.dumps(value, indent=2, ensure_ascii=False).encode("utf-8") + b"\n")


def analyze(contract_id: str, scenario: str | None, rail: str = "arc-eip3009") -> dict[str, Any]:
    ctx = FixtureContext.default(free_check_scenario=scenario, payment_rail=rail)
    if contract_id not in ctx.markets:
        raise SystemExit(f"unknown contract {contract_id!r}; known: {', '.join(sorted(ctx.markets))}")
    research = research_market(ctx.markets[contract_id], ctx.clock.now())
    ra = get_risk_analysis(contract_id, ctx)
    return {"research": research.model_dump(mode="json"), **_analysis_result(ra, ctx)}


def _analysis_result(ra: RiskAnalysisV1, ctx: FixtureContext) -> dict[str, Any]:
    log: list[str] = []
    proposal = generate_purchase_request(ra, ctx, decision_log=log)
    reason = None
    if proposal is None:
        # The specific gap decisions first (forecast skips are not purchase candidates), then the verdict.
        specific = [line for line in log if " skip " in line and "outcome forecast" not in line]
        reason = " ".join([*specific, log[-1]] if log and log[-1] not in specific else specific) or "no proposal"
    return {
        "risk_analysis": ra.model_dump(mode="json"),
        "purchase_proposal": proposal.model_dump(mode="json") if proposal else None,
        "no_purchase_reason": reason,
        "decision_log": log,
    }


def reassess_from(request: dict[str, Any], evidence_catalog: dict[str, Any] | None = None) -> dict[str, Any]:
    original = RiskAnalysisV1.model_validate(request["risk_analysis"])
    body = base64.b64decode(request["body_b64"], validate=True)
    ctx = None
    if original.snapshot.source_mode == "live":
        ctx = FixtureContext.default(clock=FixedClock(fmt_utc(datetime.now(timezone.utc))))
        if evidence_catalog is not None:
            ctx.catalog = evidence_catalog
    return reassess(original, body, request["provenance"], ctx).model_dump(mode="json")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m verity.cli")
    sub = parser.add_subparsers(dest="command", required=True)
    a = sub.add_parser("analyze")
    a.add_argument("--contract", required=True)
    a.add_argument("--free-check-scenario", default=None)
    a.add_argument("--rail", default="arc-eip3009", choices=["arc-eip3009", "circle-gateway-batched"])
    live = sub.add_parser("analyze-live")
    live.add_argument("--event", required=True)
    live.add_argument("--outcome", required=True)
    live.add_argument("--rail", default="circle-gateway-batched", choices=["arc-eip3009", "circle-gateway-batched"])
    live.add_argument("--evidence-catalog", type=Path, help="Trusted operator catalog with evidence approved for exact live contract IDs")
    reassess_command = sub.add_parser("reassess")
    reassess_command.add_argument("--evidence-catalog", type=Path, help="Trusted operator catalog used for the live proposal")
    args = parser.parse_args(argv)
    if args.command == "analyze":
        _emit(analyze(args.contract, args.free_check_scenario, args.rail))
    elif args.command == "analyze-live":
        ra, ctx = analyze_live(args.event, args.outcome)
        ctx.payment_rail = args.rail
        if args.evidence_catalog:
            ctx.catalog = json.loads(args.evidence_catalog.read_text(encoding="utf-8"))
        _emit(_analysis_result(ra, ctx))
    else:
        catalog = json.loads(args.evidence_catalog.read_text(encoding="utf-8")) if args.evidence_catalog else None
        _emit(reassess_from(json.loads(sys.stdin.buffer.read().decode("utf-8")), catalog))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
