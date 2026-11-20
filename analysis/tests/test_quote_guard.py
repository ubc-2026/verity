"""The analysis never infers a midpoint from a missing, one-sided or crossed book."""
from __future__ import annotations

import copy

from verity.analysis import get_risk_analysis
from verity.fixtures import FixtureContext

NYC = "fx-nyc-high-20261118"


def _quoted(bid, ask):
    ctx = FixtureContext.default()
    market = copy.deepcopy(ctx.markets[NYC])
    market["market"].update(best_bid=bid, best_ask=ask)
    ctx.markets = {NYC: market}
    return get_risk_analysis(NYC, ctx).quoted_price


def test_two_sided_book_has_a_mid():
    q = _quoted("0.54", "0.58")
    assert q.mid == "0.56"
    assert q.implied_probability == "0.56"


def test_crossed_book_has_no_mid():
    q = _quoted("0.60", "0.55")
    assert q.mid is None
    assert q.implied_probability is None


def test_one_sided_and_missing_books_have_no_mid():
    for bid, ask in [(None, "0.03"), ("0.40", None), (None, None)]:
        q = _quoted(bid, ask)
        assert q.mid is None
        assert q.implied_probability is None
