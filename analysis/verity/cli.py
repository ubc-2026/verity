"""JSON command line for the connected workflow. Reads fixtures only; no network, no keys.

  python -m verity.cli analyze --contract fx-nyc-high-20261118 [--free-check-scenario observed-2026-11-18]
  python -m verity.cli reassess < request.json

`reassess` reads {"risk_analysis": {...}, "body_b64": "...", "provenance": {...}} on stdin.
Both commands print one JSON object on stdout.
"""
from __future__ import annotations

import argparse
import base64
import json
import sys
from typing import Any

from .analysis import get_risk_analysis
from .fixtures import FixtureContext
from .proposals import generate_purchase_request
from .reassess import reassess
from .schemas import RiskAnalysisV1
from .trends import research_market


def _emit(value: Any) -> None:
    sys.stdout.buffer.write(json.dumps(value, indent=2, ensure_ascii=False).encode("utf-8") + b"\n")


def analyze(contract_id: str, scenario: str | None) -> dict[str, Any]:
    ctx = FixtureContext.default(free_check_scenario=scenario)
    if contract_id not in ctx.markets:
        raise SystemExit(f"unknown contract {contract_id!r}; known: {', '.join(sorted(ctx.markets))}")
    research = research_market(ctx.markets[contract_id], ctx.clock.now())
    ra = get_risk_analysis(contract_id, ctx)
    log: list[str] = []
    proposal = generate_purchase_request(ra, ctx, decision_log=log)
    reason = None
    if proposal is None:
        # The specific gap decisions first (forecast skips are not purchase candidates), then the verdict.
        specific = [line for line in log if " skip " in line and "outcome forecast" not in line]
        reason = " ".join([*specific, log[-1]] if log and log[-1] not in specific else specific) or "no proposal"
    return {
        "research": research.model_dump(mode="json"),
        "risk_analysis": ra.model_dump(mode="json"),
        "purchase_proposal": proposal.model_dump(mode="json") if proposal else None,
        "no_purchase_reason": reason,
        "decision_log": log,
    }


def reassess_from(request: dict[str, Any]) -> dict[str, Any]:
    original = RiskAnalysisV1.model_validate(request["risk_analysis"])
    body = base64.b64decode(request["body_b64"], validate=True)
    return reassess(original, body, request["provenance"]).model_dump(mode="json")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m verity.cli")
    sub = parser.add_subparsers(dest="command", required=True)
    a = sub.add_parser("analyze")
    a.add_argument("--contract", required=True)
    a.add_argument("--free-check-scenario", default=None)
    sub.add_parser("reassess")
    args = parser.parse_args(argv)
    if args.command == "analyze":
        _emit(analyze(args.contract, args.free_check_scenario))
    else:
        _emit(reassess_from(json.loads(sys.stdin.buffer.read().decode("utf-8"))))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
