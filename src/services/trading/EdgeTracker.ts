/**
 * EdgeTracker — Rolling per-strategy win rate tracker with adaptive probability blending.
 *
 * Reads closed trades from TradeLogger and computes rolling win rates per strategy.
 * Used by strategies to replace hardcoded model probabilities with learned ones,
 * and as a circuit breaker to stop trading strategies with no demonstrable edge.
 *
 * Pure logic, no UI. Singleton.
 */

import { tradeLogger, type TradeRecord } from './TradeLogger'

export interface StrategyEdge {
  winRate: number       // 0-1, based on closed trades
  sampleSize: number    // number of closed trades for this strategy
  isReliable: boolean   // true when sampleSize >= MIN_RELIABLE
  avgPnlUSD: number     // average P&L per closed trade
  totalPnlUSD: number   // cumulative P&L
}

/** Minimum closed trades before we trust a strategy's win rate */
const MIN_RELIABLE = 20

/** At 2x MIN_RELIABLE, learned rate fully dominates base probability */
const FULL_WEIGHT_SAMPLES = MIN_RELIABLE * 2

export class EdgeTracker {
  /**
   * Get edge statistics for a specific strategy.
   * Reads directly from TradeLogger's in-memory records.
   */
  getStrategyEdge(strategy: string): StrategyEdge {
    const closed = this.getClosedTrades(strategy)

    if (closed.length === 0) {
      return { winRate: 0, sampleSize: 0, isReliable: false, avgPnlUSD: 0, totalPnlUSD: 0 }
    }

    const wins = closed.filter(r => (r.pnlUSD ?? 0) > 0).length
    const totalPnl = closed.reduce((sum, r) => sum + (r.pnlUSD ?? 0), 0)

    return {
      winRate: wins / closed.length,
      sampleSize: closed.length,
      isReliable: closed.length >= MIN_RELIABLE,
      avgPnlUSD: totalPnl / closed.length,
      totalPnlUSD: totalPnl,
    }
  }

  /**
   * Blend a base model probability with the learned win rate.
   *
   * When sample size is small (< MIN_RELIABLE), returns baseProb unchanged.
   * As samples grow, learned win rate gradually dominates via sigmoid ramp:
   *   weight = min(1, sampleSize / FULL_WEIGHT_SAMPLES)
   *   result = weight * learnedWinRate + (1 - weight) * baseProb
   *
   * This prevents a 3/3 fluke from overriding a calibrated model,
   * while letting 50+ real trades fully replace the prior.
   */
  getAdaptiveModelProb(strategy: string, baseProb: number): number {
    const edge = this.getStrategyEdge(strategy)

    if (edge.sampleSize === 0) return baseProb

    const weight = Math.min(1, edge.sampleSize / FULL_WEIGHT_SAMPLES)
    return weight * edge.winRate + (1 - weight) * baseProb
  }

  /**
   * Circuit breaker: should this strategy trade at all?
   *
   * Returns false when we have enough data (>= MIN_RELIABLE trades)
   * AND the strategy's win rate implies negative Kelly after fees.
   *
   * Kelly = p - (1-p)/b where p=winRate, b=payoff ratio.
   * For binary markets at ~50c, b≈1, so Kelly ≈ 2*winRate - 1 - fees.
   * Negative Kelly = don't bet.
   *
   * @param feeRateBps Total round-trip fee in basis points (e.g., 200 for 2%)
   */
  shouldTrade(strategy: string, feeRateBps: number): { allowed: boolean; reason?: string } {
    const edge = this.getStrategyEdge(strategy)

    // Not enough data — allow trading (benefit of the doubt)
    if (!edge.isReliable) {
      return { allowed: true }
    }

    const feeRate = feeRateBps / 10000

    // Simplified Kelly check: for binary markets at ~50c (b≈1):
    // Edge after fees = (2 * winRate - 1) - feeRate
    // If negative, the strategy loses money in expectation.
    const edgeAfterFees = (2 * edge.winRate - 1) - feeRate

    if (edgeAfterFees < 0) {
      return {
        allowed: false,
        reason: `[EdgeTracker] ${strategy} blocked: winRate=${(edge.winRate * 100).toFixed(1)}% ` +
          `over ${edge.sampleSize} trades, edge after ${feeRateBps}bps fees = ` +
          `${(edgeAfterFees * 100).toFixed(2)}% (negative Kelly)`,
      }
    }

    return { allowed: true }
  }

  /**
   * Get edge info for all strategies that have any closed trades.
   */
  getAllEdges(): Record<string, StrategyEdge> {
    const result: Record<string, StrategyEdge> = {}
    const allRecords = tradeLogger.getRecords()
    const strategies = new Set(allRecords.filter(r => r.exitTimestamp).map(r => r.strategy))

    for (const strat of strategies) {
      result[strat] = this.getStrategyEdge(strat)
    }

    return result
  }

  /**
   * Detect edge decay — compare recent performance to historical.
   *
   * Splits closed trades into two halves (first half vs second half) and
   * checks if the win rate is declining. A strategy whose edge is fading
   * should be throttled or paused before it starts losing money.
   *
   * @returns decay info with recentWinRate, historicalWinRate, and isDecaying flag
   */
  detectEdgeDecay(strategy: string): {
    isDecaying: boolean
    historicalWinRate: number
    recentWinRate: number
    sampleSize: number
    decayMagnitude: number  // how much win rate dropped (0-1)
  } {
    const closed = this.getClosedTrades(strategy)

    if (closed.length < MIN_RELIABLE * 2) {
      // Not enough data to split — can't detect decay
      return { isDecaying: false, historicalWinRate: 0, recentWinRate: 0, sampleSize: closed.length, decayMagnitude: 0 }
    }

    // Sort by exit timestamp (oldest first)
    const sorted = [...closed].sort((a, b) => (a.exitTimestamp ?? 0) - (b.exitTimestamp ?? 0))
    const midpoint = Math.floor(sorted.length / 2)

    const firstHalf = sorted.slice(0, midpoint)
    const secondHalf = sorted.slice(midpoint)

    const historicalWins = firstHalf.filter(r => (r.pnlUSD ?? 0) > 0).length
    const recentWins = secondHalf.filter(r => (r.pnlUSD ?? 0) > 0).length

    const historicalWinRate = historicalWins / firstHalf.length
    const recentWinRate = recentWins / secondHalf.length

    // Decay detected if recent win rate dropped by >15 percentage points
    const decayMagnitude = historicalWinRate - recentWinRate
    const isDecaying = decayMagnitude > 0.15

    return {
      isDecaying,
      historicalWinRate,
      recentWinRate,
      sampleSize: closed.length,
      decayMagnitude,
    }
  }

  /**
   * Get comprehensive strategy health: edge stats + decay detection.
   */
  getStrategyHealth(strategy: string, feeRateBps: number): {
    edge: StrategyEdge
    shouldTrade: { allowed: boolean; reason?: string }
    decay: ReturnType<EdgeTracker['detectEdgeDecay']>
  } {
    return {
      edge: this.getStrategyEdge(strategy),
      shouldTrade: this.shouldTrade(strategy, feeRateBps),
      decay: this.detectEdgeDecay(strategy),
    }
  }

  private getClosedTrades(strategy: string): TradeRecord[] {
    return tradeLogger
      .getRecords()
      .filter(r => r.strategy === strategy && r.exitTimestamp != null)
  }
}

// Export singleton
export const edgeTracker = new EdgeTracker()
