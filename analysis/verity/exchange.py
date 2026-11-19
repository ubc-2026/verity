"""Guarded Gemini Exchange client: every account action passes through one policy gate.

Defaults are the safest possible:
  * sandbox (api.sandbox.gemini.com); production needs VERITY_EXCHANGE_ENV=production
    AND VERITY_ALLOW_PRODUCTION=yes
  * dry run: orders are built, checked and logged, but NOT sent, unless dry_run=False
  * no withdrawal, transfer or deposit method exists, and such paths are refused
  * limit orders only, with a hard cap per order and per day, a symbol allowlist,
    a price band around the analysed quote, and owner approval above a threshold
  * a pause switch (VERITY_TRADING_PAUSED=1) stops every write
  * every decision, allowed or refused, is appended to an audit log (JSON lines)
  * a write whose outcome is unknown (timeout) blocks further writes on that
    symbol until someone reconciles it

Keys come from GEMINI_EXCHANGE_API_KEY / GEMINI_EXCHANGE_API_SECRET on the machine
that runs this. Create the key with the narrowest role you need (Auditor for
read-only; Trader only if orders are really required) and never with Fund Manager.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import time
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from decimal import Decimal, InvalidOperation
from pathlib import Path
from typing import Any, Callable, Literal, Optional

from pydantic import BaseModel, ConfigDict, field_validator

BASE_URLS = {"sandbox": "https://api.sandbox.gemini.com", "production": "https://api.gemini.com"}
FORBIDDEN_PATH_WORDS = ("withdraw", "transfer", "deposit", "payout", "approvedaddresses", "account/create")

READ_PATHS = {
    "terms_status": ("GET", "/v1/prediction-markets/terms/status"),
    "positions": ("POST", "/v1/prediction-markets/positions"),
    "balances": ("POST", "/v1/balances"),
}
WRITE_PATHS = {
    "place_order": "/v1/prediction-markets/order",
    "cancel_order": "/v1/prediction-markets/order/cancel",
}


class ExchangeRefused(RuntimeError):
    """Raised when the policy gate refuses an action. The audit log has the reason."""


# --- signing ------------------------------------------------------------------

def sign(path: str, params: dict[str, Any], api_key: str, api_secret: str, nonce: str) -> dict[str, str]:
    """Gemini private REST auth: JSON {request, nonce, ...} -> base64 -> hex HMAC-SHA384."""
    payload = {"request": path, "nonce": nonce, **params}
    b64 = base64.b64encode(json.dumps(payload).encode())
    sig = hmac.new(api_secret.encode(), b64, hashlib.sha384).hexdigest()
    return {
        "Content-Type": "text/plain",
        "Content-Length": "0",
        "Cache-Control": "no-cache",
        "X-GEMINI-APIKEY": api_key,
        "X-GEMINI-PAYLOAD": b64.decode(),
        "X-GEMINI-SIGNATURE": sig,
    }


# --- order request --------------------------------------------------------------

class OrderRequest(BaseModel):
    """What the agent may ask for. Only limit orders; prices strictly inside (0, 1)."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    symbol: str
    side: Literal["buy", "sell"]
    outcome: Literal["yes", "no"]
    quantity: str
    price: str
    time_in_force: Literal["good-til-cancel", "immediate-or-cancel", "fill-or-kill"] = "immediate-or-cancel"
    maker_or_cancel: bool = False
    reason: str
    analysis_ref: Optional[str] = None   # contract_id of the RiskAnalysisV1 behind this order

    @field_validator("quantity", "price")
    @classmethod
    def _decimal(cls, v: str) -> str:
        try:
            d = Decimal(v)
        except InvalidOperation as e:
            raise ValueError(f"{v!r} is not a decimal string") from e
        if d <= 0:
            raise ValueError("must be positive")
        return v

    @field_validator("price")
    @classmethod
    def _price_band(cls, v: str) -> str:
        if not Decimal("0") < Decimal(v) < Decimal("1"):
            raise ValueError("price must be strictly between 0 and 1")
        return v

    def notional_usd(self) -> Decimal:
        return Decimal(self.quantity) * Decimal(self.price)

    def api_params(self) -> dict[str, Any]:
        return {"symbol": self.symbol, "orderType": "limit", "side": self.side, "outcome": self.outcome,
                "quantity": self.quantity, "price": self.price, "timeInForce": self.time_in_force,
                "makerOrCancel": self.maker_or_cancel}


# --- policy -----------------------------------------------------------------------

@dataclass
class ApprovalResult:
    approved: bool
    approver: str
    evidence: str          # e.g. id of the owner's EIP-712 approval checked by the payment service


Approver = Callable[[dict[str, Any]], ApprovalResult]


def deny_all(_: dict[str, Any]) -> ApprovalResult:
    return ApprovalResult(False, "none", "no approver configured; default is deny")


@dataclass
class TradingPolicy:
    max_order_usd: Decimal = Decimal("5.00")          # hard cap per order
    max_daily_usd: Decimal = Decimal("25.00")         # sent orders + unknown outcomes
    auto_approve_max_usd: Decimal = Decimal("1.00")   # above this, the owner must approve
    max_price_deviation: Decimal = Decimal("0.05")    # vs. the analysed best ask/bid
    min_time_to_expiry: timedelta = timedelta(hours=1)
    symbol_allowlist: set[str] = field(default_factory=set)
    allow_high_risk: bool = False                     # refuse markets flagged for human review


# --- audit log --------------------------------------------------------------------

class AuditLog:
    def __init__(self, path: Path):
        self.path = path
        self.path.parent.mkdir(parents=True, exist_ok=True)

    def append(self, entry: dict[str, Any]) -> None:
        entry = {"at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"), **entry}
        with open(self.path, "a", encoding="utf-8") as f:
            f.write(json.dumps(entry, ensure_ascii=False, default=str) + "\n")

    def entries(self) -> list[dict[str, Any]]:
        if not self.path.exists():
            return []
        return [json.loads(l) for l in self.path.read_text(encoding="utf-8").splitlines() if l.strip()]


# --- client -----------------------------------------------------------------------

HttpCall = Callable[..., Any]   # requests.request-compatible: (method, url, headers=..., timeout=...)


class GuardedExchange:
    def __init__(
        self,
        policy: TradingPolicy,
        audit: AuditLog,
        *,
        approver: Approver = deny_all,
        dry_run: bool = True,
        env: Optional[str] = None,
        api_key: Optional[str] = None,
        api_secret: Optional[str] = None,
        http: Optional[HttpCall] = None,
        clock: Callable[[], datetime] = lambda: datetime.now(timezone.utc),
        nonce: Callable[[], str] = lambda: str(int(time.time() * 1000)),
    ):
        env = env or os.environ.get("VERITY_EXCHANGE_ENV", "sandbox")
        if env not in BASE_URLS:
            raise ValueError(f"unknown exchange env {env!r}")
        if env == "production" and os.environ.get("VERITY_ALLOW_PRODUCTION") != "yes":
            raise ExchangeRefused("production needs VERITY_ALLOW_PRODUCTION=yes in addition to VERITY_EXCHANGE_ENV")
        self.env, self.base = env, BASE_URLS[env]
        self.policy, self.audit, self.approver, self.dry_run = policy, audit, approver, dry_run
        self._key = api_key or os.environ.get("GEMINI_EXCHANGE_API_KEY")
        self._secret = api_secret or os.environ.get("GEMINI_EXCHANGE_API_SECRET")
        self._http = http
        self._clock, self._nonce = clock, nonce
        # Rebuilt from the audit log so a restart cannot forget an unreconciled order.
        self._unknown_symbols: set[str] = set()
        for e in self.audit.entries():
            if e.get("env") != self.env:
                continue
            if e.get("action") == "place_order" and e.get("decision") == "outcome_unknown":
                self._unknown_symbols.add(e.get("symbol"))
            elif e.get("action") == "reconcile":
                self._unknown_symbols.discard(e.get("symbol"))

    # -- plumbing
    def _call(self, method: str, path: str, params: dict[str, Any]) -> Any:
        if any(w in path.lower() for w in FORBIDDEN_PATH_WORDS):
            raise ExchangeRefused(f"path {path} is never allowed (funds movement)")
        if not (self._key and self._secret):
            raise ExchangeRefused("set GEMINI_EXCHANGE_API_KEY and GEMINI_EXCHANGE_API_SECRET; never commit them")
        http = self._http
        if http is None:
            import requests
            http = requests.request
        headers = sign(path, params, self._key, self._secret, self._nonce())
        r = http(method, self.base + path, headers=headers, timeout=15)
        r.raise_for_status()
        return r.json()

    def _log(self, action: str, decision: str, reason: str, **extra: Any) -> None:
        self.audit.append({"at": self._clock().strftime("%Y-%m-%dT%H:%M:%SZ"), "env": self.env,
                           "dry_run": self.dry_run, "action": action,
                           "decision": decision, "reason": reason, **extra})

    def _spent_today(self) -> Decimal:
        today = self._clock().date().isoformat()
        total = Decimal("0")
        for e in self.audit.entries():
            if e.get("action") == "place_order" and e.get("decision") in ("sent", "outcome_unknown") \
                    and str(e.get("at", "")).startswith(today) and e.get("env") == self.env:
                total += Decimal(str(e.get("notional_usd", "0")))
        return total

    # -- reads (Auditor role is enough)
    def read(self, what: str) -> Any:
        if what not in READ_PATHS:
            raise ExchangeRefused(f"unknown read {what!r}")
        method, path = READ_PATHS[what]
        out = self._call(method, path, {})
        self._log(what, "read", "read-only call")
        return out

    # -- writes
    def place_order(self, order: OrderRequest, *, analysis: Any = None) -> dict[str, Any]:
        """Check every rule, then send (or, in dry run, only log). Raises ExchangeRefused on any 'no'."""
        p = self.policy
        notional = order.notional_usd()
        base = {"symbol": order.symbol, "notional_usd": str(notional), "order": order.model_dump()}

        def refuse(reason: str) -> None:
            self._log("place_order", "refused", reason, **base)
            raise ExchangeRefused(reason)

        if os.environ.get("VERITY_TRADING_PAUSED") == "1":
            refuse("trading is paused (VERITY_TRADING_PAUSED=1)")
        if order.symbol in self._unknown_symbols:
            refuse("an earlier order on this symbol has an unknown outcome; reconcile it first")
        if order.symbol not in p.symbol_allowlist:
            refuse(f"symbol {order.symbol} is not on the allowlist")
        if analysis is None:
            refuse("no RiskAnalysisV1 supplied; orders must follow an analysis of the same contract")
        if analysis.instrument_symbol != order.symbol:
            refuse("analysis is for a different instrument")
        if analysis.research_action == "flag_for_human_review" and not p.allow_high_risk:
            refuse("analysis flags this market for human review")
        expiry = datetime.fromisoformat(analysis.expiry_utc.replace("Z", "+00:00"))
        if expiry - self._clock() < p.min_time_to_expiry:
            refuse("market is less than the minimum time from expiry")
        ref = analysis.quoted_price.best_ask if order.side == "buy" else analysis.quoted_price.best_bid
        if ref is None:
            refuse("no reference quote in the analysis for this side")
        if abs(Decimal(order.price) - Decimal(ref)) > p.max_price_deviation:
            refuse(f"price {order.price} is more than {p.max_price_deviation} from the analysed quote {ref}")
        if notional > p.max_order_usd:
            refuse(f"order ${notional} exceeds the per-order cap ${p.max_order_usd}")
        if self._spent_today() + notional > p.max_daily_usd:
            refuse(f"order would exceed the daily cap ${p.max_daily_usd}")

        approval = None
        if notional > p.auto_approve_max_usd:
            approval = self.approver({"symbol": order.symbol, "notional_usd": str(notional),
                                      "side": order.side, "outcome": order.outcome, "reason": order.reason})
            if not approval.approved:
                refuse(f"owner approval required above ${p.auto_approve_max_usd} and not given ({approval.evidence})")
            base["approval"] = {"approver": approval.approver, "evidence": approval.evidence}

        params = order.api_params()
        if self.dry_run:
            self._log("place_order", "dry_run", "all checks passed; not sent (dry run)", request=params, **base)
            return {"dry_run": True, "request": params}

        try:
            resp = self._call("POST", WRITE_PATHS["place_order"], params)
        except ExchangeRefused:
            raise
        except Exception as e:  # timeout or network: the order may or may not exist
            self._unknown_symbols.add(order.symbol)
            self._log("place_order", "outcome_unknown", f"{type(e).__name__}; reconcile before retrying",
                      request=params, **base)
            raise
        self._log("place_order", "sent", "accepted by exchange (not necessarily filled)",
                  request=params, response=resp, **base)
        return resp

    def cancel_order(self, order_id: int, reason: str) -> dict[str, Any]:
        if self.dry_run:
            self._log("cancel_order", "dry_run", reason, order_id=order_id)
            return {"dry_run": True, "orderId": order_id}
        resp = self._call("POST", WRITE_PATHS["cancel_order"], {"orderId": order_id})
        self._log("cancel_order", "sent", reason, order_id=order_id, response=resp)
        return resp

    def mark_reconciled(self, symbol: str, note: str) -> None:
        """Clear an unknown-outcome block after a human or the reconciler has checked the exchange."""
        self._unknown_symbols.discard(symbol)
        self._log("reconcile", "cleared", note, symbol=symbol)
