/**
 * ImpulseBacktestRunner — replay impulse detection logic against PolyBacktest snapshots.
 *
 * Simulates the latency arb: detects price impulses between consecutive snapshots,
 * checks if CLOB outcome prices haven't repriced yet (stale odds), and trades
 * the directionally-correct outcome.
 *
 * Limitation: PolyBacktest snapshots are ~1min intervals vs. BinanceWS 1s ticks.
 * This is a rough approximation — real impulse detection operates at sub-second scale.
 * Results represent a lower bound on detectable impulses (many sub-minute impulses missed).
 */
import type {
  UnifiedTradeRecord,
  StrategyBacktestResult,
  PolyBacktestMarket,
  PolyBacktestSnapshot,
} from '@/types'
import { computeBacktestSummary } from './BacktestSummaryEngine'

export interface ImpulseBacktestConfig {
  impulseThreshold: number     // Min BTC price move to trigger (default 200 = $200)
  staleOddsThreshold: number   // Max odds move to consider "stale" (default 0.03)
  tradeSize: number            // USD per trade (default 2.0)
  takerFeeBps: number          // Taker fee in bps (default 100 for 1h markets)
  stopLossPct: number          // SL as fraction of entry (default 0.15)
  takeProfitPct: number        // TP as fraction of entry (default 0.40)
  cooldownMs: number           // Per-market cooldown (default 30000)
  lookbackSnapshots: number    // Snapshots to average for baseline (default 5)
}

const DEFAULT_CONFIG: ImpulseBacktestConfig = {
  impulseThreshold: 200,
  staleOddsThreshold: 0.03,
  tradeSize: 2.0,
  takerFeeBps: 100,       // 1h markets
  stopLossPct: 0.15,
  takeProfitPct: 0.40,
  cooldownMs: 30_000,
  lookbackSnapshots: 5,
}

export class ImpulseBacktestRunner {
  run(
    market: PolyBacktestMarket,
    snapshots: PolyBacktestSnapshot[],
    config?: Partial<ImpulseBacktestConfig>,
  ): StrategyBacktestResult {
    const cfg = { ...DEFAULT_CONFIG, ...config }
    const feeRate = cfg.takerFeeBps / 10_000
    const trades: UnifiedTradeRecord[] = []

    if (snapshots.length < cfg.lookbackSnapshots + 1) {
      return this.emptyResult(cfg)
    }

    const windowEndMs = new Date(market.end_time).getTime()
    let lastTradeMs = 0

    for (let i = cfg.lookbackSnapshots; i < snapshots.length; i++) {
      const current = snapshots[i]
      const snapshotMs = new Date(current.time).getTime()

      // Cooldown
      if (snapshotMs - lastTradeMs < cfg.cooldownMs) continue

      // Compute baseline BTC price (average of lookback window)
      let baselineSum = 0
      for (let j = i - cfg.lookbackSnapshots; j < i; j++) {
        baselineSum += snapshots[j].btc_price
      }
      const baselinePrice = baselineSum / cfg.lookbackSnapshots

      // Detect impulse
      const priceMove = current.btc_price - baselinePrice
      const absPriceMove = Math.abs(priceMove)
      if (absPriceMove < cfg.impulseThreshold) continue

      // Determine direction
      const direction: 'up' | 'down' = priceMove > 0 ? 'up' : 'down'

      // Check if odds are stale (haven't repriced to reflect the impulse)
      const prevSnapshot = snapshots[i - 1]
      const targetPrice = direction === 'up' ? current.price_up : current.price_down
      const prevTargetPrice = direction === 'up' ? prevSnapshot.price_up : prevSnapshot.price_down
      const oddsMove = Math.abs(targetPrice - prevTargetPrice)

      // Stale odds = price moved but odds didn't
      if (oddsMove > cfg.staleOddsThreshold) continue

      // Entry at current snapshot price
      const entryPrice = targetPrice
      if (entryPrice >= 0.90 || entryPrice <= 0.05) continue // Skip extreme prices

      // Simulate hold and exit
      const { exitPrice, exitTime, exitReason } = this.simulateExit(
        snapshots, i, direction, entryPrice, cfg, windowEndMs, market,
      )

      const qty = cfg.tradeSize / entryPrice
      const payout = exitPrice * qty
      const fee = entryPrice * qty * feeRate
      const pnl = payout - cfg.tradeSize - fee

      trades.push({
        timestamp: current.time,
        strategy: 'impulse-sniper',
        direction,
        entryPrice,
        exitPrice,
        pnl,
        feePaid: fee,
        holdTimeMs: exitTime - snapshotMs,
        metadata: {
          marketId: market.market_id,
          priceMove,
          oddsMove,
          exitReason,
          baselinePrice,
        },
      })

      lastTradeMs = snapshotMs
    }

    return {
      strategy: 'impulse-sniper',
      strategyName: 'Impulse Sniper',
      trades,
      summary: computeBacktestSummary(trades),
      dataSource: 'polybacktest',
      config: cfg,
    }
  }

  private simulateExit(
    snapshots: PolyBacktestSnapshot[],
    entryIndex: number,
    direction: 'up' | 'down',
    entryPrice: number,
    cfg: ImpulseBacktestConfig,
    windowEndMs: number,
    market: PolyBacktestMarket,
  ): { exitPrice: number; exitTime: number; exitReason: string } {
    const slPrice = entryPrice * (1 - cfg.stopLossPct)
    const tpPrice = entryPrice * (1 + cfg.takeProfitPct)

    for (let j = entryIndex + 1; j < snapshots.length; j++) {
      const s = snapshots[j]
      const price = direction === 'up' ? s.price_up : s.price_down
      const ts = new Date(s.time).getTime()

      if (price <= slPrice) {
        return { exitPrice: price, exitTime: ts, exitReason: 'stop-loss' }
      }
      if (price >= tpPrice) {
        return { exitPrice: price, exitTime: ts, exitReason: 'take-profit' }
      }
    }

    // Resolution: hold to end
    const won = direction === market.winner
    const feeRate = cfg.takerFeeBps / 10_000
    const exitPrice = won ? (1.0 - feeRate) : 0
    return { exitPrice, exitTime: windowEndMs, exitReason: 'resolution' }
  }

  private emptyResult(cfg: ImpulseBacktestConfig): StrategyBacktestResult {
    return {
      strategy: 'impulse-sniper',
      strategyName: 'Impulse Sniper',
      trades: [],
      summary: computeBacktestSummary([]),
      dataSource: 'polybacktest',
      config: cfg,
    }
  }
}

export const impulseBacktestRunner = new ImpulseBacktestRunner()
