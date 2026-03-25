/**
 * DualSideBacktestRunner — replay dual-side hedge logic against PolyBacktest snapshots.
 *
 * Piggybacks on the Crypto Up/Down signal engine: for each snapshot where the BTC signal
 * fires, simulates placing 70/30 biased YES+NO maker orders. Assumes optimistic fills
 * (both legs fill at posted price) since we can't model queue position historically.
 *
 * P&L model: if both legs fill and askSum < $1.00, guaranteed profit = 1.00 - askSum.
 * Upper-bound estimate — real fills are worse.
 */
import type {
  UnifiedTradeRecord,
  StrategyBacktestResult,
  PolyBacktestMarket,
  PolyBacktestSnapshot,
} from '@/types'
import { computeSignal, computeOrderbookImbalance } from '../strategies/btcupdown/signalEngine'
import type { SignalInput, SignalEngineConfig } from '../strategies/btcupdown/signalEngine'
import { computeBacktestSummary } from './BacktestSummaryEngine'

export interface DualSideBacktestConfig {
  minSignalConfidence: number  // BTC signal confidence threshold (default 0.35)
  maxAskSum: number            // Max ask sum for incoherence gate (default 0.995)
  biasRatio: number            // Fraction to predicted winner (default 0.70)
  tradeSize: number            // Total USD across both legs (default 2.0)
  regimeFilterEnabled: boolean
  rsiFilterEnabled: boolean
}

const DEFAULT_CONFIG: DualSideBacktestConfig = {
  minSignalConfidence: 0.35,
  maxAskSum: 0.995,
  biasRatio: 0.70,
  tradeSize: 2.0,
  regimeFilterEnabled: true,
  rsiFilterEnabled: true,
}

export class DualSideBacktestRunner {
  run(
    market: PolyBacktestMarket,
    snapshots: PolyBacktestSnapshot[],
    config?: Partial<DualSideBacktestConfig>,
  ): StrategyBacktestResult {
    const cfg = { ...DEFAULT_CONFIG, ...config }
    const trades: UnifiedTradeRecord[] = []
    const priceHistory: Array<{ price: number; timestamp: number }> = []

    const windowStartMs = new Date(market.start_time).getTime()
    const windowEndMs = new Date(market.end_time).getTime()
    const windowDurationMs = windowEndMs - windowStartMs
    const windowOpenPrice = market.btc_price_start ?? snapshots[0]?.btc_price ?? 0

    let hasPosition = false

    const signalConfig: SignalEngineConfig = {
      regimeFilterEnabled: cfg.regimeFilterEnabled,
      rsiFilterEnabled: cfg.rsiFilterEnabled,
      baselineWindowMs: 15 * 60 * 1000,
    }

    for (const snapshot of snapshots) {
      const snapshotMs = new Date(snapshot.time).getTime()
      const timeIntoWindowMs = snapshotMs - windowStartMs

      priceHistory.push({ price: snapshot.btc_price, timestamp: snapshotMs })
      if (priceHistory.length > 300) priceHistory.shift()

      if (hasPosition) continue

      // Need at least 45s into window
      if (timeIntoWindowMs < 45_000) continue

      // Compute BTC signal
      const priceDelta = (snapshot.btc_price - windowOpenPrice) / windowOpenPrice
      const direction = priceDelta >= 0 ? 'up' : 'down'
      const relevantOrderbook = direction === 'up' ? snapshot.orderbook_up : snapshot.orderbook_down
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
        market: {
          id: market.market_id,
          question: `Crypto Up/Down (${market.slug})`,
          conditionId: market.condition_id ?? '',
          slug: market.slug,
          outcomes: ['Up', 'Down'],
          outcomePrices: ['0.5', '0.5'],
          clobTokenIds: [market.clob_token_up ?? '', market.clob_token_down ?? ''],
          active: false,
          closed: true,
          volume: market.final_volume ?? 0,
          liquidity: market.final_liquidity ?? 0,
        } as import('@/types').Market,
      }

      const signal = computeSignal(signalInput, signalConfig, imbalanceScore)
      if (signal.confidence < cfg.minSignalConfidence) continue

      // Check ask sum incoherence
      const askSum = snapshot.price_up + snapshot.price_down
      if (askSum > cfg.maxAskSum) continue

      // Simulate dual-side fills (optimistic: both fill at ask price)
      const winnerPrice = signal.direction === 'up' ? snapshot.price_up : snapshot.price_down
      const hedgePrice = signal.direction === 'up' ? snapshot.price_down : snapshot.price_up
      const winnerSize = cfg.tradeSize * cfg.biasRatio
      const hedgeSize = cfg.tradeSize * (1 - cfg.biasRatio)

      const totalCost = winnerPrice * winnerSize + hedgePrice * hedgeSize
      const minQty = Math.min(winnerSize / winnerPrice, hedgeSize / hedgePrice)

      // P&L: merge min(qtyYes, qtyNo) pairs at $1.00 each, remainder resolves
      const mergeProfit = minQty * 1.0 - totalCost
      // Maker orders = 0% fee
      const pnl = mergeProfit

      trades.push({
        timestamp: snapshot.time,
        strategy: 'dual-side',
        direction: signal.direction,
        entryPrice: totalCost,
        exitPrice: minQty * 1.0,
        pnl,
        feePaid: 0,
        holdTimeMs: windowEndMs - snapshotMs,
        metadata: {
          confidence: signal.confidence,
          askSum,
          winnerPrice,
          hedgePrice,
          biasRatio: cfg.biasRatio,
        },
      })

      hasPosition = true
    }

    return {
      strategy: 'dual-side',
      strategyName: 'Dual-Side Hedge',
      trades,
      summary: computeBacktestSummary(trades),
      dataSource: 'polybacktest',
      config: cfg,
    }
  }
}

export const dualSideBacktestRunner = new DualSideBacktestRunner()
