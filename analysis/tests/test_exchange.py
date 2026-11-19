"""Guarded exchange: every rule is exercised with a fake transport. No network, no real key."""
import base64
import hashlib
import hmac
import json
from datetime import datetime, timezone
from decimal import Decimal

import pytest

from verity.exchange import (ApprovalResult, AuditLog, ExchangeRefused, GuardedExchange, OrderRequest,
                             TradingPolicy, sign)

NOW = datetime(2026, 11, 18, 1, 0, tzinfo=timezone.utc)
SYM = "GEMI-WXHIGH-NYC-2611190459-B62"


class QP:
    best_bid, best_ask = "0.54", "0.58"


class FakeAnalysis:
    instrument_symbol = SYM
    research_action = "investigate"
    expiry_utc = "2026-11-19T04:59:00Z"
    quoted_price = QP()


class Resp:
    def __init__(self, payload):
        self._p = payload

    def raise_for_status(self):
        pass

    def json(self):
        return self._p


class FakeHttp:
    def __init__(self, fail=False):
        self.calls, self.fail = [], fail

    def __call__(self, method, url, headers=None, timeout=None):
        self.calls.append((method, url, headers))
        if self.fail:
            raise TimeoutError("simulated timeout")
        return Resp({"orderId": 42, "status": "open"})


def order(**kw):
    base = dict(symbol=SYM, side="buy", outcome="yes", quantity="1", price="0.58", reason="test")
    base.update(kw)
    return OrderRequest(**base)


def make(tmp_path, *, dry_run=True, approver=None, http=None, **policy):
    pol = TradingPolicy(symbol_allowlist={SYM}, **policy)
    kw = dict(dry_run=dry_run, env="sandbox", api_key="k", api_secret="s",
              http=http or FakeHttp(), clock=lambda: NOW, nonce=lambda: "1")
    if approver:
        kw["approver"] = approver
    return GuardedExchange(pol, AuditLog(tmp_path / "audit.jsonl"), **kw)


def test_signing_matches_gemini_spec():
    h = sign("/v1/prediction-markets/order", {"symbol": "X"}, "key", "secret", "123")
    raw = json.dumps({"request": "/v1/prediction-markets/order", "nonce": "123", "symbol": "X"}).encode()
    b64 = base64.b64encode(raw)
    assert h["X-GEMINI-PAYLOAD"] == b64.decode()
    assert h["X-GEMINI-SIGNATURE"] == hmac.new(b"secret", b64, hashlib.sha384).hexdigest()
    assert h["Content-Length"] == "0" and h["X-GEMINI-APIKEY"] == "key"


def test_defaults_are_sandbox_and_dry_run(tmp_path, monkeypatch):
    monkeypatch.delenv("VERITY_EXCHANGE_ENV", raising=False)
    ex = GuardedExchange(TradingPolicy(), AuditLog(tmp_path / "a.jsonl"))
    assert ex.env == "sandbox" and ex.dry_run is True and ex.base.endswith("sandbox.gemini.com")


def test_production_needs_explicit_second_switch(tmp_path, monkeypatch):
    monkeypatch.delenv("VERITY_ALLOW_PRODUCTION", raising=False)
    with pytest.raises(ExchangeRefused, match="VERITY_ALLOW_PRODUCTION"):
        GuardedExchange(TradingPolicy(), AuditLog(tmp_path / "a.jsonl"), env="production")


def test_dry_run_passes_checks_but_sends_nothing(tmp_path):
    http = FakeHttp()
    ex = make(tmp_path, http=http)
    out = ex.place_order(order(), analysis=FakeAnalysis())
    assert out["dry_run"] is True and http.calls == []
    assert ex.audit.entries()[-1]["decision"] == "dry_run"


def test_live_send_is_signed_and_logged(tmp_path):
    http = FakeHttp()
    ex = make(tmp_path, dry_run=False, http=http)
    assert ex.place_order(order(), analysis=FakeAnalysis())["orderId"] == 42
    method, url, headers = http.calls[0]
    assert url == "https://api.sandbox.gemini.com/v1/prediction-markets/order" and "X-GEMINI-SIGNATURE" in headers
    assert ex.audit.entries()[-1]["decision"] == "sent"


@pytest.mark.parametrize("o, kw, msg", [
    (dict(symbol="GEMI-OTHER"), {}, "allowlist"),
    (dict(price="0.70"), {}, "from the analysed quote"),
    (dict(quantity="20", price="0.58"), {}, "per-order cap"),
])
def test_refusals(tmp_path, o, kw, msg):
    ex = make(tmp_path, **kw)
    with pytest.raises(ExchangeRefused, match=msg):
        ex.place_order(order(**o), analysis=FakeAnalysis())
    assert ex.audit.entries()[-1]["decision"] == "refused"


def test_requires_matching_analysis(tmp_path):
    ex = make(tmp_path)
    with pytest.raises(ExchangeRefused, match="no RiskAnalysisV1"):
        ex.place_order(order())
    a = FakeAnalysis(); a.research_action = "flag_for_human_review"
    with pytest.raises(ExchangeRefused, match="human review"):
        ex.place_order(order(), analysis=a)


def test_near_expiry_refused(tmp_path):
    ex = make(tmp_path)
    a = FakeAnalysis(); a.expiry_utc = "2026-11-18T01:30:00Z"
    with pytest.raises(ExchangeRefused, match="expiry"):
        ex.place_order(order(), analysis=a)


def test_owner_approval_above_threshold(tmp_path):
    ex = make(tmp_path)  # default approver denies
    with pytest.raises(ExchangeRefused, match="owner approval"):
        ex.place_order(order(quantity="3"), analysis=FakeAnalysis())   # $1.74 > $1.00
    ok = make(tmp_path, approver=lambda a: ApprovalResult(True, "owner-wallet", "eip712:abc"))
    assert ok.place_order(order(quantity="3"), analysis=FakeAnalysis())["dry_run"] is True
    assert ok.audit.entries()[-1]["approval"]["evidence"] == "eip712:abc"


def test_daily_cap_counts_sent_orders(tmp_path):
    ex = make(tmp_path, dry_run=False, max_daily_usd=Decimal("1.00"))
    ex.place_order(order(), analysis=FakeAnalysis())                 # $0.58 sent
    with pytest.raises(ExchangeRefused, match="daily cap"):
        ex.place_order(order(), analysis=FakeAnalysis())             # another $0.58 -> $1.16


def test_unknown_outcome_blocks_until_reconciled(tmp_path):
    ex = make(tmp_path, dry_run=False, http=FakeHttp(fail=True))
    with pytest.raises(TimeoutError):
        ex.place_order(order(), analysis=FakeAnalysis())
    assert ex.audit.entries()[-1]["decision"] == "outcome_unknown"
    with pytest.raises(ExchangeRefused, match="unknown outcome"):
        ex.place_order(order(), analysis=FakeAnalysis())
    restarted = make(tmp_path, dry_run=False)            # same audit log, fresh process
    with pytest.raises(ExchangeRefused, match="unknown outcome"):
        restarted.place_order(order(), analysis=FakeAnalysis())
    ex.mark_reconciled(SYM, "checked open orders on the exchange")
    ex._http = FakeHttp()
    assert ex.place_order(order(), analysis=FakeAnalysis())["orderId"] == 42


def test_pause_switch(tmp_path, monkeypatch):
    monkeypatch.setenv("VERITY_TRADING_PAUSED", "1")
    with pytest.raises(ExchangeRefused, match="paused"):
        make(tmp_path).place_order(order(), analysis=FakeAnalysis())


def test_funds_paths_never_callable(tmp_path):
    ex = make(tmp_path, dry_run=False)
    with pytest.raises(ExchangeRefused, match="never allowed"):
        ex._call("POST", "/v1/withdraw/usd", {})


def test_order_validation():
    with pytest.raises(ValueError):
        order(price="1.00")
    with pytest.raises(ValueError):
        order(quantity="-1")
    with pytest.raises(ValueError):
        OrderRequest(symbol=SYM, side="buy", outcome="yes", quantity="1", price="0.5", reason="x", orderType="market")


def test_audit_log_never_contains_secrets(tmp_path):
    ex = make(tmp_path, dry_run=False)
    ex.place_order(order(), analysis=FakeAnalysis())
    text = (tmp_path / "audit.jsonl").read_text()
    assert '"s"' not in text and "X-GEMINI-SIGNATURE" not in text
