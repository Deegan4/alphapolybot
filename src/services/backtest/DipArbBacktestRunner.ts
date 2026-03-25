/**
 * DipArbBacktestRunner — replay DipArb spread-scan logic against recorded snapshots.
 *
 * Simulates the spread scan: for each snapshot, checks if askSum < sumTarget.
 * If arb exists, records a trade with deterministic P&L = (1.00 - askSum - fees).
 *
 * Data sources:
 *   - RecordedSnapshots from SnapshotRecorder (IndexedDB)
 *   - Or synthetic data provided directly
 */
import type {
  UnifiedTradeRecord,
  StrategyBacktestResult,
  RecordedSnapshot,
} from '@/types'
import { computeBacktestSummary } from './BacktestSummaryEngine'

export interface DipArbBacktestConfig {
  sumTarget: number          // Max askSum to trigger arb (default 0.96)
  takerFeeBps: number        // Per-leg taker fee in bps (default 200 = 2%)
  minVolume: number          // Min 24h volume (default 50)
  cooldownMs: number         // Per-market cooldown (default 30000)
  tradeSize: number          // USD per arb round (default 5)
}

const DEFAULT_CONFIG: DipArbBacktestConfig = {
  sumTarget: 0.96,
  takerFeeBps: 200,
  minVolume: 50,
  cooldownMs: 30_000,
  tradeSize: 5,
}

export class DipArbBacktestRunner {
  run(
    snapshots: RecordedSnapshot[],
    config?: Partial<DipArbBacktestConfig>,
  ): StrategyBacktestResult {
    const cfg = { ...DEFAULT_CONFIG, ...config }
    const feeRate = cfg.takerFeeBps / 10_000
    const trades: UnifiedTradeRecord[] = []

    // Group snapshots by market, sorted by time
    const byMarket = new Map<string, RecordedSnapshot[]>()
    for (const s of snapshots) {
      const arr = byMarket.get(s.marketId) || []
      arr.push(s)
      byMarket.set(s.marketId, arr)
    }

    // Track per-market cooldowns
    const lastTradeTime = new Map<string, number>()

    // Process each market's snapshots in time order
    for (const [marketId, marketSnapshots] of byMarket) {
      marketSnapshots.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime())

      for (const snapshot of marketSnapshots) {
        // Volume filter
        if ((snapshot.volume24h ?? 0) < cfg.minVolume) continue

        // Need ask prices for both outcomes
        if (!snapshot.askPrices || snapshot.askPrices.length < 2) continue

        // Cooldown
        const ts = new Date(snapshot.timestamp).getTime()
        const lastTs = lastTradeTime.get(marketId) ?? 0
        if (ts - lastTs < cfg.cooldownMs) continue

        const ask0 = snapshot.askPrices[0]
        const ask1 = snapshot.askPrices[1]
        const askSum = ask0 + ask1

        // Arb condition: buying both outcomes costs less than sumTarget
        if (askSum >= cfg.sumTarget) continue

        // Two-leg taker fees (buy YES + buy NO)
        const totalFee = (ask0 * feeRate + ask1 * feeRate) * cfg.tradeSize
        const grossProfit = (1.0 - askSum) * cfg.tradeSize
        const netProfit = grossProfit - totalFee

        // Only trade if net profitable
        if (netProfit <= 0) continue

        trades.push({
          timestamp: snapshot.timestamp,
          strategy: 'dip-arb',
          direction: 'buy-all',
          entryPrice: askSum,
          exitPrice: 1.0,      // Merge payout
          pnl: netProfit,
          feePaid: totalFee,
          holdTimeMs: 0,       // Instant merge
          metadata: {
            marketId,
            slug: snapshot.slug,
            ask0,
            ask1,
            askSum,
            grossProfit,
          },
        })

        lastTradeTime.set(marketId, ts)
      }
    }

    return {
      strategy: 'dip-arb',
      strategyName: 'Dip Arbitrage',
      trades,
      summary: computeBacktestSummary(trades),
      dataSource: 'snapshot-recorder',
      config: cfg,
    }
  }
}

export const dipArbBacktestRunner = new DipArbBacktestRunner()
