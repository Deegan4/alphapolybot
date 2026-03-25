/**
 * BacktestSummaryEngine — shared summary computation for all strategy backtests.
 *
 * Reuses the same Sharpe/drawdown/profit-factor math from the BTC BacktestRunner
 * but works on the unified UnifiedTradeRecord format.
 */
import type { BacktestSummary, UnifiedTradeRecord } from '@/types'

export function computeBacktestSummary(trades: UnifiedTradeRecord[]): BacktestSummary {
  if (trades.length === 0) {
    return {
      totalTrades: 0, wins: 0, losses: 0, winRate: 0,
      totalPnl: 0, avgPnl: 0, avgHoldTimeMs: 0,
      maxDrawdown: 0, sharpeRatio: null, profitFactor: null,
    }
  }

  const wins = trades.filter(t => t.pnl > 0).length
  const losses = trades.filter(t => t.pnl < 0).length
  const totalPnl = trades.reduce((s, t) => s + t.pnl, 0)
  const avgPnl = totalPnl / trades.length
  const avgHoldTimeMs = trades.reduce((s, t) => s + t.holdTimeMs, 0) / trades.length

  // Max drawdown (cumulative P&L)
  let peak = 0
  let maxDrawdown = 0
  let cumPnl = 0
  for (const t of trades) {
    cumPnl += t.pnl
    if (cumPnl > peak) peak = cumPnl
    const dd = peak - cumPnl
    if (dd > maxDrawdown) maxDrawdown = dd
  }

  // Sharpe ratio (annualized, ~35k trades/year baseline)
  let sharpeRatio: number | null = null
  if (trades.length >= 5) {
    const pnls = trades.map(t => t.pnl)
    const mean = pnls.reduce((s, p) => s + p, 0) / pnls.length
    const variance = pnls.reduce((s, p) => s + (p - mean) ** 2, 0) / pnls.length
    const stdDev = Math.sqrt(variance)
    if (stdDev > 0) {
      sharpeRatio = (mean / stdDev) * Math.sqrt(35_000)
    }
  }

  // Profit factor
  const grossProfit = trades.filter(t => t.pnl > 0).reduce((s, t) => s + t.pnl, 0)
  const grossLoss = Math.abs(trades.filter(t => t.pnl < 0).reduce((s, t) => s + t.pnl, 0))
  const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : null

  return {
    totalTrades: trades.length,
    wins,
    losses,
    winRate: trades.length > 0 ? wins / trades.length : 0,
    totalPnl,
    avgPnl,
    avgHoldTimeMs,
    maxDrawdown,
    sharpeRatio,
    profitFactor,
  }
}

/** Compute Pearson correlation between two P&L series */
export function pearsonCorrelation(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length)
  if (n < 3) return 0

  const meanA = a.slice(0, n).reduce((s, v) => s + v, 0) / n
  const meanB = b.slice(0, n).reduce((s, v) => s + v, 0) / n

  let cov = 0, varA = 0, varB = 0
  for (let i = 0; i < n; i++) {
    const da = a[i] - meanA
    const db = b[i] - meanB
    cov += da * db
    varA += da * da
    varB += db * db
  }

  const denom = Math.sqrt(varA * varB)
  return denom > 0 ? cov / denom : 0
}
