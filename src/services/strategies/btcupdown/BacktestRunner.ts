/**
 * BacktestRunner — replay BTC Up/Down strategy logic against PolyBacktest snapshots.
 *
 * Standalone service, no dependency on BtcUpDownStrategy or any live-trading
 * infrastructure (BinanceWS, TradingService, PLM, etc.). Imports only:
 *   - signalEngine (pure math)
 *   - polyBacktestClient (data fetching)
 *   - types
 */
import {
  computeSignal,
  computeOrderbookImbalance,
} from './signalEngine'
import type { SignalInput, SignalEngineConfig } from './signalEngine'
import { polyBacktestClient } from '@/services/api/PolyBacktestClient'
import type {
  BtcUpDownConfig,
  PolyBacktestMarket,
  PolyBacktestMarketType,
  PolyBacktestSnapshot,
  BacktestResult,
  BacktestTradeRecord,
  BacktestSummary,
  Market,
} from '@/types'

// ==========================================
// DEFAULTS (mirror live strategy)
// ==========================================

const DEFAULT_CONFIG: BtcUpDownConfig = {
  enableBtc: true,
  enableEth: false,
  enableSol: false,
  enableXrp: false,
  enable5m: false,
  enable15m: true,
  enableHourly: false,
  enableDaily: false,
  enable9pm: false,
  tradeSize: 2.0,
  useKellySizing: false,  // Backtest uses fixed size for consistency
  minConfidence: 0.55,
  maxEntryPrice: 0.45,
  minEntryPrice: 0.10,
  minWindowRemaining: 120,
  minTimeIntoWindowMs: 45_000,
  regimeFilterEnabled: true,
  rsiFilterEnabled: true,
  scanIntervalMs: 1000,
  maxConcurrentPositions: 4,
  maxEntriesPerMarket: 1,
  cooldownMs: 15_000,
  stopLossPercent: 0.95,
  takeProfitPercent: 0.95,
  maxHoldMs: 16 * 60 * 1000,
  useLLMConfirmation: false,
}

const BASELINE_WINDOW_MS = 15 * 60 * 1000

const WINDOW_DURATION_MAP: Record<PolyBacktestMarketType, number> = {
  '5m':  5 * 60 * 1000,
  '15m': 15 * 60 * 1000,
  '1hr': 60 * 60 * 1000,
  '4hr': 4 * 60 * 60 * 1000,
  '24hr': 24 * 60 * 60 * 1000,
}

// ==========================================
// OPTIONS
// ==========================================

export interface BacktestOptions {
  marketId?: string
  slug?: string
  config?: Partial<BtcUpDownConfig>
  feeRateBps?: number      // default 1000 (10% crypto)
  includeOrderbook?: boolean // default true — enables flow imbalance factor
  onProgress?: (current: number, total: number) => void
  signal?: AbortSignal     // cancellation support
}

// ==========================================
// BACKTEST RUNNER
// ==========================================

export class BacktestRunner {
  /**
   * Run backtest on a single market.
   * Fetches market + snapshots, replays signal computation, returns results.
   */
  async run(options: BacktestOptions): Promise<BacktestResult> {
    const config = { ...DEFAULT_CONFIG, ...options.config }
    const feeRateBps = options.feeRateBps ?? 1000
    const includeOrderbook = options.includeOrderbook ?? true

    options.signal?.throwIfAborted()

    // Fetch market
    const market = options.marketId
      ? await polyBacktestClient.getMarket(options.marketId)
      : await polyBacktestClient.getMarketBySlug(options.slug!)

    options.signal?.throwIfAborted()

    // Fetch all snapshots
    const snapshots = await polyBacktestClient.getAllSnapshots(
      market.market_id,
      includeOrderbook,
      options.onProgress,
      options.signal,
    )

    if (snapshots.length === 0) {
      return this.emptyResult(market, config)
    }

    // Replay
    return this.replay(market, snapshots, config, feeRateBps)
  }

  /**
   * Run backtest across resolved markets of a given type.
   * @param maxMarkets — caps the number of markets to backtest (default 50)
   * @param onDiscovery — progress callback during market fetch phase
   */
  async runBatch(
    marketType: PolyBacktestMarketType,
    options?: Omit<BacktestOptions, 'marketId' | 'slug'> & {
      maxMarkets?: number
      onDiscovery?: (label: string) => void
    },
  ): Promise<BacktestResult[]> {
    const signal = options?.signal
    signal?.throwIfAborted()

    options?.onDiscovery?.(`Discovering ${marketType} markets...`)
    const allMarkets = await polyBacktestClient.getResolvedMarkets(marketType, signal)
    signal?.throwIfAborted()

    const maxMarkets = options?.maxMarkets ?? 50
    const markets = allMarkets.slice(0, maxMarkets)
    options?.onDiscovery?.(`Found ${allMarkets.length} markets, running ${markets.length}`)

    const results: BacktestResult[] = []

    for (let i = 0; i < markets.length; i++) {
      signal?.throwIfAborted()
      try {
        const result = await this.run({
          ...options,
          marketId: markets[i].market_id,
          signal,
        })
        results.push(result)
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') throw err
        console.warn(`Backtest failed for market ${markets[i].market_id}:`, err)
      }
      options?.onProgress?.(i + 1, markets.length)
    }

    return results
  }

  /**
   * Aggregate summary across multiple backtest results.
   */
  aggregateResults(results: BacktestResult[]): BacktestSummary {
    const allTrades = results.flatMap(r => r.trades)
    return this.computeSummary(allTrades)
  }

  // ==========================================
  // REPLAY ENGINE
  // ==========================================

  private replay(
    market: PolyBacktestMarket,
    snapshots: PolyBacktestSnapshot[],
    config: BtcUpDownConfig,
    feeRateBps: number,
  ): BacktestResult {
    const trades: BacktestTradeRecord[] = []
    const priceHistory: Array<{ price: number; timestamp: number }> = []
    const windowDurationMs = WINDOW_DURATION_MAP[market.market_type] ?? 15 * 60 * 1000
    const windowStartMs = new Date(market.start_time).getTime()
    const windowEndMs = new Date(market.end_time).getTime()
    const feeRate = feeRateBps / 10_000 // 0.10 for 10%

    // Scale time-based config params
    const timeScale = windowDurationMs / BASELINE_WINDOW_MS
    const scaledMinTimeIntoWindow = config.minTimeIntoWindowMs * timeScale
    const scaledMinWindowRemaining = config.minWindowRemaining * 1000 * timeScale

    let hasPosition = false

    const signalConfig: SignalEngineConfig = {
      regimeFilterEnabled: config.regimeFilterEnabled,
      rsiFilterEnabled: config.rsiFilterEnabled,
      baselineWindowMs: BASELINE_WINDOW_MS,
    }

    // Reference price = btc_price_start from the market
    const windowOpenPrice = market.btc_price_start ?? snapshots[0].btc_price

    // Build a stub Market object for SignalInput (only used for type compatibility)
    const stubMarket = this.buildStubMarket(market)

    for (const snapshot of snapshots) {
      const snapshotMs = new Date(snapshot.time).getTime()
      const timeIntoWindowMs = snapshotMs - windowStartMs
      const timeRemainingMs = windowEndMs - snapshotMs

      // Accumulate price history (cap at 300 like live strategy)
      priceHistory.push({ price: snapshot.btc_price, timestamp: snapshotMs })
      if (priceHistory.length > 300) priceHistory.shift()

      // Skip if already holding a position (resolution-hold = one entry per market)
      if (hasPosition) continue

      // --- ENTRY GATE: time-in-window ---
      if (timeIntoWindowMs < scaledMinTimeIntoWindow) continue

      // --- ENTRY GATE: min window remaining ---
      if (timeRemainingMs < scaledMinWindowRemaining) continue

      // Regime filter is now graduated inside computeSignal() — no hard block here.

      // --- COMPUTE SIGNAL ---
      // Compute orderbook flow imbalance if available
      const priceDelta = (snapshot.btc_price - windowOpenPrice) / windowOpenPrice
      const direction = priceDelta >= 0 ? 'up' : 'down'
      const relevantOrderbook = direction === 'up'
        ? snapshot.orderbook_up
        : snapshot.orderbook_down
      const imbalanceScore = computeOrderbookImbalance(relevantOrderbook)

      const signalInput: SignalInput = {
        asset: 'BTC',
        currentPrice: snapshot.btc_price,
        windowOpenPrice,
        upPrice: snapshot.price_up,
        downPrice: snapshot.price_down,
        timeIntoWindowMs,
        windowDurationMs,
        recentPriceHistory: [...priceHistory],
        market: stubMarket,
      }

      const signal = computeSignal(signalInput, signalConfig, imbalanceScore)

      // --- ENTRY GATE: min confidence ---
      if (signal.confidence < config.minConfidence) continue

      // --- ENTRY GATE: price range ---
      const targetPrice = signal.direction === 'up' ? snapshot.price_up : snapshot.price_down
      if (targetPrice > config.maxEntryPrice) continue
      if (targetPrice < config.minEntryPrice) continue

      // --- ENTRY: record trade ---
      const pnl = this.computeTradePnl(
        signal.direction, targetPrice, market.winner, feeRate,
      )

      trades.push({
        snapshotTime: snapshot.time,
        direction: signal.direction,
        confidence: signal.confidence,
        entryPrice: targetPrice,
        btcPriceAtEntry: snapshot.btc_price,
        resolved: market.winner !== null,
        winner: market.winner,
        pnl,
        holdTimeMs: windowEndMs - snapshotMs,
      })

      hasPosition = true

      // Resolution-hold: max one entry per market
      if (trades.length >= config.maxEntriesPerMarket) break
    }

    return {
      marketId: market.market_id,
      slug: market.slug,
      marketType: market.market_type,
      config,
      trades,
      summary: this.computeSummary(trades),
    }
  }

  // ==========================================
  // HELPERS
  // ==========================================

  private computeTradePnl(
    direction: 'up' | 'down',
    entryPrice: number,
    winner: 'up' | 'down' | null,
    feeRate: number,
  ): number {
    if (winner === null) return 0 // unresolved
    const won = direction === winner
    if (won) {
      // Payout = $1 minus fee, cost = entryPrice
      return (1.0 - feeRate) - entryPrice
    } else {
      return -entryPrice
    }
  }

  private computeSummary(trades: BacktestTradeRecord[]): BacktestSummary {
    if (trades.length === 0) {
      return {
        totalTrades: 0, wins: 0, losses: 0, winRate: 0,
        totalPnl: 0, avgPnl: 0, avgHoldTimeMs: 0,
        maxDrawdown: 0, sharpeRatio: null, profitFactor: null,
      }
    }

    const resolved = trades.filter(t => t.resolved)
    const wins = resolved.filter(t => t.pnl > 0).length
    const losses = resolved.filter(t => t.pnl < 0).length
    const totalPnl = resolved.reduce((s, t) => s + t.pnl, 0)
    const avgPnl = resolved.length > 0 ? totalPnl / resolved.length : 0
    const avgHoldTimeMs = trades.reduce((s, t) => s + t.holdTimeMs, 0) / trades.length

    // Max drawdown (cumulative P&L)
    let peak = 0
    let maxDrawdown = 0
    let cumPnl = 0
    for (const t of resolved) {
      cumPnl += t.pnl
      if (cumPnl > peak) peak = cumPnl
      const dd = peak - cumPnl
      if (dd > maxDrawdown) maxDrawdown = dd
    }

    // Sharpe ratio (annualized, assuming ~35,000 15m windows/year)
    let sharpeRatio: number | null = null
    if (resolved.length >= 5) {
      const pnls = resolved.map(t => t.pnl)
      const mean = pnls.reduce((s, p) => s + p, 0) / pnls.length
      const variance = pnls.reduce((s, p) => s + (p - mean) ** 2, 0) / pnls.length
      const stdDev = Math.sqrt(variance)
      if (stdDev > 0) {
        sharpeRatio = (mean / stdDev) * Math.sqrt(35_000)
      }
    }

    // Profit factor (gross profits / gross losses)
    const grossProfit = resolved.filter(t => t.pnl > 0).reduce((s, t) => s + t.pnl, 0)
    const grossLoss = Math.abs(resolved.filter(t => t.pnl < 0).reduce((s, t) => s + t.pnl, 0))
    const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : null

    return {
      totalTrades: trades.length,
      wins,
      losses,
      winRate: resolved.length > 0 ? wins / resolved.length : 0,
      totalPnl,
      avgPnl,
      avgHoldTimeMs,
      maxDrawdown,
      sharpeRatio,
      profitFactor,
    }
  }

  private buildStubMarket(pbt: PolyBacktestMarket): Market {
    // Minimal Market stub for SignalInput type compatibility.
    // Only clobTokenIds, outcomes, and question are accessed inside computeSignal
    // (for flow factor), but the extracted signalEngine accepts imbalanceScore directly,
    // so these fields are never actually read.
    return {
      id: pbt.market_id,
      question: `Will BTC go up or down? (${pbt.slug})`,
      conditionId: pbt.condition_id ?? '',
      slug: pbt.slug,
      outcomes: ['Up', 'Down'],
      outcomePrices: ['0.5', '0.5'],
      clobTokenIds: [pbt.clob_token_up ?? '', pbt.clob_token_down ?? ''],
      active: false,
      closed: true,
      volume: pbt.final_volume ?? 0,
      liquidity: pbt.final_liquidity ?? 0,
    } as Market
  }

  private emptyResult(
    market: PolyBacktestMarket,
    config: BtcUpDownConfig,
  ): BacktestResult {
    return {
      marketId: market.market_id,
      slug: market.slug,
      marketType: market.market_type,
      config,
      trades: [],
      summary: this.computeSummary([]),
    }
  }
}

export const backtestRunner = new BacktestRunner()
