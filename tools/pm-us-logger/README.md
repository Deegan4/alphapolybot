# pm-us-logger

Read-only logger for **Polymarket US** market data. Streams best bid/offer and
trade prints from `wss://api.polymarket.us/v1/ws/markets` into SQLite so you
have real data to backtest against. It never places or cancels orders.

Standalone Python tool: it does not touch the AlphaPolyBot web app, which
targets the international Polymarket CLOB.

## Setup

```bash
cd tools/pm-us-logger
python3 -m venv .venv && source .venv/bin/activate   # Python 3.10+
pip install -r requirements.txt

export POLYMARKET_KEY_ID=...        # from polymarket.us/developer
export POLYMARKET_SECRET_KEY=...    # base64 Ed25519 secret, shown once
```

The markets WebSocket **requires an API key** even though REST market data is
public.

## Run

```bash
python pm_us_logger.py --markets chiefs-super-bowl another-slug
python pm_us_logger.py --top 25                  # auto-pick 25 active markets
python pm_us_logger.py --top 25 --raw -v         # also keep raw JSON
```

Stop with Ctrl-C; pending rows are flushed on exit.

| Flag | Default | Meaning |
|---|---|---|
| `--markets SLUG…` | – | Market slugs to log |
| `--top N` | 0 | Add N active markets from `GET /v1/markets` |
| `--db PATH` | `pm_us_marketdata.sqlite3` | Output database |
| `--raw` | off | Store every raw message in `raw_messages` |
| `--stale-seconds S` | 60 | Reconnect if nothing (incl. heartbeats) arrives for S seconds |

## What it does

- Subscribes to `SUBSCRIPTION_TYPE_MARKET_DATA_LITE` and
  `SUBSCRIPTION_TYPE_TRADE`, chunked at 100 markets per subscription (the
  documented limit).
- Reconnects with jittered exponential backoff (1s → 60s cap, reset after a
  healthy minute). The SDK itself has no reconnect logic.
- Treats a silent socket as dead after `--stale-seconds`.
- Delivery is at-least-once and trade messages have no ID, so trades are
  de-duplicated on `(market, tradeTime, price, quantity, maker/taker intent)`.
- A subscription error (e.g. a bad slug) is logged and does not drop the
  connection.

## Schema

- `bbo`: `recv_ts_ms, market_slug, current_px, last_trade_px, best_bid,
  best_ask, bid_depth, ask_depth, shares_traded, open_interest`
- `trades`: `recv_ts_ms, market_slug, trade_time, price, quantity,
  maker_side, maker_intent, taker_side, taker_intent`
- `raw_messages`: `recv_ts_ms, payload` (only with `--raw`)

```sql
-- mid-price and spread over time for one market
SELECT recv_ts_ms, (best_bid + best_ask) / 2 AS mid, best_ask - best_bid AS spread
FROM bbo WHERE market_slug = 'chiefs-super-bowl' ORDER BY recv_ts_ms;
```

## Tests

```bash
python -m unittest -v test_pm_us_logger
```

Offline tests use the payload examples from the official docs and a fake
socket; no network or keys needed.

## Caveats

- Field parsing follows the documented payloads, which haven't been verified
  against live traffic yet. Run once with `--raw` and compare
  `raw_messages` to the `bbo`/`trades` rows.
- Limits per the docs: 20 concurrent streams and ~100 client messages/s per
  firm.
