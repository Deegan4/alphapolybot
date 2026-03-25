/**
 * GabagoolBacktestRunner — replay Gabagool accumulator logic against PolyBacktest snapshots.
 *
 * Simulates the accumulation strategy: for each snapshot, check if YES or NO outcome
 * is cheap enough to accumulate. Tracks a virtual WindowAccumulator that builds up
 * both sides. When pair cost < $1.00, profit is locked.
 *
 * Uses OPTIMISTIC fill model: assumes all GTC+postOnly orders fill at the posted price.
 * This gives an upper-bound estimate of real performance.
 */
import type {
  UnifiedTradeRecord,
  StrategyBacktestResult,
  PolyBacktestMarket,
  PolyBacktestSnapshot,
} from '@/types'
import { computeBacktestSummary } from './BacktestSummaryEngine'

export interface GabagoolBacktestConfig {
  cheapnessThreshold: number   // Max price to consider "cheap" (default 0.48)
  orderSize: number            // USD per order (default 2.0)
  maxImbalance: number         // Max ratio imbalance between sides (default 3.0)
  minProfitMargin: number      // Min profit to trigger merge (default 0.005 = 0.5%)
  maxExposure: number          // Max total USD in play per window (default 10)
  cooldownMs: number           // Min ms between orders (default 5000)
}

const DEFAULT_CONFIG: GabagoolBacktestConfig = {
  cheapnessThreshold: 0.48,
  orderSize: 2.0,
  maxImbalance: 3.0,
  minProfitMargin: 0.005,
  maxExposure: 10,
  cooldownMs: 5_000,
}

interface Accumulator {
  qtyUp: number
  qtyDown: number
  costUp: number
  costDown: number
}

export class GabagoolBacktestRunner {
  run(
    market: PolyBacktestMarket,
    snapshots: PolyBacktestSnapshot[],
    config?: Partial<GabagoolBacktestConfig>,
  ): StrategyBacktestResult {
    const cfg = { ...DEFAULT_CONFIG, ...config }
    const trades: UnifiedTradeRecord[] = []
    const acc: Accumulator = { qtyUp: 0, qtyDown: 0, costUp: 0, costDown: 0 }

    const windowEndMs = new Date(market.end_time).getTime()
    let lastOrderMs = 0

    for (const snapshot of snapshots) {
      const snapshotMs = new Date(snapshot.time).getTime()
      if (snapshotMs - lastOrderMs < cfg.cooldownMs) continue

      const totalExposure = acc.costUp + acc.costDown
      if (totalExposure >= cfg.maxExposure) continue

      const upPrice = snapshot.price_up
      const downPrice = snapshot.price_down

      // Determine which side to buy
      const side = this.selectSide(acc, upPrice, downPrice, cfg)
      if (!side) continue

      const price = side === 'up' ? upPrice : downPrice
      const qty = cfg.orderSize / price

      // Simulate fill (optimistic)
      if (side === 'up') {
        acc.qtyUp += qty
        acc.costUp += cfg.orderSize
      } else {
        acc.qtyDown += qty
        acc.costDown += cfg.orderSize
      }

      lastOrderMs = snapshotMs

      // Check if merge is profitable
      const minQty = Math.min(acc.qtyUp, acc.qtyDown)
      const totalCost = acc.costUp + acc.costDown
      const mergeValue = minQty * 1.0
      const profitMargin = totalCost > 0 ? (mergeValue - totalCost) / totalCost : 0

      if (minQty > 0 && profitMargin >= cfg.minProfitMargin) {
        // Lock profit via merge
        const pnl = mergeValue - totalCost // 0% maker fees

        trades.push({
          timestamp: snapshot.time,
          strategy: 'gabagool',
          direction: 'merge',
          entryPrice: totalCost,
          exitPrice: mergeValue,
          pnl,
          feePaid: 0,
          holdTimeMs: snapshotMs - new Date(snapshots[0].time).getTime(),
          metadata: {
            marketId: market.market_id,
            slug: market.slug,
            qtyUp: acc.qtyUp,
            qtyDown: acc.qtyDown,
            costUp: acc.costUp,
            costDown: acc.costDown,
            profitMargin,
            ordersPlaced: Math.round((acc.costUp + acc.costDown) / cfg.orderSize),
          },
        })

        // Reset accumulator after merge
        const mergedQty = minQty
        acc.qtyUp -= mergedQty
        acc.qtyDown -= mergedQty
        // Proportional cost reduction
        if (acc.qtyUp > 0) {
          acc.costUp *= acc.qtyUp / (acc.qtyUp + mergedQty)
        } else {
          acc.costUp = 0
        }
        if (acc.qtyDown > 0) {
          acc.costDown *= acc.qtyDown / (acc.qtyDown + mergedQty)
        } else {
          acc.costDown = 0
        }
      }
    }

    // End-of-window: resolve any remaining position at market outcome
    if (acc.qtyUp > 0 || acc.qtyDown > 0) {
      const totalCost = acc.costUp + acc.costDown
      let payout = 0
      if (market.winner === 'up') {
        payout = acc.qtyUp * 0.90 // 10% fee on resolution for 15m crypto
      } else if (market.winner === 'down') {
        payout = acc.qtyDown * 0.90
      }
      const pnl = payout - totalCost

      if (totalCost > 0) {
        trades.push({
          timestamp: market.end_time,
          strategy: 'gabagool',
          direction: 'resolve',
          entryPrice: totalCost,
          exitPrice: payout,
          pnl,
          feePaid: payout * 0.10,
          holdTimeMs: windowEndMs - new Date(snapshots[0]?.time ?? market.start_time).getTime(),
          metadata: {
            marketId: market.market_id,
            winner: market.winner,
            orphanedUp: acc.qtyUp,
            orphanedDown: acc.qtyDown,
          },
        })
      }
    }

    return {
      strategy: 'gabagool',
      strategyName: 'Gabagool Accumulator',
      trades,
      summary: computeBacktestSummary(trades),
      dataSource: 'polybacktest',
      config: cfg,
    }
  }

  private selectSide(
    acc: Accumulator,
    upPrice: number,
    downPrice: number,
    cfg: GabagoolBacktestConfig,
  ): 'up' | 'down' | null {
    const upCheap = upPrice <= cfg.cheapnessThreshold
    const downCheap = downPrice <= cfg.cheapnessThreshold
    if (!upCheap && !downCheap) return null

    // Check imbalance
    const ratio = acc.qtyUp > 0 && acc.qtyDown > 0
      ? Math.max(acc.qtyUp / acc.qtyDown, acc.qtyDown / acc.qtyUp)
      : 1

    if (ratio > cfg.maxImbalance) {
      // Rebalance: buy the side with fewer shares
      if (acc.qtyUp < acc.qtyDown && upCheap) return 'up'
      if (acc.qtyDown < acc.qtyUp && downCheap) return 'down'
      return null
    }

    // Both cheap → buy cheaper
    if (upCheap && downCheap) {
      return upPrice <= downPrice ? 'up' : 'down'
    }

    // One cheap → buy it
    return upCheap ? 'up' : 'down'
  }
}

export const gabagoolBacktestRunner = new GabagoolBacktestRunner()
