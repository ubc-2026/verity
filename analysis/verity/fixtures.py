"""Fixture loading and an explicit clock. Nothing here touches the network."""
from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

FIXTURE_DIR = Path(__file__).resolve().parent.parent / "fixtures"

# Fixture clock: Tue 2026-11-17 20:00 ET, the evening the workbook was captured.
FIXTURE_NOW = "2026-11-18T01:00:00Z"


def parse_utc(s: str) -> datetime:
    return datetime.fromisoformat(s.replace("Z", "+00:00")).astimezone(timezone.utc)


def fmt_utc(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


@dataclass(frozen=True)
class FixedClock:
    now_utc: str = FIXTURE_NOW

    def now(self) -> datetime:
        return parse_utc(self.now_utc)


def _load(name: str) -> dict[str, Any]:
    with open(FIXTURE_DIR / name, encoding="utf-8") as f:
        return json.load(f)


def canonical_hash(record: dict[str, Any]) -> str:
    blob = json.dumps(record, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return "sha256:" + hashlib.sha256(blob.encode("utf-8")).hexdigest()


@dataclass
class FixtureContext:
    """Everything the slice reads, injected so tests can swap any part."""

    clock: FixedClock = field(default_factory=FixedClock)
    markets: dict[str, dict[str, Any]] = field(default_factory=dict)
    catalog: dict[str, Any] = field(default_factory=dict)
    free_checks: dict[str, Any] = field(default_factory=dict)
    cached_evidence: dict[tuple[str, str], str] = field(default_factory=dict)
    free_check_scenario: Optional[str] = None   # which labeled fixture outcome to use

    @classmethod
    def default(cls, **overrides: Any) -> "FixtureContext":
        mk = _load("markets_2026-11-17.json")
        ctx = cls(
            markets={m["contract_id"]: m for m in mk["markets"]},
            catalog=_load("catalog_v1.json"),
            free_checks=_load("free_checks.json")["checks"],
        )
        for k, v in overrides.items():
            setattr(ctx, k, v)
        return ctx
