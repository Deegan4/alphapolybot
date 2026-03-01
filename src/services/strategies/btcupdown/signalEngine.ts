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

/** Price snapshot from a correlated asset for cross-asset signal */
export interface CrossAssetSnapshot {
  asset: 'BTC' | 'ETH' | 'SOL' | 'XRP'
  currentPrice: number
  windowOpenPrice: number  // Price at start of the same window
}

export interface SignalInput {
  asset: 'BTC' | 'ETH' | 'SOL' | 'XRP'
  currentPrice: number       // Live asset price from oracle
  windowOpenPrice: number    // "Price to beat" from market question
  upPrice: number            // Current Up outcome price (0-1)
  downPrice: number          // Current Down outcome price (0-1)
  timeIntoWindowMs: number   // Elapsed ms since window start
  windowDurationMs: number   // 15 * 60 * 1000 (or longer for hourly/daily)
  recentPriceHistory: Array<{ price: number; timestamp: number }>
  /** Optional long-term price history for dual-timeframe regime detection */
  recentPriceHistoryLongTerm?: Array<{ price: number; timestamp: number }>
  /** Optional cross-asset snapshots for correlation signal */
  crossAssets?: CrossAssetSnapshot[]
  market: Market
}

export interface SignalFactors {
  momentum: number   // -1 to 1
  velocity: number   // -1 to 1
  timeDecay: number  // 0 to 1
  valueBet: number   // 0 to 1
  orderFlow: number  // -1 to 1
  crossAsset: number // -1 to 1: correlated assets moving same direction boosts signal
  regime: 'choppy' | 'trending' | 'neutral'
  regimeEfficiency: number // 0-1 short-term efficiency ratio
  regimeEfficiencyLongTerm: number // 0-1 long-term efficiency (same as ST if no LT data)
  rsi: number        // 0-100
  volatility: number // stddev of returns
}

export interface Signal {
  direction: 'up' | 'down'
  confidence: number // 0-1
  factors?: SignalFactors
}

export interface SignalEngineConfig {
  regimeFilterEnabled: boolean
  rsiFilterEnabled: boolean
  baselineWindowMs: number    // 900_000 for 15m
  /** Taker fee in basis points — used for fee-aware confidence floor. Default 0 (disabled). */
  feeRateBps?: number
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

  // === Factor 6: CROSS-ASSET CORRELATION ===
  // When other crypto assets move in the same direction, it's more likely a
  // macro move than asset-specific noise. Compute average directional agreement.
  let crossAssetScore = 0
  if (input.crossAssets && input.crossAssets.length > 0) {
    let agreementSum = 0
    let count = 0
    for (const peer of input.crossAssets) {
      if (peer.asset === input.asset) continue // skip self
      const peerDelta = (peer.currentPrice - peer.windowOpenPrice) / peer.windowOpenPrice
      // Agreement: same sign as our direction? Positive = correlated move
      const agreement = direction === 'up' ? peerDelta : -peerDelta
      // Normalize: typical crypto move ~0.5-2% in 15min → scale to [-1, 1]
      agreementSum += Math.tanh(agreement * 100) // 1% move → tanh(1) ≈ 0.76
      count++
    }
    crossAssetScore = count > 0 ? agreementSum / count : 0
  }

  // === COMPOSITE with dynamic weights ===
  // orderFlow only gets weight when imbalanceScore is actually provided (non-zero).
  // Live strategy passes 0 (MicrostructureAnalyzer removed); BacktestRunner passes
  // real orderbook imbalance. When flow=0, its 15% redistributes proportionally.
  const hasCrossData = input.crossAssets && input.crossAssets.length > 0
  const hasFlowData = imbalanceScore !== 0
  const wMomentum = hasCrossData ? (hasFlowData ? 0.22 : 0.27) : (hasFlowData ? 0.25 : 0.30)
  const wVelocity = hasCrossData ? (hasFlowData ? 0.22 : 0.27) : (hasFlowData ? 0.25 : 0.30)
  const wTime     = hasFlowData ? 0.20 : 0.22
  const wValue    = hasFlowData ? 0.15 : 0.18
  const wFlow     = hasFlowData ? 0.15 : 0.00
  const wCross    = hasCrossData ? 0.06 : 0.00

  const rawScore =
    momentumScore * wMomentum +
    velocityScore * wVelocity +
    timeDecayBoost * wTime +
    cheapness * wValue +
    imbalanceScore * wFlow +
    crossAssetScore * wCross

  // Sqrt scaling: stretches [0, 0.5] → [0, 0.7]
  const amplifiedScore = Math.sign(rawScore) * Math.sqrt(Math.abs(rawScore))

  // Noise dampening for shorter windows
  const noiseScale = Math.sqrt(timeScale)
  const noiseDampener = 0.85 + 0.15 * noiseScale
  let confidence = Math.max(0, Math.min(1, Math.abs(amplifiedScore) * noiseDampener))

  // === REGIME SCALING (dual-timeframe graduated) ===
  const { regime, efficiency: regimeEfficiency } = classifyRegimeWithEfficiency(recentPriceHistory)
  let regimeEfficiencyLongTerm = regimeEfficiency // fallback: same as short-term
  if (input.recentPriceHistoryLongTerm && input.recentPriceHistoryLongTerm.length >= 10) {
    regimeEfficiencyLongTerm = classifyRegimeWithEfficiency(input.recentPriceHistoryLongTerm).efficiency
  }
  const blendedEfficiency = input.recentPriceHistoryLongTerm
    ? computeBlendedEfficiency(regimeEfficiency, regimeEfficiencyLongTerm)
    : regimeEfficiency // single-timeframe: identical to before
  if (config.regimeFilterEnabled) {
    confidence *= regimeMultiplier(blendedEfficiency)
  }

  // === RSI FILTER ===
  // Two tiers: hard veto at extreme RSI (>80/<20) prevents trading into obvious
  // mean-reversion setups; graduated 15% fade in the 75-80/20-25 zone.
  const rsi = recentPriceHistory.length >= 20 ? computeRSI(recentPriceHistory, 14) : 50
  if (config.rsiFilterEnabled && recentPriceHistory.length >= 20) {
    if ((rsi > 80 && direction === 'up') || (rsi < 20 && direction === 'down')) {
      confidence = 0  // Hard veto: extreme RSI = mean-reversion territory
    } else if ((rsi > 75 && direction === 'up') || (rsi < 25 && direction === 'down')) {
      confidence *= 0.85
    }
  }

  // === EARLY WINDOW RAMP ===
  const earlyRampMs = 60_000 * timeScale
  if (timeIntoWindowMs < earlyRampMs) {
    const earlyPenalty = 0.85 + 0.15 * (timeIntoWindowMs / earlyRampMs)
    confidence *= earlyPenalty
  }

  // === LATE-WINDOW MOMENTUM AMPLIFIER ===
  // When >60% into the window with strong directional momentum, the remaining
  // time makes reversal less likely. Boost confidence proportional to both
  // time elapsed and momentum strength — max +12% at end of window with
  // perfect momentum alignment.
  if (timeRatio > 0.60 && Math.abs(momentumScore) > 0.3) {
    const lateBoost = (timeRatio - 0.60) / 0.40  // 0→1 over last 40% of window
    const momentumStrength = Math.min(1, Math.abs(momentumScore))
    confidence = Math.min(1, confidence * (1 + 0.12 * lateBoost * momentumStrength))
  }

  // === FEE-AWARE CONFIDENCE FLOOR ===
  // With a 10% fee (1000 bps), we need p > 1/(1+b) where b = (0.90 - price)/price.
  // Signals below this floor are guaranteed negative EV — zero them out so Kelly
  // sizes them at $0 rather than losing money on a structurally unprofitable trade.
  if (config.feeRateBps && config.feeRateBps > 0) {
    const effectivePayout = 1.0 - config.feeRateBps / 10_000
    const breakeven = targetPrice / effectivePayout  // min prob to break even
    if (confidence < breakeven) {
      confidence = 0  // Hard floor — no trade below breakeven
    }
  }

  return {
    direction,
    confidence,
    factors: {
      momentum: momentumScore,
      velocity: velocityScore,
      timeDecay: timeDecayBoost,
      valueBet: cheapness,
      orderFlow: imbalanceScore,
      crossAsset: crossAssetScore,
      regime,
      regimeEfficiency,
      regimeEfficiencyLongTerm,
      rsi,
      volatility: sigma,
    },
  }
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
 * Classify market regime using efficiency ratio, returning both label and raw value.
 * Efficiency = |net displacement| / total path length.
 *   < 0.15 → choppy (mean-reverting)
 *   > 0.40 → trending (directional)
 *   else   → neutral
 */
export function classifyRegimeWithEfficiency(
  prices: Array<{ price: number; timestamp: number }>,
): { regime: 'choppy' | 'trending' | 'neutral'; efficiency: number } {
  if (prices.length < 10) return { regime: 'neutral', efficiency: 0.25 }
  const netDisplacement = Math.abs(prices[prices.length - 1].price - prices[0].price)
  let totalPath = 0
  for (let i = 1; i < prices.length; i++) {
    totalPath += Math.abs(prices[i].price - prices[i - 1].price)
  }
  if (totalPath === 0) return { regime: 'neutral', efficiency: 0.25 }
  const efficiency = netDisplacement / totalPath
  const regime = efficiency < 0.15 ? 'choppy' : efficiency > 0.40 ? 'trending' : 'neutral'
  return { regime, efficiency }
}

/**
 * Backward-compatible wrapper — returns just the regime label.
 */
export function classifyRegime(
  prices: Array<{ price: number; timestamp: number }>,
): 'choppy' | 'trending' | 'neutral' {
  return classifyRegimeWithEfficiency(prices).regime
}

/**
 * Graduated confidence multiplier based on efficiency ratio.
 *
 * Maps efficiency to a continuous multiplier via clamped linear interpolation:
 *   efficiency 0.00 → 0.60  (heavy penalty for pure chop, but not a block)
 *   efficiency 0.15 → 0.85  (old choppy threshold — moderate penalty)
 *   efficiency 0.30 → 1.00  (neutral — no adjustment)
 *   efficiency 0.50 → 1.10  (trending — modest boost)
 *   efficiency 0.70+ → 1.15 (strong trend — capped boost)
 *
 * Key difference from the old binary gate: choppy markets still trade
 * but with reduced confidence, so strong signals can still execute.
 */
export function regimeMultiplier(efficiency: number): number {
  // Piecewise linear: (0, 0.60) → (0.30, 1.00) → (0.70, 1.15)
  if (efficiency <= 0) return 0.60
  if (efficiency <= 0.30) {
    // 0.60 → 1.00 over [0, 0.30]
    return 0.60 + (efficiency / 0.30) * 0.40
  }
  if (efficiency >= 0.70) return 1.15
  // 1.00 → 1.15 over [0.30, 0.70]
  return 1.00 + ((efficiency - 0.30) / 0.40) * 0.15
}

/**
 * Blend short-term and long-term efficiency ratios with scenario awareness.
 *
 * The key insight: a choppy 5-minute window inside a trending macro context
 * is a *pullback entry* — the best risk/reward setup. Single-timeframe
 * regime can't distinguish this from sustained chop.
 *
 * | Short-term | Long-term | Blend              | Rationale                    |
 * |-----------|----------|--------------------|------------------------------|
 * | choppy    | trending | 40% ST + 60% LT    | Pullback in trend — rescue   |
 * | trending  | trending | max(ST, LT)         | Confirmed trend — full boost |
 * | choppy    | choppy   | min(ST, LT)         | Sustained chop — max penalty |
 * | trending  | choppy   | 60% ST + 40% LT    | Breakout attempt — cautious  |
 * | other     | other    | 50/50 average       | Default blend                |
 */
export function computeBlendedEfficiency(
  efficiencyShort: number,
  efficiencyLong: number,
): number {
  const CHOPPY = 0.15
  const TRENDING = 0.40

  const stChoppy = efficiencyShort < CHOPPY
  const stTrending = efficiencyShort > TRENDING
  const ltChoppy = efficiencyLong < CHOPPY
  const ltTrending = efficiencyLong > TRENDING

  // Pullback in trend — the money scenario
  if (stChoppy && ltTrending) {
    return 0.40 * efficiencyShort + 0.60 * efficiencyLong
  }
  // Confirmed trend — take the stronger signal
  if (stTrending && ltTrending) {
    return Math.max(efficiencyShort, efficiencyLong)
  }
  // Sustained chop — maximum penalty
  if (stChoppy && ltChoppy) {
    return Math.min(efficiencyShort, efficiencyLong)
  }
  // Breakout attempt — cautious boost
  if (stTrending && ltChoppy) {
    return 0.60 * efficiencyShort + 0.40 * efficiencyLong
  }
  // Neutral / mixed — simple average
  return (efficiencyShort + efficiencyLong) / 2
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

// ==========================================
// LLM SIGNAL FUSION
// ==========================================

/** Independent LLM directional prediction (no mechanical factors in prompt) */
export interface LLMDirectionSignal {
  direction: 'up' | 'down'
  confidence: number  // 0-1
}

/**
 * Fuse a mechanical signal with an independent LLM directional prediction.
 *
 * - **LLM null** → return mechanical unchanged, `fusionApplied: false`
 * - **Agreement** (same direction): blend of weighted average + geometric mean, capped at 0.95
 * - **Disagreement**: penalty proportional to LLM conviction × weight
 * - **Direction always follows mechanical** (it has structural weight by default)
 *
 * @param mechanical   5-factor mechanical signal
 * @param llm          Independent LLM prediction (null = skip fusion)
 * @param llmWeight    LLM weight in blend (0-1, typically 0.30 = 70% mechanical / 30% LLM)
 */
export function fuseBtcSignals(
  mechanical: Signal,
  llm: LLMDirectionSignal | null,
  llmWeight: number,
): { direction: 'up' | 'down'; confidence: number; fusionApplied: boolean } {
  if (!llm) {
    return { direction: mechanical.direction, confidence: mechanical.confidence, fusionApplied: false }
  }

  const mechWeight = 1 - llmWeight
  const mechConf = mechanical.confidence
  const llmConf = llm.confidence
  const agree = mechanical.direction === llm.direction

  let confidence: number
  if (agree) {
    // Weighted average blended with geometric mean for agreement bonus
    const weightedAvg = mechConf * mechWeight + llmConf * llmWeight
    const geoMean = Math.sqrt(mechConf * llmConf)
    confidence = 0.80 * weightedAvg + 0.20 * geoMean
    confidence = Math.min(0.95, confidence)
  } else {
    // Penalty proportional to LLM conviction and its weight
    confidence = mechConf * (1 - llmConf * llmWeight)
  }

  // Never go negative
  confidence = Math.max(0, confidence)

  return { direction: mechanical.direction, confidence, fusionApplied: true }
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
