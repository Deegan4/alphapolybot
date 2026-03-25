# FiveMinMACDStrategy Design Spec

**Date**: 2026-03-16
**Status**: Reviewed (v2 — 6 issues fixed)
**Author**: Claude + deegan4

## Summary

Standalone trading strategy for Polymarket 5-minute BTC Up/Down markets using MACD(6,20,5) with histogram > 50 selectivity filter. Late-snipe entry at T-10s before window close, FOK taker orders, $2.50 default sizing. Expected ~7 trades/day based on Moon Dev backtest data showing 63.7% win rate with +1.46% walk-forward improvement.

## Motivation

Moon Dev's "Easy Hyper Gambler v1.0" backtest compared three MACD configurations on BTC 5-min markets. MACD(6/20/5) with `histogram > 50` filter was the clear winner:

| Metric | MACD(6/20/5) hist>50 |
|---|---|
| Win Rate | 63.70% |
| Edge | +9.70% |
| Trades/Day | ~7 |
| Walk-Forward Decay | **+1.46%** (improves OOS) |
| Max Losing Streak | 8 |
| Max Drawdown ($10/bet) | $103 |
| Profitable at $0.58 | Yes |

The positive walk-forward decay is the key differentiator — the other two configs (MACD 3/15/3 and 4/16/3) showed negative decay (-0.87% to -1.11%), indicating overfit.

## Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Architecture | Standalone strategy (not BtcUpDown sub-mode) | Different signal philosophy, different order type (FOK vs GTC), clean separation |
| Candle source | Binance REST bootstrap + BinanceWS tick aggregation | Accurate MACD warmup without modifying shared BinanceWSService |
| Entry timing | Late snipe at T-10s | Matches Moon Dev's proven approach; high-histogram filter means only strong signals |
| Fee handling | Cache on market discovery, refresh every 5 min | Zero latency on trade, accurate enough for EV gate |
| MACD module | Inline in strategy file (~30 lines) | YAGNI — extract if reused later |

## Architecture

### Data Flow

```
Binance REST via Vite proxy (startup)
  → GET /api/binance/v3/klines?symbol=BTCUSDT&interval=1m&limit=30
  → 30x 1-min candle closes
  → MACD warmup (EMA-6, EMA-20, Signal EMA-5)

BinanceWSService (continuous, ~1s ticks)
  → Candle Aggregator (builds 1-min OHLCV bars)
  → On each 1-min candle close: update MACD values
  → On disconnect: clear candle buffer, re-bootstrap on reconnect

Window Timer
  → Tracks 5-min Polymarket windows (aligned to clock: :00, :05, :10...)
  → At T-10s before close: evaluate MACD (skip if candle count < 20)

Trade Decision
  → |histogram| > 50? → Direction: hist > 0 = UP (buy YES), hist < 0 = DOWN (buy NO)
  → EV gate: winProb * (1 - feePct) > askPrice (fee applies to payout, not entry)
  → RiskManager gate: daily loss, balance floor, trade count

Execution
  → TradingService.placeBet(market, outcome, $2.50, { orderType: 'FOK', strategy: 'five-min-macd' })
```

**Note on Binance REST proxy**: A new Vite proxy entry `/api/binance` → `https://api.binance.com` is needed for CORS. This is a one-line addition to `vite.config.ts`.

### File Structure

**New files:**
- `src/services/strategies/FiveMinMACDStrategy.ts` — Strategy class + MACD calculator + candle aggregator
- `src/services/strategies/__tests__/FiveMinMACDStrategy.test.ts` — Unit + integration tests

**Modified files:**
- `src/services/strategies/StrategyManager.ts` — Add `'five-min-macd'` to `strategyLoaders`, add `getFiveMinMacdStrategy()` convenience getter, add `'five-min-macd'` tag to GTC cancellation union type
- `src/services/strategies/index.ts` — Add barrel export
- `src/stores/settingsStore.ts` — Add 5 new settings fields (bump to v63), add migration entry v62→v63 with defaults
- `src/views/SettingsView.tsx` — Add strategy config section (optional, can defer)
- `vite.config.ts` — Add `/api/binance` proxy entry → `https://api.binance.com`

## Components

### 1. MACD Calculator

Inline pure functions, no class needed.

```typescript
function computeEMA(prices: number[], period: number): number[]
// Standard EMA: multiplier = 2 / (period + 1), seed with SMA of first `period` values

function computeMACD(closes: number[]): { macdLine: number; signalLine: number; histogram: number }
// EMA(6) - EMA(20) = MACD line
// EMA(5) of MACD line = Signal line
// MACD line - Signal line = Histogram
// Requires >= 20 candle closes for valid output
```

Input: array of 1-min candle close prices (minimum 30 for warmup margin).
Output: current histogram value (the only value the strategy needs for decisions).

### 2. Candle Aggregator

Maintains a rolling buffer of 1-min OHLCV candles built from BinanceWS ticks.

```typescript
interface OneMinCandle {
  openTime: number    // minute-aligned timestamp (ms)
  open: number
  high: number
  low: number
  close: number
  volume: number      // aggregated from ticks (optional, not used by MACD)
  closed: boolean     // true once minute boundary passed
}
```

- **Bootstrap**: On `start()`, fetch 30 candles via Vite proxy `GET /api/binance/v3/klines?symbol=BTCUSDT&interval=1m&limit=30`
- **Maintenance**: Each BinanceWS tick updates the current (open) candle. On minute boundary, close the candle and push a new one.
- **Buffer size**: 35 candles max (30 for MACD warmup + 5 margin). Oldest are evicted.
- **Minute boundary detection**: `Math.floor(tick.timestamp / 60_000) !== Math.floor(currentCandle.openTime / 60_000)`. Boundary tick belongs to the new candle (convention: first tick of new minute opens new candle).
- **Disconnect handling**: On BinanceWS disconnect, clear candle buffer and set `warmedUp = false`. On reconnect, re-bootstrap from REST. Skip snipe evaluation if `!warmedUp || closedCandles.length < 20`.

### 3. Window Timer

Tracks Polymarket's 5-minute window schedule and fires the snipe evaluation.

```typescript
interface WindowState {
  windowStart: number    // ms timestamp of current window open
  windowEnd: number      // ms timestamp of current window close
  snipeTimeout: ReturnType<typeof setTimeout> | null
  traded: boolean        // prevent double-trade per window
}
```

- **Window alignment**: Polymarket 5-min windows align to UTC clock: `Math.floor(now / 300_000) * 300_000`
- **Schedule snipe**: `setTimeout(evaluateAndTrade, windowEnd - snipeLeadMs - now)`
- **After each window**: Schedule next window's snipe immediately
- **Guard**: `traded` flag prevents re-entry if timer fires twice (defensive)
- **Cleanup in `stop()`**: `clearTimeout(windowState.snipeTimeout)`, clear all intervals, unsubscribe BinanceWS callbacks, reset `windowState` and `dailyTradeCount`

### 4. Market Discovery

Finds the active 5-min BTC Up/Down market on Polymarket.

```typescript
interface CachedMarket {
  conditionId: string
  yesTokenId: string
  noTokenId: string
  feeRateBps: number     // cached from /fee-rate API
  tickSize: number       // cached from /tick-size API
  negRisk: boolean       // cached from /neg-risk API
  fetchedAt: number      // for staleness check
}
```

- **Discovery**: Query Gamma API for active 5-min BTC market (filter by slug pattern or tag)
- **Refresh**: Every 5 minutes (new market each window, but token IDs may persist across windows)
- **Fee cache**: Fetch `/fee-rate?token_id=X` on discovery, cache until next refresh
- **Fallback**: If no active market found, log warning and skip window

### 5. Trade Execution

```typescript
private async evaluateAndTrade(): Promise<void> {
  // 1. Check enabled + not already traded this window + MACD warmed up
  if (!this._enabled || this.windowState.traded || !this.warmedUp) return

  // 2. Check daily trade cap
  if (this.dailyTradeCount >= this.config.maxDailyTrades) {
    this.log(`Daily cap reached (${this.dailyTradeCount}/${this.config.maxDailyTrades})`)
    return
  }

  // 3. Compute MACD from current candle buffer
  const closes = this.candles.filter(c => c.closed).map(c => c.close)
  if (closes.length < 20) { this.log('Insufficient candles for MACD'); return }
  const macd = computeMACD(closes)
  if (!macd) return // null if < 20 closes
  const { histogram } = macd

  // 4. Histogram filter
  if (Math.abs(histogram) < this.config.histogramThreshold) {
    this.log(`Skipping: |histogram| ${Math.abs(histogram).toFixed(1)} < ${this.config.histogramThreshold}`)
    return
  }

  // 5. Outcome direction
  const outcome: 'yes' | 'no' = histogram > 0 ? 'yes' : 'no'  // UP = yes, DOWN = no

  // 6. Get cached market
  const market = this.cachedMarket
  if (!market) { this.log('No active 5-min market'); return }

  // 7. Get ask price via RealtimeService (established pattern)
  const tokenId = outcome === 'yes' ? market.yesTokenId : market.noTokenId
  const priceData = this.realtimeServiceRef?.getPrice(tokenId)
  if (!priceData?.ask) { this.log('No ask price available'); return }
  const askPrice = priceData.ask

  // 8. EV gate — Polymarket taker fees apply to PAYOUT, not entry
  // Correct formula: winProb * (1 - feePct) > askPrice
  // At 10% fee: win pays $0.90, not $1.00
  const feePct = market.feeRateBps / 10_000
  const feeAdjustedPayout = 1.0 - feePct  // e.g., 0.90 at 1000 bps
  const expectedReturn = 0.637 * feeAdjustedPayout  // winProb * net payout
  if (expectedReturn <= askPrice) {
    this.log(`Not +EV: expected ${expectedReturn.toFixed(3)} <= ask ${askPrice.toFixed(3)} (fee ${market.feeRateBps}bps)`)
    return
  }

  // 9. RiskManager gate (handled inside TradingService.placeBet)
  // 10. Place FOK order
  const { tradingService } = await import('@/services/trading')
  const result = await tradingService.placeBet(market, outcome, this.config.tradeSize, {
    strategy: 'five-min-macd',
    orderType: 'FOK',
    asset: 'BTC',
  })

  // 11. Log to ActivityLogger
  const { activityLogger } = await import('@/services/trading')
  activityLogger.logTrade({
    strategy: 'five-min-macd',
    outcome,
    size: this.config.tradeSize,
    askPrice,
    histogram,
    feeBps: market.feeRateBps,
    success: result.success,
  })

  if (result.success) {
    this.windowState.traded = true
    this.dailyTradeCount++
    this.emit('tradePlaced', { outcome, histogram, askPrice })
  }
}
```

## Settings (settingsStore v63)

```typescript
// New fields in SettingsState interface
fiveMinMacdEnabled: boolean              // default: false
fiveMinMacdTradeSize: number             // default: 2.50
fiveMinMacdHistogramThreshold: number    // default: 50
fiveMinMacdSnipeLeadMs: number           // default: 10_000
fiveMinMacdMaxDailyTrades: number        // default: 15
```

All accessed via `useSettingsStore.getState()` in the strategy. Dynamic imports for any setter that touches strategy instances (following existing circular dep pattern).

## Risk Integration

- **RiskManager**: Standard daily/weekly loss limits, balance floor, hourly trade cap all apply via TradingService
- **Strategy-level daily cap**: `fiveMinMacdMaxDailyTrades` (default 15). Reset mechanism: check `Date.now()` against last-reset timestamp on each snipe evaluation. If UTC day has changed, reset counter. No separate timer needed.
- **No PLM (SL/TP)**: 5-min markets resolve automatically — no early exit needed. Position resolves to $1.00 or $0.00 within minutes.
- **Fee model**: 5-min crypto markets likely charge 1000 bps (10%) taker fee, same as 15-min. Fee is fetched from `/fee-rate?token_id=X` on market discovery and cached. The EV formula accounts for fees on payout: `winProb * (1 - feePct) > askPrice`. At 10% fee with 63.7% win rate: `0.637 * 0.90 = 0.573` — profitable as long as ask < $0.57. Moon Dev's backtest confirms profitability at $0.58 entry.
- **No resolution-hold tracking**: Unlike BtcUpDown, we don't monitor positions post-entry. The market resolves itself.
- **ActivityLogger**: All trades and skips logged to central audit trail for consistency.

## Test Plan

### Unit Tests

1. **MACD math correctness**
   - `computeEMA()` against hand-calculated values
   - `computeMACD()` with known price series → verify histogram matches reference implementation
   - Edge case: exactly 20 candles (minimum viable), < 20 candles (should return null/skip)

2. **Candle aggregation**
   - Ticks within same minute → single candle with correct OHLCV
   - Minute boundary crossing → candle closes, new candle opens
   - Buffer eviction at 35 candles

3. **Window timing**
   - `getNextWindowClose()` aligns to 5-min clock boundaries
   - Snipe fires at T-10s (with mocked `Date.now()` and `setTimeout`)
   - Double-trade prevention (`traded` flag)

4. **Signal filter**
   - histogram = 60 → trade (above threshold)
   - histogram = 40 → skip (below threshold)
   - histogram = -70 → trade NO direction

5. **EV gate**
   - Fee-adjusted cost < win probability → trade
   - Fee-adjusted cost >= win probability → skip
   - Various fee rates (1000 bps, 500 bps, 0 bps)

### Integration Tests

6. **Full cycle (mocked)**
   - Mock BinanceWS ticks → candle aggregation → MACD → window timer → trade decision
   - Mock TradingService.placeBet → verify correct parameters
   - Verify daily trade count increments and caps

7. **Lifecycle**
   - `enable()` → `start()` → connects BinanceWS, fetches klines, schedules timer
   - `disable()` → `stop()` → clears intervals, unsubscribes, resets state
   - Re-enable after disable works cleanly

## Non-Goals

- **UI settings panel**: Can defer to a follow-up. Strategy is configurable via settingsStore directly.
- **Backtest runner**: Not in scope. Moon Dev's backtest data is the validation.
- **Multi-asset**: BTC only. ETH/SOL/XRP 5-min markets can be added later if edge holds.
- **Maker mode**: 5-min windows are too short for GTC fills. FOK taker only.
- **MACD parameter tuning UI**: Hardcoded (6,20,5) per backtest results. No need for UI knobs.

## Implementation Notes

- **MACD histogram units are in USD** (EMA difference of BTC prices). Threshold of 50 is calibrated for BTC ~$73K-85K range. If BTC price changes significantly (e.g., >$150K), the threshold may need proportional adjustment. This is acceptable for now — configurable via `fiveMinMacdHistogramThreshold` setting.
- **Binance REST kline bootstrap** goes through Vite proxy (`/api/binance` → `https://api.binance.com`) to avoid CORS. Add proxy entry to `vite.config.ts`.
- **settingsStore v63 migration**: Add a migration step from v62→v63 that sets defaults for all 5 new fields. Follow existing migration pattern.

## Open Questions

None — all decisions resolved during brainstorming. Six issues from spec review addressed in v2.
