/**
 * Pure, stateless signal computation functions for BTC Up/Down strategy.
 *
 * Extracted from BtcUpDownStrategy so that both the live strategy and the
 * BacktestRunner can share the same math without pulling in BinanceWS,
 * TradingService, PLM, or any other heavyweight dependency.
 */
import type { Market } from '@/types'

// ==========================================
// TYPES
// ==========================================

export interface SignalInput {
  asset: 'BTC' | 'ETH' | 'SOL' | 'XRP'
  currentPrice: number       // Live asset price from oracle
  windowOpenPrice: number    // "Price to beat" from market question
  upPrice: number            // Current Up outcome price (0-1)
  downPrice: number          // Current Down outcome price (0-1)
  timeIntoWindowMs: number   // Elapsed ms since window start
  windowDurationMs: number   // 15 * 60 * 1000 or longer for 9PM events
  recentPriceHistory: Array<{ price: number; timestamp: number }>
  market: Market
}

export interface Signal {
  direction: 'up' | 'down'
  confidence: number // 0-1
}

export interface SignalEngineConfig {
  regimeFilterEnabled: boolean
  rsiFilterEnabled: boolean
  baselineWindowMs: number    // 900_000 for 15m
}

// ==========================================
// SIGNAL COMPUTATION
// ==========================================

/**
 * 5-factor vol-normalized signal computation.
 *
 * Factors: MOMENTUM (25%), VELOCITY (25%), TIME DECAY (20%),
 *          VALUE BET (15%), ORDER FLOW (15%).
 *
 * @param input     Market snapshot data
 * @param config    Engine config (regime/RSI toggles, baseline window)
 * @param imbalanceScore  Optional order flow imbalance from MicrostructureAnalyzer
 *                        or simplified orderbook computation. Default 0.
 */
export function computeSignal(
  input: SignalInput,
  config: SignalEngineConfig,
  imbalanceScore = 0,
): Signal {
  const {
    currentPrice, windowOpenPrice, upPrice, downPrice,
    timeIntoWindowMs, windowDurationMs, recentPriceHistory,
  } = input

  const timeScale = windowDurationMs / config.baselineWindowMs // 1.0 for 15m

  // === Factor 1: MOMENTUM — vol-normalized z-score ===
  const priceDelta = (currentPrice - windowOpenPrice) / windowOpenPrice
  const sigma = computeVolatility(recentPriceHistory)
  const elapsedS = Math.max(1, timeIntoWindowMs / 1000)
  const windowRemainingS = Math.max(1, (windowDurationMs - timeIntoWindowMs) / 1000)
  const timeNorm = Math.sqrt(Math.min(windowRemainingS, elapsedS))
  let momentumScore: number
  if (sigma > 0) {
    const zScore = priceDelta / (sigma * timeNorm)
    momentumScore = Math.tanh(zScore * 1.5)
  } else {
    momentumScore = Math.max(-1, Math.min(1, priceDelta * 50 / Math.sqrt(timeScale)))
  }

  const direction: 'up' | 'down' = priceDelta >= 0 ? 'up' : 'down'

  // === Factor 2: VELOCITY — linear regression slope ===
  let velocityScore = 0
  if (recentPriceHistory.length >= 3) {
    const slope = linearRegressionSlope(recentPriceHistory)
    const relativeSlope = slope / windowOpenPrice
    const velocityScaler = 30 / Math.sqrt(timeScale)
    velocityScore = Math.max(-1, Math.min(1, relativeSlope * 60_000 * velocityScaler))
  }

  // === Factor 3: TIME DECAY — direction consistency ===
  const timeRatio = Math.max(0, Math.min(1, timeIntoWindowMs / windowDurationMs))
  let directionConsistency = 0
  if (recentPriceHistory.length >= 2) {
    const onSameSide = recentPriceHistory.filter(p =>
      direction === 'up' ? p.price >= windowOpenPrice : p.price < windowOpenPrice,
    ).length
    directionConsistency = onSameSide / recentPriceHistory.length
  }
  const timeDecayBoost = timeRatio * directionConsistency

  // === Factor 4: VALUE BET — cheapness of target outcome ===
  const targetPrice = direction === 'up' ? upPrice : downPrice
  const cheapness = Math.max(0, Math.min(1, 1 - targetPrice))

  // === COMPOSITE with dynamic weights ===
  const wMomentum = 0.25
  const wVelocity = 0.25
  const wTime     = 0.20
  const wValue    = 0.15
  const wFlow     = 0.15

  const rawScore =
    momentumScore * wMomentum +
    velocityScore * wVelocity +
    timeDecayBoost * wTime +
    cheapness * wValue +
    imbalanceScore * wFlow

  // Sqrt scaling: stretches [0, 0.5] → [0, 0.7]
  const amplifiedScore = Math.sign(rawScore) * Math.sqrt(Math.abs(rawScore))

  // Noise dampening for shorter windows
  const noiseScale = Math.sqrt(timeScale)
  const noiseDampener = 0.85 + 0.15 * noiseScale
  let confidence = Math.max(0, Math.min(1, Math.abs(amplifiedScore) * noiseDampener))

  // === REGIME BOOST ===
  if (config.regimeFilterEnabled) {
    const regime = classifyRegime(recentPriceHistory)
    if (regime === 'trending') {
      confidence = Math.min(1, confidence * 1.10)
    }
  }

  // === RSI FILTER ===
  if (config.rsiFilterEnabled && recentPriceHistory.length >= 20) {
    const rsi = computeRSI(recentPriceHistory, 14)
    if ((rsi > 75 && direction === 'up') || (rsi < 25 && direction === 'down')) {
      confidence *= 0.85
    }
  }

  // === EARLY WINDOW RAMP ===
  const earlyRampMs = 60_000 * timeScale
  if (timeIntoWindowMs < earlyRampMs) {
    const earlyPenalty = 0.85 + 0.15 * (timeIntoWindowMs / earlyRampMs)
    confidence *= earlyPenalty
  }

  return { direction, confidence }
}

// ==========================================
// HELPER FUNCTIONS
// ==========================================

/**
 * Compute volatility (stddev of returns) from price history.
 * Returns 0 if insufficient data (< 5 points).
 */
export function computeVolatility(prices: Array<{ price: number; timestamp: number }>): number {
  if (prices.length < 5) return 0
  const returns: number[] = []
  for (let i = 1; i < prices.length; i++) {
    if (prices[i].price > 0 && prices[i - 1].price > 0) {
      returns.push((prices[i].price - prices[i - 1].price) / prices[i - 1].price)
    }
  }
  if (returns.length < 3) return 0
  const mean = returns.reduce((s, r) => s + r, 0) / returns.length
  const variance = returns.reduce((s, r) => s + (r - mean) ** 2, 0) / returns.length
  return Math.sqrt(variance)
}

/**
 * Classify market regime using efficiency ratio.
 * Efficiency = |net displacement| / total path length.
 *   < 0.15 → choppy (mean-reverting, skip trading)
 *   > 0.40 → trending (boost confidence)
 *   else   → neutral
 */
export function classifyRegime(
  prices: Array<{ price: number; timestamp: number }>,
): 'choppy' | 'trending' | 'neutral' {
  if (prices.length < 10) return 'neutral'
  const netDisplacement = Math.abs(prices[prices.length - 1].price - prices[0].price)
  let totalPath = 0
  for (let i = 1; i < prices.length; i++) {
    totalPath += Math.abs(prices[i].price - prices[i - 1].price)
  }
  if (totalPath === 0) return 'neutral'
  const efficiency = netDisplacement / totalPath
  if (efficiency < 0.15) return 'choppy'
  if (efficiency > 0.40) return 'trending'
  return 'neutral'
}

/**
 * Fast RSI computation over price history.
 * Returns 50 (neutral) if insufficient data.
 */
export function computeRSI(
  prices: Array<{ price: number; timestamp: number }>,
  period = 14,
): number {
  if (prices.length < period + 1) return 50
  const recent = prices.slice(-period - 1)
  let gains = 0, losses = 0
  for (let i = 1; i < recent.length; i++) {
    const change = recent[i].price - recent[i - 1].price
    if (change > 0) gains += change
    else losses -= change
  }
  if (losses === 0) return 100
  if (gains === 0) return 0
  const rs = (gains / period) / (losses / period)
  return 100 - 100 / (1 + rs)
}

/**
 * Compute linear regression slope over price history.
 * Returns price change per millisecond.
 */
export function linearRegressionSlope(
  points: Array<{ price: number; timestamp: number }>,
): number {
  const n = points.length
  if (n < 2) return 0

  const t0 = points[0].timestamp
  let sumX = 0, sumY = 0, sumXY = 0, sumXX = 0
  for (const p of points) {
    const x = p.timestamp - t0
    const y = p.price
    sumX += x
    sumY += y
    sumXY += x * y
    sumXX += x * x
  }

  const denom = n * sumXX - sumX * sumX
  if (Math.abs(denom) < 1e-12) return 0
  return (n * sumXY - sumX * sumY) / denom
}

/**
 * Compute simplified order flow imbalance from orderbook snapshot.
 * Returns value in [-1, 1]: positive = more bids (bullish), negative = more asks (bearish).
 * Used by BacktestRunner when replay snapshots include orderbook data.
 */
export function computeOrderbookImbalance(
  orderbook: { bids: Array<{ price: number; size: number }>; asks: Array<{ price: number; size: number }> } | null | undefined,
  topN = 5,
): number {
  if (!orderbook || !orderbook.bids?.length || !orderbook.asks?.length) return 0

  const bidSize = orderbook.bids.slice(0, topN).reduce((sum, l) => sum + l.size, 0)
  const askSize = orderbook.asks.slice(0, topN).reduce((sum, l) => sum + l.size, 0)
  const total = bidSize + askSize
  if (total === 0) return 0
  return (bidSize - askSize) / total
}
