"""Offline tests for pm_us_logger. Run: python -m unittest test_pm_us_logger"""

import asyncio
import sqlite3
import unittest

import pm_us_logger as L

# Payloads copied from docs.polymarket.us/api-reference/websocket/markets.md
LITE = {
    "requestId": "mdl-sub-1",
    "subscriptionType": "SUBSCRIPTION_TYPE_MARKET_DATA_LITE",
    "marketDataLite": {
        "marketSlug": "market-slug-1",
        "currentPx": {"value": "0.55", "currency": "USD"},
        "lastTradePx": {"value": "0.55", "currency": "USD"},
        "bestBid": {"value": "0.54", "currency": "USD"},
        "bestAsk": {"value": "0.56", "currency": "USD"},
        "bidDepth": 5,
        "askDepth": 4,
        "sharesTraded": "150000",
        "openInterest": "500000",
    },
}
TRADE = {
    "requestId": "trade-sub-1",
    "subscriptionType": "SUBSCRIPTION_TYPE_TRADE",
    "trade": {
        "marketSlug": "market-slug-1",
        "price": {"value": "0.555", "currency": "USD"},
        "quantity": {"value": "0.50", "currency": "USD"},
        "tradeTime": "2024-01-15T10:30:00Z",
        "maker": {"side": "ORDER_SIDE_BUY", "intent": "ORDER_INTENT_BUY_LONG"},
        "taker": {"side": "ORDER_SIDE_SELL", "intent": "ORDER_INTENT_SELL_LONG"},
    },
}


class ParseTests(unittest.TestCase):
    def test_bbo(self):
        row = L.parse_bbo(LITE, 1)
        self.assertEqual(row, (1, "market-slug-1", 0.55, 0.55, 0.54, 0.56, 5, 4, 150000.0, 500000.0))

    def test_trade(self):
        row = L.parse_trade(TRADE, 1)
        self.assertEqual(row[1:5], ("market-slug-1", "2024-01-15T10:30:00Z", 0.555, 0.5))
        self.assertEqual(row[5:], ("ORDER_SIDE_BUY", "ORDER_INTENT_BUY_LONG",
                                   "ORDER_SIDE_SELL", "ORDER_INTENT_SELL_LONG"))

    def test_ignores_other_messages(self):
        for msg in ({"heartbeat": {}}, {"requestId": "x", "error": "bad"}, {"trade": {}}):
            self.assertIsNone(L.parse_bbo(msg, 1))
            self.assertIsNone(L.parse_trade(msg, 1))

    def test_num_tolerates_shapes(self):
        self.assertEqual(L._num("0.25"), 0.25)
        self.assertEqual(L._num(3), 3.0)
        self.assertEqual(L._num({"value": "1.5"}), 1.5)
        self.assertIsNone(L._num(None))
        self.assertIsNone(L._num("n/a"))
        self.assertIsNone(L._num({}))

    def test_chunked(self):
        self.assertEqual(list(L.chunked(list("abcde"), 2)), [["a", "b"], ["c", "d"], ["e"]])


class StoreTests(unittest.TestCase):
    def test_writes_and_dedupes(self):
        s = L.Store(":memory:", keep_raw=True)
        s.handle(LITE, 10)
        s.handle(TRADE, 11)
        s.handle(TRADE, 12)  # at-least-once redelivery
        s.handle({"heartbeat": {}}, 13)
        s.flush()
        q = lambda sql: s.conn.execute(sql).fetchone()[0]
        self.assertEqual(q("SELECT COUNT(*) FROM bbo"), 1)
        self.assertEqual(q("SELECT COUNT(*) FROM trades"), 1)
        self.assertEqual(q("SELECT COUNT(*) FROM raw_messages"), 4)
        self.assertEqual(s.counts, {"bbo": 1, "trades": 1, "dup_trades": 1})
        s.close()


class FakeWS:
    """Stands in for the SDK MarketsWebSocket."""

    def __init__(self, script):
        self.script, self.handlers, self.sent, self.closed = script, {}, [], False

    def on(self, ev, cb):
        self.handlers.setdefault(ev, []).append(cb)

    def emit(self, ev, *a):
        for cb in self.handlers.get(ev, []):
            cb(*a)

    async def connect(self):
        asyncio.get_running_loop().call_soon(self._play)

    def _play(self):
        for ev, payload in self.script:
            self.emit(ev, *([payload] if payload is not None else []))

    async def subscribe(self, rid, typ, slugs):
        self.sent.append((rid, typ, len(slugs)))

    async def close(self):
        self.closed = True


class FakeClient:
    def __init__(self, ws):
        self.ws = type("F", (), {"markets": lambda _self: ws})()


class SessionTests(unittest.TestCase):
    def test_session_logs_until_close_and_chunks_subscriptions(self):
        ws = FakeWS([("message", LITE), ("message", TRADE), ("close", None)])
        store = L.Store(":memory:")
        markets = [f"m{i}" for i in range(150)]
        asyncio.run(L.run_session(FakeClient(ws), markets, store, 30, asyncio.Event()))
        self.assertTrue(ws.closed)
        self.assertEqual(ws.sent, [
            ("lite-0", "SUBSCRIPTION_TYPE_MARKET_DATA_LITE", 100),
            ("trade-0", "SUBSCRIPTION_TYPE_TRADE", 100),
            ("lite-1", "SUBSCRIPTION_TYPE_MARKET_DATA_LITE", 50),
            ("trade-1", "SUBSCRIPTION_TYPE_TRADE", 50),
        ])
        self.assertEqual(store.counts["bbo"], 1)
        self.assertEqual(store.counts["trades"], 1)

    def test_subscription_error_does_not_end_session(self):
        from polymarket_us import WebSocketError

        ws = FakeWS([("error", WebSocketError("unknown market", "lite-0"))])
        stop = asyncio.Event()

        async def go():
            asyncio.get_running_loop().call_later(1.5, stop.set)
            await L.run_session(FakeClient(ws), ["x"], L.Store(":memory:"), 30, stop)

        asyncio.run(go())  # returns only because stop fired, not because of the error
        self.assertTrue(stop.is_set())

    def test_stale_connection_ends_session(self):
        ws = FakeWS([])  # never sends anything
        stop = asyncio.Event()
        asyncio.run(L.run_session(FakeClient(ws), ["x"], L.Store(":memory:"), 0.5, stop))
        self.assertFalse(stop.is_set())
        self.assertTrue(ws.closed)


class CliTests(unittest.TestCase):
    def test_missing_credentials_exits_2(self):
        import os
        from unittest import mock

        with mock.patch.dict(os.environ, {}, clear=True):
            self.assertEqual(L.main(["--markets", "x", "--db", ":memory:"]), 2)


if __name__ == "__main__":
    unittest.main()
