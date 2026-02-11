import type { Market, OrderBookEntry } from '@/types'

// ==========================================
// FRANK-WOLFE OPTIMIZATION TYPES
// ==========================================

/** A vertex of the trade polytope Z_sigma — represents one possible trade bundle */
export interface TradeVertex {
  /** One entry per outcome. 1 = buy this outcome, 0 = don't buy */
  assignments: number[]
  /** The resulting point in probability space for this vertex */
  mu: number[]
}

/** Result from a single FW optimization run */
export interface FWOptimizationResult {
  /** Optimal probability distribution — the "fair prices" */
  mu: number[]
  /** Guaranteed minimum profit: D(mu||theta) - g(mu) */
  guaranteedProfit: number
  /** Frank-Wolfe duality gap at convergence */
  fwGap: number
  /** KL divergence D(mu||theta) measuring price incoherence */
  klDivergence: number
  /** Number of FW iterations to converge */
  iterations: number
  /** Whether the algorithm met a stopping condition */
  converged: boolean
  /** Concrete buy/sell instructions derived from optimal mu */
  tradeLegs: TradeLeg[]
}

/** A concrete trade instruction derived from the optimal mu */
export interface TradeLeg {
  /** Index into the market's outcomes/tokenIds arrays */
  outcomeIndex: number
  /** Always BUY for spread arb (buy all outcomes, merge for profit) */
  side: 'BUY' | 'SELL'
  /** Fraction of the total trade bundle allocated to this leg */
  proportion: number
  /** Expected execution price from order book */
  price: number
}

/** Market state snapshot fed into the optimizer */
export interface MarketSnapshot {
  /** Current mid-prices for each outcome (from order book, not stale Gamma prices) */
  prices: number[]
  /** Outcome labels for display */
  outcomes: string[]
  /** CLOB token IDs for each outcome */
  tokenIds: string[]
  /** Order book depth per outcome (for slippage estimation) */
  depth: Array<{ bids: OrderBookEntry[]; asks: OrderBookEntry[] }>
  /** Whether each outcome is settled (not tradeable) */
  settled: boolean[]
  /** The market's condition ID (for merging) */
  conditionId: string
  /** Whether this is a NegRisk market */
  negRisk: boolean
  /** Original market reference */
  marketId: string
}

/** An arbitrage opportunity found by the scanner */
export interface ArbOpportunity {
  /** The market with incoherent prices */
  market: Market
  /** Snapshot used for optimization */
  snapshot: MarketSnapshot
  /** Optimization result with profit guarantee */
  result: FWOptimizationResult
  /** Net profit after fees and gas (in USD) */
  netProfitUSD: number
}

/** FW optimizer configuration */
export interface FWOptimizerConfig {
  /** Approximation ratio — fraction of optimal profit extracted. (0,1), default 0.5 */
  alpha: number
  /** Convergence threshold for F(mu). default 0.001 */
  epsilonD: number
  /** Initial contraction parameter. default 0.1 */
  epsilon0: number
  /** Maximum FW iterations per solve. default 50 */
  maxIterations: number
}
