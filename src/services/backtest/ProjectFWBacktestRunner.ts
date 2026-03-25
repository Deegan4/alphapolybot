/**
 * ProjectFWBacktestRunner — replay Frank-Wolfe optimizer against recorded snapshots.
 *
 * For each snapshot with 2+ outcomes, runs the FW optimizer to check if price
 * incoherence exists. If profitable arb found, records a trade.
 *
 * Key insight: Gamma mid-prices always sum to 1.00, so we need ask prices
 * from recorded snapshots to find real incoherence.
 */
import type {
  UnifiedTradeRecord,
  StrategyBacktestResult,
  RecordedSnapshot,
} from '@/types'
import type { MarketSnapshot, FWOptimizerConfig } from '../strategies/projectfw/types'
import { FrankWolfeOptimizer } from '../strategies/projectfw/FrankWolfeOptimizer'
import { computeBacktestSummary } from './BacktestSummaryEngine'

export interface FWBacktestConfig {
  alpha: number
  epsilonD: number
  epsilon0: number
  maxIterations: number
  minProfitBps: number      // Min guaranteed profit in bps (default 30)
  takerFeeBps: number       // Per-leg fee (default 0 for maker, 100 for taker)
  gasEstimateUSD: number    // Gas per tx (default 0.01)
  tradeSize: number         // USD per arb round (default 5)
  minLiquidity: number      // Min market liquidity (default 50)
  cooldownMs: number        // Per-market cooldown (default 60000)
}

const DEFAULT_CONFIG: FWBacktestConfig = {
  alpha: 0.5,
  epsilonD: 0.001,
  epsilon0: 0.1,
  maxIterations: 50,
  minProfitBps: 30,
  takerFeeBps: 0,
  gasEstimateUSD: 0.01,
  tradeSize: 5,
  minLiquidity: 50,
  cooldownMs: 60_000,
}

export class ProjectFWBacktestRunner {
  run(
    snapshots: RecordedSnapshot[],
    config?: Partial<FWBacktestConfig>,
  ): StrategyBacktestResult {
    const cfg = { ...DEFAULT_CONFIG, ...config }
    const feeRate = cfg.takerFeeBps / 10_000
    const trades: UnifiedTradeRecord[] = []

    const optimizerConfig: FWOptimizerConfig = {
      alpha: cfg.alpha,
      epsilonD: cfg.epsilonD,
      epsilon0: cfg.epsilon0,
      maxIterations: cfg.maxIterations,
    }
    const optimizer = new FrankWolfeOptimizer(optimizerConfig)

    // Group by market
    const byMarket = new Map<string, RecordedSnapshot[]>()
    for (const s of snapshots) {
      const arr = byMarket.get(s.marketId) || []
      arr.push(s)
      byMarket.set(s.marketId, arr)
    }

    const lastTradeTime = new Map<string, number>()

    for (const [marketId, marketSnapshots] of byMarket) {
      marketSnapshots.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime())

      for (const snapshot of marketSnapshots) {
        if ((snapshot.liquidity ?? 0) < cfg.minLiquidity) continue
        if (!snapshot.outcomes || snapshot.outcomes.length < 2) continue

        const ts = new Date(snapshot.timestamp).getTime()
        const lastTs = lastTradeTime.get(marketId) ?? 0
        if (ts - lastTs < cfg.cooldownMs) continue

        // Use ask prices if available, else mid-prices
        const prices = snapshot.askPrices && snapshot.askPrices.length >= 2
          ? snapshot.askPrices
          : snapshot.outcomePrices

        // Build minimal MarketSnapshot for optimizer
        const marketSnapshot: MarketSnapshot = {
          prices,
          outcomes: snapshot.outcomes,
          tokenIds: snapshot.clobTokenIds ?? snapshot.outcomes.map((_, i) => `token-${i}`),
          depth: prices.map(() => ({ bids: [], asks: [] })),
          settled: prices.map(() => false),
          conditionId: snapshot.conditionId ?? '',
          negRisk: snapshot.negRisk ?? false,
          marketId,
        }

        const result = optimizer.solve(marketSnapshot)
        if (!result) continue

        // Check profitability after fees and gas
        const totalCost = result.tradeLegs.reduce((s, l) => s + l.price * l.proportion, 0)
        const legCount = result.tradeLegs.filter(l => l.proportion > 0).length
        const totalFees = totalCost * feeRate * legCount
        const netProfit = (result.guaranteedProfit * cfg.tradeSize) - (totalFees * cfg.tradeSize) - cfg.gasEstimateUSD

        if (netProfit <= 0) continue
        if (result.guaranteedProfit * 10_000 < cfg.minProfitBps) continue

        trades.push({
          timestamp: snapshot.timestamp,
          strategy: 'project-fw',
          direction: 'buy-all',
          entryPrice: totalCost,
          exitPrice: 1.0,
          pnl: netProfit,
          feePaid: totalFees * cfg.tradeSize + cfg.gasEstimateUSD,
          holdTimeMs: 0, // Resolution-hold (resolved at market end)
          metadata: {
            marketId,
            slug: snapshot.slug,
            guaranteedProfit: result.guaranteedProfit,
            klDivergence: result.klDivergence,
            fwGap: result.fwGap,
            iterations: result.iterations,
            legs: result.tradeLegs.length,
          },
        })

        lastTradeTime.set(marketId, ts)
      }
    }

    return {
      strategy: 'project-fw',
      strategyName: 'ProjectFW Arb',
      trades,
      summary: computeBacktestSummary(trades),
      dataSource: 'snapshot-recorder',
      config: cfg,
    }
  }
}

export const projectFWBacktestRunner = new ProjectFWBacktestRunner()
