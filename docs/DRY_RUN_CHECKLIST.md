# Dry-run checklist (Polymarket US)

Work through this before turning off dry run. Each step says what to look at and what a failure looks like.

## What is already verified, and what is not

The public gateway was exercised live on 2026-11-08 (`npm run smoke` in `mcp-server/`). Captured responses live in `src/services/api/__tests__/fixtures/pmus-live.json` and drive the `pmusWire` tests.

| Area | Status |
|:-----|:-------|
| Events, markets, BBO, book, settlement, price history (gateway) | Verified live |
| Up/Down slug format, window, price to beat | Verified live |
| Rate limit | Documented at 25 requests/s per IP. On the gateway, bursts also drew a Cloudflare 1015 ban for several minutes. The throttle runs at 5/s (gateway) + 15/s (API); 8/s still drew occasional 429s on 2026-11-10. The smoke test prints how many 429s it hit. If the console shows `HTTP 429 rate limit … pausing requests`, lower `GATEWAY_BUCKET` in `src/services/api/requestThrottle.ts`. |
| Authenticated REST: balances, positions, orders | **Checked against the API reference** (2026-11-08), not live. Positions are a map keyed by slug with decimal quantity fields and a `nextCursor`; balances are a per-currency list. The code now reads those fields. |
| `cashValue` on positions | **Ambiguous.** The reference calls it "Unrealized PnL"; the app treats it as current market value. Compare against the Polymarket US app in step 1. |
| Order prices for NO | **Documented:** prices always refer to YES; buying NO at $0.40 is selling YES at $0.60. The code converts. |
| Fill price side (`lastPx`) for NO orders | **Not documented.** The code accepts either reading. Step 3 confirms it. |
| Order quantity | **Documented:** whole contracts unless the market's `minimumTradeQty` is below 1. Orders are now rounded down to that step. |
| Fees | **Documented:** taker fee Θ × contracts × p × (1 − p), Θ = 0.095 at tier 1. Sizing and take-profit now use it. |
| WebSockets | **Documented:** both feeds need the API key; message shapes match the code; at most 100 markets per subscription (now chunked). Not verified live. |
| Latency reject | **Documented:** "Order Processing Max Delay Exceeded" is transient. The bot resubmits once. |
| Private feed balance | **Assumed** to be in the same dollar units as the REST balance; neither the SDK types nor the docs say. Step 2 confirms it. |
| Full order book stream, trade stream | **Documented** message shapes (each book update carries the whole top of the book; trades carry the taker's side and intent). Not verified live. The lite feed's `bidDepth`/`askDepth` are in the docs but not the SDK types. |
| WebSockets from the browser | The SDK refuses to open a WebSocket in a browser, so the feeds never connected before 2026-11-10. They now go through the dev server's bridge. Verified: the bridge reaches the exchange and a bad signature is refused with HTTP 401. **Not verified:** a real key being accepted. |
| Heartbeats | **Unknown interval.** The stall watchdog only arms after it has seen two heartbeats; if the server sends none it never fires. |
| Up/Down settlement | The settlement endpoint was verified live for expired markets. **Assumed:** it returns 1 when the market's first outcome won, and that the first outcome is "Up" when the recorder says so. Step 2 confirms it. |

Rows not marked verified live are the point of this checklist.

A scheduled GitHub workflow (`.github/workflows/api-smoke.yml`) runs the public smoke test once a day and can be started by hand from the Actions tab. A red run means the public API changed shape or rate-limited the runner; it says nothing about the account endpoints.

## 0. Prerequisites

- An API key from polymarket.us/developer.
- For the MCP checks, put `POLYMARKET_KEY_ID` and `POLYMARKET_SECRET_KEY` in the repo-root `.env`. The app takes the same key in Settings → Wallet.
- Behind an HTTPS proxy, run Node with `NODE_USE_ENV_PROXY=1`.
- Keep request volume low. A burst against the gateway can get your IP banned for several minutes.

## 1. MCP smoke test (5 minutes)

Shortcut for steps 0–2: `npm run preflight` from the repo root installs both packages, runs the smoke test (with the account checks if your key is in `.env`) and starts the app. Add `-- --no-dev` to skip starting the app. The manual steps are below.

```bash
cd mcp-server
npm install
npm run smoke              # public checks
npm run smoke -- --auth    # adds balance, positions, open orders, order preview
```

- [ ] All public checks pass, and the last line reads `No rate limiting`. A `WARNING: rate-limited N time(s)` line with passing checks means the throttle recovered but the gateway rate is still too high for your connection.
  A `get_markets` failure that mentions HTML or 429 means you are rate-limited. Wait 5–10 minutes.
- [ ] `get_balance` shows your real balance. An empty object or zeros on a funded account means the balance response shape differs from the SDK typings.
- [ ] `get_positions` lists what the Polymarket US app shows. Note whether `cash_value_usd` equals the position's market value or its unrealized P&L, and report which.
- [ ] The `place_order` dry run returns a preview without an error. It is a BUY YES of 1 share at 1¢ and is never sent.

## 2. App in dry run (30–60 minutes)

```bash
npm run dev    # http://localhost:4000
```

Settings → Trading: confirm **Dry run is on**. Connect your key in Settings → Wallet.

- [ ] **Balance.** The header balance matches the Polymarket US app within a minute of connecting.
- [ ] **Markets feed.** In the browser console, `[RealtimeService] First market data received — pipeline active` appears. If it never appears, the WebSocket message shape differs from what `RealtimeService` reads.
- [ ] **BTC Up/Down discovery.** With BTC + 15m enabled, the Activity log shows `Found 15m: BTC Up or Down 15m …` and a price to beat that matches the market page. `0 15m slug results` every cycle means the slug format changed.
- [ ] **Up/Down prices.** The dashboard Up and Down prices add up to about $1 and track the market page.
- [ ] **Micro Momentum.** The refresh log shows a nonzero `eligible after filters` count within a few refreshes. Coverage grows as stats are cached. A `Gateway rate limit hit` warning means lookups paused for 5 minutes.
- [ ] **Signals in both directions.** Over time you see Micro Momentum SIGNAL lines for both YES and NO.
- [ ] **Live balance.** Settings → API shows the private feed `connected` with `balance live`, and the header balance still matches the Polymarket US app. A balance off by a factor (100×, for example) means the feed uses different units from REST: report it and do not trade.
- [ ] **Feed status.** Settings → API shows both feeds `connected` with a last message under a minute old. `stall restarts` should stay at 0 on a healthy connection; a count that climbs every minute or so means the heartbeat assumption is wrong.
- [ ] **Order books in memory.** With BTC Up/Down or Micro Momentum running, the market-data row shows `books N/M fresh` with N close to M on active markets. `0/M` while prices update means the full-book messages are not arriving or have a different shape.
- [ ] **Request rates.** The same panel stays at or under 5/s (gateway) and 15/s (API), with 0 in the 429 and Dropped columns. Balance and open-order calls should be rare while the private feed is connected.
- [ ] **Feed loss.** Turn the network off for a few minutes. The dashboard shows MARKET DATA FEED OFFLINE or PRIVATE FEED OFFLINE once reconnecting stops; **Retry** brings the feed back after the network returns. With "Pause Entries When Price Feed Is Down" on (and dry run off, in step 3), no new entries are placed while the market-data feed is down.
- [ ] **Micro signals.** Dashboard → Analytics → Microstructure signals lists tracked markets with signals of both signs, `full book` in the last column, and trade-flow values on markets that are trading. All signals negative, or `level counts` everywhere, means depth is not reaching the signal.
- [ ] **Recording only (optional).** With Settings → Trading → Record Signals Only on, the dashboard shows RECORDING SIGNALS ONLY, no Momentum or Up/Down trades appear (simulated or real), and the Analytics reports keep growing.
- [ ] **Signal reports fill in.** After 30–60 minutes the "If entered at each threshold" table has trades, and "Crypto Up/Down signals" has resolved windows. Treat both as evidence only after days of data, not from this session.
- [ ] **Up/Down results.** In the Crypto Up/Down panel, windows move from "provisional from the bot's spot price" to "settled by the exchange" within about 20 minutes of ending. Check two or three finished windows against the market page: the winner must match. A mismatch on a clear (not near-tie) window means the settlement mapping is wrong.
- [ ] **No console errors** other than expected network retries.

## 3. One tiny live order per path

Turn dry run off, set Penny Mode on, and keep the risk limits at their minimum. Watch each order on the Polymarket US app as it happens.

- [ ] **BUY YES (FOK).** It fills. The tracked position's entry price matches the fill price shown on Polymarket US.
- [ ] **BUY NO.** It fills **on the NO side**, and the entry price is the NO price, around 1 − YES. If the app shows the YES price, the fill-price conversion is wrong. If the exchange shows a YES position, the intent mapping is wrong. Stop and report either case.
- [ ] **Maker-first (optional).** With Maker-First Entries on, a buy appears on the book as a resting limit order one cent above the best bid, marked post-only. A post-only rejection should log `Maker entry not placed` and then fill as a normal order.
- [ ] **Maker expiry.** Let a maker entry expire, for example with a 1-minute GTD expiry on a quiet market. If the ask is still within the chase limit, the log shows `Maker entry expired — taking N at …` and a normal order fills. Otherwise it shows `no taker fallback: …`. A partially filled maker order should leave a tracked position for the filled shares.
- [ ] **Maker fill stats.** Under the toggle, the stats panel counts the order as placed, then as filled, expired or cancelled. A rejection adds to the rejected count. After a day, compare the fill rate with the taker fees avoided.
- [ ] **GTD fallback.** Make an FOK miss on a thin market and confirm the fallback GTD order rests on the book with the expected expiry. A rejection that mentions `goodTillTime` means the format is wrong.
- [ ] **Fill detection.** The fill shows up in the Activity log within a few seconds. Detection should come from the private WebSocket, not the 60-second order poll.
- [ ] **Exit.** A stop-loss or take-profit, or a manual close from the Portfolio view, sells the right side and the position disappears.
- [ ] **Reload.** Reload the page with a position open. It is still tracked afterwards with the same SL/TP.

## 4. Report back

For any failed box, capture the console output and the network response for the failing call, with keys redacted. That is enough to fix the shape mismatch.
