#!/usr/bin/env python3
"""Polymarket US market-data logger.

Streams best bid/offer (SUBSCRIPTION_TYPE_MARKET_DATA_LITE) and trade prints
(SUBSCRIPTION_TYPE_TRADE) from wss://api.polymarket.us/v1/ws/markets into a
local SQLite database for later backtesting.

Read-only: this script never places, modifies or cancels orders.

The markets WebSocket requires API-key authentication even though the REST
market-data endpoints are public. Credentials come from the environment:

    POLYMARKET_KEY_ID      API key ID from polymarket.us/developer
    POLYMARKET_SECRET_KEY  Base64 Ed25519 secret key (shown once at creation)

Usage:
    python pm_us_logger.py --markets slug-a slug-b
    python pm_us_logger.py --top 25            # auto-pick active markets
"""

from __future__ import annotations

import argparse
import asyncio
import contextlib
import json
import logging
import os
import random
import signal
import sqlite3
import sys
import time
from collections.abc import Iterable, Iterator
from typing import Any

log = logging.getLogger("pm_us_logger")

# Docs: "maximum of 100 markets per subscription".
MAX_MARKETS_PER_SUB = 100

SCHEMA = """
CREATE TABLE IF NOT EXISTS bbo (
    id             INTEGER PRIMARY KEY,
    recv_ts_ms     INTEGER NOT NULL,
    market_slug    TEXT    NOT NULL,
    current_px     REAL,
    last_trade_px  REAL,
    best_bid       REAL,
    best_ask       REAL,
    bid_depth      INTEGER,
    ask_depth      INTEGER,
    shares_traded  REAL,
    open_interest  REAL
);
CREATE INDEX IF NOT EXISTS bbo_slug_ts ON bbo (market_slug, recv_ts_ms);

CREATE TABLE IF NOT EXISTS trades (
    id            INTEGER PRIMARY KEY,
    recv_ts_ms    INTEGER NOT NULL,
    market_slug   TEXT    NOT NULL,
    trade_time    TEXT,
    price         REAL,
    quantity      REAL,
    maker_side    TEXT,
    maker_intent  TEXT,
    taker_side    TEXT,
    taker_intent  TEXT,
    -- Delivery is at-least-once and trade messages carry no trade ID, so
    -- duplicates are dropped on this natural key.
    UNIQUE (market_slug, trade_time, price, quantity, maker_intent, taker_intent)
);
CREATE INDEX IF NOT EXISTS trades_slug_ts ON trades (market_slug, trade_time);

CREATE TABLE IF NOT EXISTS raw_messages (
    id          INTEGER PRIMARY KEY,
    recv_ts_ms  INTEGER NOT NULL,
    payload     TEXT    NOT NULL
);
"""


# --------------------------------------------------------------------------
# Parsing (pure functions; unit-tested)
# --------------------------------------------------------------------------

def _num(v: Any) -> float | None:
    """Coerce a docs-style value to float.

    Prices arrive as {"value": "0.55", "currency": "USD"}; quantities arrive
    as strings or numbers depending on the field. Anything unparseable -> None.
    """
    if isinstance(v, dict):
        v = v.get("value")
    if v is None or v == "":
        return None
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def _int(v: Any) -> int | None:
    f = _num(v)
    return int(f) if f is not None else None


def parse_bbo(msg: dict[str, Any], recv_ts_ms: int) -> tuple | None:
    d = msg.get("marketDataLite")
    if not isinstance(d, dict) or not d.get("marketSlug"):
        return None
    return (
        recv_ts_ms,
        d["marketSlug"],
        _num(d.get("currentPx")),
        _num(d.get("lastTradePx")),
        _num(d.get("bestBid")),
        _num(d.get("bestAsk")),
        _int(d.get("bidDepth")),
        _int(d.get("askDepth")),
        _num(d.get("sharesTraded")),
        _num(d.get("openInterest")),
    )


def parse_trade(msg: dict[str, Any], recv_ts_ms: int) -> tuple | None:
    t = msg.get("trade")
    if not isinstance(t, dict) or not t.get("marketSlug"):
        return None
    maker = t.get("maker") or {}
    taker = t.get("taker") or {}
    return (
        recv_ts_ms,
        t["marketSlug"],
        t.get("tradeTime"),
        _num(t.get("price")),
        _num(t.get("quantity")),
        maker.get("side"),
        maker.get("intent"),
        taker.get("side"),
        taker.get("intent"),
    )


def chunked(items: list[str], size: int) -> Iterator[list[str]]:
    for i in range(0, len(items), size):
        yield items[i : i + size]


# --------------------------------------------------------------------------
# Storage
# --------------------------------------------------------------------------

class Store:
    """SQLite sink. Commits in batches to keep write overhead low."""

    def __init__(self, path: str, keep_raw: bool = False, commit_every: int = 200) -> None:
        self.conn = sqlite3.connect(path)
        self.conn.execute("PRAGMA journal_mode=WAL")
        self.conn.executescript(SCHEMA)
        self.keep_raw = keep_raw
        self.commit_every = commit_every
        self._pending = 0
        self.counts = {"bbo": 0, "trades": 0, "dup_trades": 0}

    def handle(self, msg: dict[str, Any], recv_ts_ms: int | None = None) -> None:
        ts = recv_ts_ms if recv_ts_ms is not None else int(time.time() * 1000)
        if self.keep_raw:
            self.conn.execute(
                "INSERT INTO raw_messages (recv_ts_ms, payload) VALUES (?, ?)",
                (ts, json.dumps(msg, separators=(",", ":"))),
            )
            self._pending += 1

        if (row := parse_bbo(msg, ts)) is not None:
            self.conn.execute(
                "INSERT INTO bbo (recv_ts_ms, market_slug, current_px, last_trade_px,"
                " best_bid, best_ask, bid_depth, ask_depth, shares_traded, open_interest)"
                " VALUES (?,?,?,?,?,?,?,?,?,?)",
                row,
            )
            self.counts["bbo"] += 1
            self._pending += 1
        elif (row := parse_trade(msg, ts)) is not None:
            cur = self.conn.execute(
                "INSERT OR IGNORE INTO trades (recv_ts_ms, market_slug, trade_time, price,"
                " quantity, maker_side, maker_intent, taker_side, taker_intent)"
                " VALUES (?,?,?,?,?,?,?,?,?)",
                row,
            )
            if cur.rowcount:
                self.counts["trades"] += 1
                self._pending += 1
            else:
                self.counts["dup_trades"] += 1

        if self._pending >= self.commit_every:
            self.flush()

    def flush(self) -> None:
        if self._pending:
            self.conn.commit()
            self._pending = 0

    def close(self) -> None:
        self.flush()
        self.conn.close()


# --------------------------------------------------------------------------
# Streaming with reconnect + stale-connection watchdog
# --------------------------------------------------------------------------

async def run_session(
    client: Any,
    markets: list[str],
    store: Store,
    stale_seconds: float,
    stop: asyncio.Event,
) -> None:
    """One connection lifetime. Returns when the socket closes, goes stale,
    or `stop` is set. Raises on connect failure."""
    from polymarket_us import WebSocketError

    ws = client.ws.markets()
    ended = asyncio.Event()
    last_msg = time.monotonic()

    def on_message(msg: dict[str, Any]) -> None:
        nonlocal last_msg
        last_msg = time.monotonic()  # heartbeats count as liveness too
        store.handle(msg)

    def on_error(err: Exception) -> None:
        if isinstance(err, WebSocketError):
            # Server-side subscription error (e.g. unknown slug). Keep running.
            log.error("subscription error (request %s): %s", err.request_id, err)
        else:
            log.warning("socket error: %s", err)
            ended.set()

    ws.on("message", on_message)
    ws.on("error", on_error)
    ws.on("close", ended.set)

    await ws.connect()
    log.info("connected; subscribing to %d markets", len(markets))
    try:
        for i, chunk in enumerate(chunked(markets, MAX_MARKETS_PER_SUB)):
            await ws.subscribe(f"lite-{i}", "SUBSCRIPTION_TYPE_MARKET_DATA_LITE", chunk)
            await ws.subscribe(f"trade-{i}", "SUBSCRIPTION_TYPE_TRADE", chunk)

        while not (ended.is_set() or stop.is_set()):
            await asyncio.sleep(1)
            store.flush()
            if time.monotonic() - last_msg > stale_seconds:
                log.warning("no messages for %.0fs; treating connection as stale", stale_seconds)
                break
    finally:
        with contextlib.suppress(Exception):
            await ws.close()
        store.flush()


async def run(args: argparse.Namespace) -> int:
    from polymarket_us import AsyncPolymarketUS

    key_id = os.environ.get("POLYMARKET_KEY_ID")
    secret = os.environ.get("POLYMARKET_SECRET_KEY")
    if not key_id or not secret:
        log.error("POLYMARKET_KEY_ID and POLYMARKET_SECRET_KEY must be set "
                  "(the markets WebSocket requires API-key auth)")
        return 2

    stop = asyncio.Event()
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        with contextlib.suppress(NotImplementedError):  # Windows
            loop.add_signal_handler(sig, stop.set)

    store = Store(args.db, keep_raw=args.raw)
    async with AsyncPolymarketUS(key_id=key_id, secret_key=secret) as client:
        markets = list(dict.fromkeys(args.markets or []))  # de-dupe, keep order
        if args.top:
            resp = await client.markets.list({"active": True, "closed": False, "limit": args.top})
            markets += [m["slug"] for m in resp.get("markets", []) if m.get("slug") not in markets]
        if not markets:
            log.error("no markets selected; pass --markets and/or --top")
            return 2
        log.info("logging %d markets to %s", len(markets), args.db)

        backoff = 1.0
        while not stop.is_set():
            started = time.monotonic()
            try:
                await run_session(client, markets, store, args.stale_seconds, stop)
            except Exception as e:  # connect/auth/network failure
                log.warning("session failed: %s", e)
            if stop.is_set():
                break
            if time.monotonic() - started > 60:
                backoff = 1.0  # healthy session; reset
            delay = min(backoff, 60.0) * (0.5 + random.random())  # jitter
            log.info("reconnecting in %.1fs (totals: %s)", delay, store.counts)
            with contextlib.suppress(asyncio.TimeoutError):
                await asyncio.wait_for(stop.wait(), timeout=delay)
            backoff *= 2

    log.info("stopped. totals: %s", store.counts)
    store.close()
    return 0


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    p.add_argument("--markets", nargs="*", default=[], metavar="SLUG",
                   help="market slugs to log")
    p.add_argument("--top", type=int, default=0, metavar="N",
                   help="also log N active markets from GET /v1/markets")
    p.add_argument("--db", default="pm_us_marketdata.sqlite3",
                   help="SQLite output path (default: %(default)s)")
    p.add_argument("--raw", action="store_true",
                   help="also store every raw JSON message (for debugging schemas)")
    p.add_argument("--stale-seconds", type=float, default=60.0,
                   help="reconnect if nothing (incl. heartbeats) arrives for this long")
    p.add_argument("-v", "--verbose", action="store_true")
    return p


def main(argv: Iterable[str] | None = None) -> int:
    args = build_parser().parse_args(list(argv) if argv is not None else None)
    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s %(levelname)s %(message)s",
    )
    return asyncio.run(run(args))


if __name__ == "__main__":
    sys.exit(main())
