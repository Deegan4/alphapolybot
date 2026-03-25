/**
 * StrategyAnalytics — Per-strategy risk-adjusted performance metrics.
 *
 * Bridges TradeLogger (raw data) and EdgeTracker (win rates) to compute
 * advanced portfolio metrics that neither service owns:
 *
 * - Profit factor (gross wins / gross losses)
 * - Expectancy (expected $ per trade after fees)
 * - Sortino ratio (penalizes downside vol only, unlike Sharpe)
 * - Average win/loss breakdown
 * - Best/worst trade
 * - Per-strategy correlation matrix
 *
 * Pure logic, no UI. Reads from singletons, no state of its own.
 */

import { tradeLogger } from './TradeLogger'
import { edgeTracker, type StrategyEdge } from './EdgeTracker'

export interface StrategyMetrics {
  strategyId: string
  totalTrades: number
  openTrades: number

  // Win/loss breakdown
  wins: number
  losses: number
  winRate: number
  avgWinUSD: number
  avgLossUSD: number
  bestTradeUSD: number
  worstTradeUSD: number

  // Risk-adjusted
  profitFactor: number        // gross wins / gross losses (>1 = profitable)
  expectancyUSD: number       // expected $ per trade
  sortinoRatio: number | null // annualized, downside deviation only
  sharpeRatio: number | null  // annualized

  // P&L
  totalPnlUSD: number
  maxDrawdownPercent: number

  // Edge health (from EdgeTracker)
  edge: StrategyEdge
  edgeDecay: {
    isDecaying: boolean
    decayMagnitude: number
  }

  // Timing
  avgHoldTimeMs: number
  medianHoldTimeMs: number
}

export interface PortfolioSummary {
  strategies: StrategyMetrics[]
  correlationMatrix: Record<string, Record<string, number>>
  totalPnlUSD: number
  totalTrades: number
  bestStrategy: string | null
  worstStrategy: string | null
}

const STRATEGY_IDS = ['llm', 'dip', 'fw', 'btc', 'dual-side', 'gabagool', 'impulse', 'liquidation'] as const

export class StrategyAnalytics {
  /**
   * Compute full metrics for a single strategy.
   */
  getStrategyMetrics(strategyId: string): StrategyMetrics {
    const allRecords = tradeLogger.getRecords()
    const stratRecords = allRecords.filter(r => r.strategy === strategyId)
    const closed = stratRecords.filter(r => r.exitTimestamp != null)
    const open = stratRecords.filter(r => r.exitTimestamp == null && r.success)

    const pnls = closed.map(r => r.pnlUSD ?? 0)
    const wins = pnls.filter(p => p > 0)
    const losses = pnls.filter(p => p <= 0)

    const grossWins = wins.reduce((s, p) => s + p, 0)
    const grossLosses = Math.abs(losses.reduce((s, p) => s + p, 0))
    const totalPnl = pnls.reduce((s, p) => s + p, 0)

    // Profit factor: gross wins / gross losses. Infinity if no losses.
    const profitFactor = grossLosses > 0 ? grossWins / grossLosses : (grossWins > 0 ? Infinity : 0)

    // Expectancy: avg win * winRate - avg loss * lossRate
    const winRate = closed.length > 0 ? wins.length / closed.length : 0
    const avgWin = wins.length > 0 ? grossWins / wins.length : 0
    const avgLoss = losses.length > 0 ? grossLosses / losses.length : 0
    const expectancy = closed.length > 0
      ? (avgWin * winRate) - (avgLoss * (1 - winRate))
      : 0

    // Sortino ratio — only penalizes downside deviation
    let sortino: number | null = null
    if (closed.length >= 10) {
      const mean = totalPnl / closed.length
      const downsideSquares = pnls
        .filter(p => p < 0)
        .map(p => p ** 2)
      const downsideVariance = downsideSquares.length > 0
        ? downsideSquares.reduce((s, v) => s + v, 0) / closed.length
        : 0
      const downsideDev = Math.sqrt(downsideVariance)
      if (downsideDev > 0) {
        sortino = (mean / downsideDev) * Math.sqrt(252)
      }
    }

    // Sharpe ratio
    let sharpe: number | null = null
    if (closed.length >= 10) {
      const mean = totalPnl / closed.length
      const variance = pnls.reduce((s, p) => s + (p - mean) ** 2, 0) / closed.length
      const stddev = Math.sqrt(variance)
      if (stddev > 0) {
        sharpe = (mean / stddev) * Math.sqrt(252)
      }
    }

    // Max drawdown
    let maxDrawdown = 0
    let peak = 0
    let cumPnl = 0
    const sorted = [...closed].sort((a, b) => (a.exitTimestamp ?? 0) - (b.exitTimestamp ?? 0))
    for (const r of sorted) {
      cumPnl += r.pnlUSD ?? 0
      if (cumPnl > peak) peak = cumPnl
      const dd = peak > 0 ? (peak - cumPnl) / peak : 0
      if (dd > maxDrawdown) maxDrawdown = dd
    }

    // Hold times
    const holdTimes = closed.map(r => r.holdTimeMs ?? 0).filter(t => t > 0)
    const avgHold = holdTimes.length > 0
      ? holdTimes.reduce((s, t) => s + t, 0) / holdTimes.length
      : 0
    const medianHold = holdTimes.length > 0
      ? holdTimes.sort((a, b) => a - b)[Math.floor(holdTimes.length / 2)]
      : 0

    // Edge data
    const edge = edgeTracker.getStrategyEdge(strategyId)
    const decay = edgeTracker.detectEdgeDecay(strategyId)

    return {
      strategyId,
      totalTrades: closed.length,
      openTrades: open.length,
      wins: wins.length,
      losses: losses.length,
      winRate,
      avgWinUSD: avgWin,
      avgLossUSD: avgLoss,
      bestTradeUSD: pnls.length > 0 ? Math.max(...pnls) : 0,
      worstTradeUSD: pnls.length > 0 ? Math.min(...pnls) : 0,
      profitFactor,
      expectancyUSD: expectancy,
      sortinoRatio: sortino,
      sharpeRatio: sharpe,
      totalPnlUSD: totalPnl,
      maxDrawdownPercent: maxDrawdown,
      edge,
      edgeDecay: {
        isDecaying: decay.isDecaying,
        decayMagnitude: decay.decayMagnitude,
      },
      avgHoldTimeMs: avgHold,
      medianHoldTimeMs: medianHold,
    }
  }

  /**
   * Get metrics for all strategies + portfolio-level summary.
   */
  getPortfolioSummary(): PortfolioSummary {
    const strategies = STRATEGY_IDS
      .map(id => this.getStrategyMetrics(id))
      .filter(m => m.totalTrades > 0 || m.openTrades > 0)

    const totalPnl = strategies.reduce((s, m) => s + m.totalPnlUSD, 0)
    const totalTrades = strategies.reduce((s, m) => s + m.totalTrades, 0)

    // Best/worst by total P&L
    const sorted = [...strategies].sort((a, b) => b.totalPnlUSD - a.totalPnlUSD)
    const bestStrategy = sorted.length > 0 ? sorted[0].strategyId : null
    const worstStrategy = sorted.length > 0 ? sorted[sorted.length - 1].strategyId : null

    // Correlation matrix — Pearson correlation of daily P&L between strategies
    const correlationMatrix = this.computeCorrelationMatrix(strategies.map(s => s.strategyId))

    return {
      strategies,
      correlationMatrix,
      totalPnlUSD: totalPnl,
      totalTrades,
      bestStrategy,
      worstStrategy,
    }
  }

  /**
   * Pearson correlation of daily P&L returns between strategy pairs.
   *
   * High correlation (>0.7) between strategies means they're not providing
   * diversification — both win/lose together (e.g., all trading BTC-derived markets).
   * This informs position sizing: correlated strategies should share risk budget.
   */
  private computeCorrelationMatrix(strategyIds: string[]): Record<string, Record<string, number>> {
    const matrix: Record<string, Record<string, number>> = {}
    const allRecords = tradeLogger.getRecords()

    // Build daily P&L series per strategy
    const dailyPnl = new Map<string, Map<string, number>>()

    for (const id of strategyIds) {
      const pnlByDay = new Map<string, number>()
      const closed = allRecords.filter(r => r.strategy === id && r.exitTimestamp != null)

      for (const r of closed) {
        const day = new Date(r.exitTimestamp!).toISOString().slice(0, 10)
        pnlByDay.set(day, (pnlByDay.get(day) ?? 0) + (r.pnlUSD ?? 0))
      }

      dailyPnl.set(id, pnlByDay)
    }

    // All unique days
    const allDays = new Set<string>()
    for (const pnlByDay of dailyPnl.values()) {
      for (const day of pnlByDay.keys()) allDays.add(day)
    }
    const days = Array.from(allDays).sort()

    for (const a of strategyIds) {
      matrix[a] = {}
      for (const b of strategyIds) {
        if (a === b) {
          matrix[a][b] = 1.0
          continue
        }

        // Get overlapping daily returns
        const seriesA: number[] = []
        const seriesB: number[] = []
        for (const day of days) {
          const valA = dailyPnl.get(a)?.get(day)
          const valB = dailyPnl.get(b)?.get(day)
          if (valA !== undefined && valB !== undefined) {
            seriesA.push(valA)
            seriesB.push(valB)
          }
        }

        matrix[a][b] = seriesA.length >= 5
          ? this.pearsonCorrelation(seriesA, seriesB)
          : 0 // Not enough overlapping data
      }
    }

    return matrix
  }

  private pearsonCorrelation(x: number[], y: number[]): number {
    const n = x.length
    if (n === 0) return 0

    const meanX = x.reduce((s, v) => s + v, 0) / n
    const meanY = y.reduce((s, v) => s + v, 0) / n

    let covXY = 0
    let varX = 0
    let varY = 0

    for (let i = 0; i < n; i++) {
      const dx = x[i] - meanX
      const dy = y[i] - meanY
      covXY += dx * dy
      varX += dx * dx
      varY += dy * dy
    }

    const denom = Math.sqrt(varX * varY)
    return denom > 0 ? covXY / denom : 0
  }
}

// Export singleton
export const strategyAnalytics = new StrategyAnalytics()
