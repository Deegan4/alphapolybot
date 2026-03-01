import { describe, it, expect } from 'vitest'
import {
  computeSignal,
  computeVolatility,
  classifyRegime,
  classifyRegimeWithEfficiency,
  regimeMultiplier,
  computeBlendedEfficiency,
  computeRSI,
  linearRegressionSlope,
  computeOrderbookImbalance,
} from '../signalEngine'
import type { SignalInput, SignalEngineConfig } from '../signalEngine'
import type { Market } from '@/types'

// ==========================================
// HELPERS
// ==========================================

const stubMarket: Market = {
  id: 'test-market',
  question: 'Will BTC go up or down?',
  conditionId: '0x123',
  slug: 'btc-updown-15m-test',
  outcomes: ['Up', 'Down'],
  outcomePrices: ['0.50', '0.50'],
  clobTokenIds: ['tok-up', 'tok-down'],
  active: true,
  closed: false,
  volume: 10000,
  liquidity: 5000,
} as Market

const defaultConfig: SignalEngineConfig = {
  regimeFilterEnabled: false,
  rsiFilterEnabled: false,
  baselineWindowMs: 15 * 60 * 1000,
}

function makePriceHistory(
  basePrice: number,
  count: number,
  trend: 'up' | 'down' | 'flat' = 'flat',
  startMs = 0,
  intervalMs = 1000,
): Array<{ price: number; timestamp: number }> {
  const history: Array<{ price: number; timestamp: number }> = []
  for (let i = 0; i < count; i++) {
    let price = basePrice
    if (trend === 'up') price += i * 10
    else if (trend === 'down') price -= i * 10
    history.push({ price, timestamp: startMs + i * intervalMs })
  }
  return history
}

function makeInput(overrides?: Partial<SignalInput>): SignalInput {
  return {
    asset: 'BTC',
    currentPrice: 65100,
    windowOpenPrice: 65000,
    upPrice: 0.55,
    downPrice: 0.45,
    timeIntoWindowMs: 120_000,
    windowDurationMs: 15 * 60 * 1000,
    recentPriceHistory: makePriceHistory(65000, 30, 'up'),
    market: stubMarket,
    ...overrides,
  }
}

// ==========================================
// computeSignal
// ==========================================

describe('computeSignal', () => {
  it('returns a direction and confidence', () => {
    const signal = computeSignal(makeInput(), defaultConfig)
    expect(signal).toHaveProperty('direction')
    expect(signal).toHaveProperty('confidence')
    expect(['up', 'down']).toContain(signal.direction)
    expect(signal.confidence).toBeGreaterThanOrEqual(0)
    expect(signal.confidence).toBeLessThanOrEqual(1)
  })

  it('detects upward movement', () => {
    const input = makeInput({
      currentPrice: 65500,
      windowOpenPrice: 65000,
      recentPriceHistory: makePriceHistory(65000, 30, 'up'),
    })
    const signal = computeSignal(input, defaultConfig)
    expect(signal.direction).toBe('up')
  })

  it('detects downward movement', () => {
    const input = makeInput({
      currentPrice: 64500,
      windowOpenPrice: 65000,
      recentPriceHistory: makePriceHistory(65000, 30, 'down'),
    })
    const signal = computeSignal(input, defaultConfig)
    expect(signal.direction).toBe('down')
  })

  it('confidence increases with stronger momentum', () => {
    const weakInput = makeInput({
      currentPrice: 65010,
      windowOpenPrice: 65000,
      recentPriceHistory: makePriceHistory(65000, 30, 'flat'),
    })
    const strongInput = makeInput({
      currentPrice: 66000,
      windowOpenPrice: 65000,
      recentPriceHistory: makePriceHistory(65000, 30, 'up'),
    })
    const weakSignal = computeSignal(weakInput, defaultConfig)
    const strongSignal = computeSignal(strongInput, defaultConfig)
    expect(strongSignal.confidence).toBeGreaterThan(weakSignal.confidence)
  })

  it('applies early window penalty', () => {
    const earlyInput = makeInput({ timeIntoWindowMs: 5_000 })
    const laterInput = makeInput({ timeIntoWindowMs: 120_000 })
    const earlySignal = computeSignal(earlyInput, defaultConfig)
    const laterSignal = computeSignal(laterInput, defaultConfig)
    expect(earlySignal.confidence).toBeLessThan(laterSignal.confidence)
  })

  it('regime filter boosts confidence in trending regime', () => {
    // Strong trending history (all prices move in same direction)
    const prices: Array<{ price: number; timestamp: number }> = []
    for (let i = 0; i < 30; i++) {
      prices.push({ price: 65000 + i * 50, timestamp: i * 1000 })
    }
    const input = makeInput({
      currentPrice: 66450,
      recentPriceHistory: prices,
    })
    const noRegime = computeSignal(input, { ...defaultConfig, regimeFilterEnabled: false })
    const withRegime = computeSignal(input, { ...defaultConfig, regimeFilterEnabled: true })
    expect(withRegime.confidence).toBeGreaterThanOrEqual(noRegime.confidence)
  })

  it('regime filter dampens confidence in choppy regime (graduated, not blocked)', () => {
    // Oscillating prices → choppy regime
    const prices: Array<{ price: number; timestamp: number }> = []
    for (let i = 0; i < 30; i++) {
      prices.push({ price: 65000 + (i % 2 === 0 ? 30 : -30), timestamp: i * 1000 })
    }
    const input = makeInput({
      currentPrice: 65030,
      windowOpenPrice: 65000,
      recentPriceHistory: prices,
    })
    const noRegime = computeSignal(input, { ...defaultConfig, regimeFilterEnabled: false })
    const withRegime = computeSignal(input, { ...defaultConfig, regimeFilterEnabled: true })
    // Graduated: choppy reduces confidence but doesn't zero it
    expect(withRegime.confidence).toBeLessThan(noRegime.confidence)
    expect(withRegime.confidence).toBeGreaterThan(0)
  })

  it('signal includes regimeEfficiency and regimeEfficiencyLongTerm in factors', () => {
    const signal = computeSignal(makeInput(), defaultConfig)
    expect(signal.factors!.regimeEfficiency).toBeGreaterThanOrEqual(0)
    expect(signal.factors!.regimeEfficiency).toBeLessThanOrEqual(1)
    expect(signal.factors!.regimeEfficiencyLongTerm).toBeGreaterThanOrEqual(0)
    expect(signal.factors!.regimeEfficiencyLongTerm).toBeLessThanOrEqual(1)
  })

  it('dual-timeframe: choppy ST + trending LT boosts confidence vs choppy-only', () => {
    // Short-term: oscillating (choppy)
    const choppyPrices: Array<{ price: number; timestamp: number }> = []
    for (let i = 0; i < 30; i++) {
      choppyPrices.push({ price: 65000 + (i % 2 === 0 ? 30 : -30), timestamp: i * 1000 })
    }
    // Long-term: steady uptrend (trending)
    const trendingLT: Array<{ price: number; timestamp: number }> = []
    for (let i = 0; i < 15; i++) {
      trendingLT.push({ price: 64000 + i * 100, timestamp: i * 60_000 })
    }
    const inputSingleTF = makeInput({
      currentPrice: 65030,
      windowOpenPrice: 65000,
      recentPriceHistory: choppyPrices,
    })
    const inputDualTF = makeInput({
      currentPrice: 65030,
      windowOpenPrice: 65000,
      recentPriceHistory: choppyPrices,
      recentPriceHistoryLongTerm: trendingLT,
    })
    const config = { ...defaultConfig, regimeFilterEnabled: true }
    const singleTF = computeSignal(inputSingleTF, config)
    const dualTF = computeSignal(inputDualTF, config)
    // Dual-timeframe should rescue the choppy short-term with trending long-term context
    expect(dualTF.confidence).toBeGreaterThan(singleTF.confidence)
  })

  it('dual-timeframe: without LT data behaves identically to single-timeframe', () => {
    const input = makeInput()
    const config = { ...defaultConfig, regimeFilterEnabled: true }
    const withoutLT = computeSignal(input, config)
    const withUndefinedLT = computeSignal({ ...input, recentPriceHistoryLongTerm: undefined }, config)
    expect(withoutLT.confidence).toBe(withUndefinedLT.confidence)
  })

  it('RSI filter penalizes overbought up signal', () => {
    // 20+ prices all rising to produce RSI > 75
    const prices: Array<{ price: number; timestamp: number }> = []
    for (let i = 0; i < 25; i++) {
      prices.push({ price: 60000 + i * 200, timestamp: i * 1000 })
    }
    const input = makeInput({
      currentPrice: 64800,
      windowOpenPrice: 60000,
      recentPriceHistory: prices,
    })
    const noRSI = computeSignal(input, { ...defaultConfig, rsiFilterEnabled: false })
    const withRSI = computeSignal(input, { ...defaultConfig, rsiFilterEnabled: true })
    expect(withRSI.confidence).toBeLessThanOrEqual(noRSI.confidence)
  })

  it('imbalanceScore affects confidence via flow weight', () => {
    const input = makeInput()
    const noFlow = computeSignal(input, defaultConfig, 0)
    const bullishFlow = computeSignal(input, defaultConfig, 0.8)
    // Bullish flow should push confidence slightly higher for an up signal
    expect(bullishFlow.confidence).not.toEqual(noFlow.confidence)
  })

  it('confidence is clamped to [0, 1]', () => {
    // Extreme inputs to try pushing outside range
    const extreme = makeInput({
      currentPrice: 100000,
      windowOpenPrice: 50000,
      recentPriceHistory: makePriceHistory(50000, 30, 'up'),
    })
    const signal = computeSignal(extreme, defaultConfig, 1.0)
    expect(signal.confidence).toBeGreaterThanOrEqual(0)
    expect(signal.confidence).toBeLessThanOrEqual(1)
  })

  it('works with minimal price history', () => {
    const input = makeInput({
      recentPriceHistory: [
        { price: 65000, timestamp: 0 },
        { price: 65100, timestamp: 1000 },
      ],
    })
    const signal = computeSignal(input, defaultConfig)
    expect(signal.direction).toBe('up')
    expect(signal.confidence).toBeGreaterThanOrEqual(0)
  })
})

// ==========================================
// computeVolatility
// ==========================================

describe('computeVolatility', () => {
  it('returns 0 for fewer than 5 data points', () => {
    const prices = [
      { price: 100, timestamp: 0 },
      { price: 101, timestamp: 1 },
      { price: 102, timestamp: 2 },
    ]
    expect(computeVolatility(prices)).toBe(0)
  })

  it('returns 0 for flat prices', () => {
    const prices = Array.from({ length: 10 }, (_, i) => ({
      price: 100,
      timestamp: i * 1000,
    }))
    expect(computeVolatility(prices)).toBe(0)
  })

  it('returns higher volatility for more volatile series', () => {
    const calm = Array.from({ length: 20 }, (_, i) => ({
      price: 100 + (i % 2 === 0 ? 0.1 : -0.1),
      timestamp: i * 1000,
    }))
    const wild = Array.from({ length: 20 }, (_, i) => ({
      price: 100 + (i % 2 === 0 ? 5 : -5),
      timestamp: i * 1000,
    }))
    expect(computeVolatility(wild)).toBeGreaterThan(computeVolatility(calm))
  })

  it('returns positive number for valid data', () => {
    const prices = Array.from({ length: 10 }, (_, i) => ({
      price: 100 + Math.sin(i) * 2,
      timestamp: i * 1000,
    }))
    expect(computeVolatility(prices)).toBeGreaterThan(0)
  })
})

// ==========================================
// classifyRegime
// ==========================================

describe('classifyRegime', () => {
  it('returns neutral for fewer than 10 points', () => {
    const prices = makePriceHistory(100, 5)
    expect(classifyRegime(prices)).toBe('neutral')
  })

  it('classifies strong trend as trending', () => {
    // Net displacement 900, path = 900 → efficiency = 1.0
    const prices = makePriceHistory(100, 15, 'up')
    expect(classifyRegime(prices)).toBe('trending')
  })

  it('classifies choppy/mean-reverting as choppy', () => {
    // Prices oscillate around a center — large total path, small net displacement
    const prices: Array<{ price: number; timestamp: number }> = []
    for (let i = 0; i < 20; i++) {
      prices.push({ price: 100 + (i % 2 === 0 ? 3 : -3), timestamp: i * 1000 })
    }
    expect(classifyRegime(prices)).toBe('choppy')
  })

  it('classifies flat prices as neutral (zero path)', () => {
    const prices = makePriceHistory(100, 15, 'flat')
    expect(classifyRegime(prices)).toBe('neutral')
  })
})

// ==========================================
// classifyRegimeWithEfficiency
// ==========================================

describe('classifyRegimeWithEfficiency', () => {
  it('returns regime and efficiency together', () => {
    const prices = makePriceHistory(100, 15, 'up')
    const result = classifyRegimeWithEfficiency(prices)
    expect(result).toHaveProperty('regime')
    expect(result).toHaveProperty('efficiency')
    expect(result.regime).toBe('trending')
    expect(result.efficiency).toBeGreaterThan(0.40)
  })

  it('returns default 0.25 efficiency for insufficient data', () => {
    const result = classifyRegimeWithEfficiency(makePriceHistory(100, 5))
    expect(result.regime).toBe('neutral')
    expect(result.efficiency).toBe(0.25)
  })

  it('choppy has low efficiency', () => {
    const prices: Array<{ price: number; timestamp: number }> = []
    for (let i = 0; i < 20; i++) {
      prices.push({ price: 100 + (i % 2 === 0 ? 3 : -3), timestamp: i * 1000 })
    }
    const result = classifyRegimeWithEfficiency(prices)
    expect(result.regime).toBe('choppy')
    expect(result.efficiency).toBeLessThan(0.15)
  })
})

// ==========================================
// regimeMultiplier
// ==========================================

describe('regimeMultiplier', () => {
  it('returns 0.60 for efficiency 0 (extreme chop)', () => {
    expect(regimeMultiplier(0)).toBe(0.60)
  })

  it('returns 1.00 at efficiency 0.30 (neutral)', () => {
    expect(regimeMultiplier(0.30)).toBeCloseTo(1.00, 5)
  })

  it('returns 1.15 for high efficiency (strong trend)', () => {
    expect(regimeMultiplier(0.70)).toBeCloseTo(1.15, 5)
    expect(regimeMultiplier(0.90)).toBeCloseTo(1.15, 5)
  })

  it('is monotonically increasing', () => {
    const points = [0, 0.05, 0.10, 0.15, 0.20, 0.30, 0.40, 0.50, 0.60, 0.70]
    for (let i = 1; i < points.length; i++) {
      expect(regimeMultiplier(points[i])).toBeGreaterThanOrEqual(regimeMultiplier(points[i - 1]))
    }
  })

  it('returns ~0.85 at old choppy threshold (0.15)', () => {
    // At the old binary gate threshold, signals now get 85% confidence instead of 0%
    const mult = regimeMultiplier(0.15)
    expect(mult).toBeGreaterThan(0.75)
    expect(mult).toBeLessThan(0.95)
  })
})

// ==========================================
// computeBlendedEfficiency
// ==========================================

describe('computeBlendedEfficiency', () => {
  it('pullback: choppy ST + trending LT → 40/60 blend (rescues choppy)', () => {
    const result = computeBlendedEfficiency(0.10, 0.60)
    // 0.40 * 0.10 + 0.60 * 0.60 = 0.04 + 0.36 = 0.40
    expect(result).toBeCloseTo(0.40, 2)
    // Must be significantly above short-term alone
    expect(result).toBeGreaterThan(0.10)
  })

  it('confirmed trend: trending ST + trending LT → max of both', () => {
    expect(computeBlendedEfficiency(0.50, 0.60)).toBe(0.60)
    expect(computeBlendedEfficiency(0.70, 0.45)).toBe(0.70)
  })

  it('sustained chop: choppy ST + choppy LT → min of both (max penalty)', () => {
    expect(computeBlendedEfficiency(0.10, 0.12)).toBe(0.10)
    expect(computeBlendedEfficiency(0.05, 0.02)).toBe(0.02)
  })

  it('breakout: trending ST + choppy LT → 60/40 blend (cautious)', () => {
    const result = computeBlendedEfficiency(0.50, 0.12)
    // 0.60 * 0.50 + 0.40 * 0.12 = 0.30 + 0.048 = 0.348
    expect(result).toBeCloseTo(0.348, 2)
  })

  it('neutral/mixed → simple average', () => {
    // Both neutral (between 0.15 and 0.40)
    expect(computeBlendedEfficiency(0.25, 0.35)).toBeCloseTo(0.30, 5)
    // One choppy, one neutral
    expect(computeBlendedEfficiency(0.10, 0.25)).toBeCloseTo(0.175, 5)
  })

  it('pullback blend feeds into regimeMultiplier above neutral', () => {
    // Choppy ST alone would get multiplier ~0.73
    const choppyMult = regimeMultiplier(0.10)
    // Pullback blend (choppy ST + trending LT) rescues to ~0.40 efficiency
    const blended = computeBlendedEfficiency(0.10, 0.60)
    const blendedMult = regimeMultiplier(blended)
    expect(blendedMult).toBeGreaterThan(choppyMult)
    // Blended should be near or above 1.0 (neutral+)
    expect(blendedMult).toBeGreaterThanOrEqual(0.95)
  })
})

// ==========================================
// computeRSI
// ==========================================

describe('computeRSI', () => {
  it('returns 50 for insufficient data', () => {
    const prices = makePriceHistory(100, 5)
    expect(computeRSI(prices)).toBe(50)
  })

  it('returns 100 for all-gains series', () => {
    const prices = Array.from({ length: 20 }, (_, i) => ({
      price: 100 + i,
      timestamp: i * 1000,
    }))
    expect(computeRSI(prices)).toBe(100)
  })

  it('returns 0 for all-losses series', () => {
    const prices = Array.from({ length: 20 }, (_, i) => ({
      price: 200 - i,
      timestamp: i * 1000,
    }))
    expect(computeRSI(prices)).toBe(0)
  })

  it('returns value between 0 and 100 for mixed series', () => {
    const prices = Array.from({ length: 20 }, (_, i) => ({
      price: 100 + Math.sin(i) * 5,
      timestamp: i * 1000,
    }))
    const rsi = computeRSI(prices)
    expect(rsi).toBeGreaterThan(0)
    expect(rsi).toBeLessThan(100)
  })
})

// ==========================================
// linearRegressionSlope
// ==========================================

describe('linearRegressionSlope', () => {
  it('returns 0 for single point', () => {
    expect(linearRegressionSlope([{ price: 100, timestamp: 0 }])).toBe(0)
  })

  it('returns positive slope for rising prices', () => {
    const points = [
      { price: 100, timestamp: 0 },
      { price: 110, timestamp: 1000 },
      { price: 120, timestamp: 2000 },
    ]
    expect(linearRegressionSlope(points)).toBeGreaterThan(0)
  })

  it('returns negative slope for falling prices', () => {
    const points = [
      { price: 120, timestamp: 0 },
      { price: 110, timestamp: 1000 },
      { price: 100, timestamp: 2000 },
    ]
    expect(linearRegressionSlope(points)).toBeLessThan(0)
  })

  it('returns ~0 for flat prices', () => {
    const points = [
      { price: 100, timestamp: 0 },
      { price: 100, timestamp: 1000 },
      { price: 100, timestamp: 2000 },
    ]
    expect(Math.abs(linearRegressionSlope(points))).toBeLessThan(1e-10)
  })

  it('slope is in price-per-ms', () => {
    // +10 per 1000ms → slope should be 0.01 per ms
    const points = [
      { price: 100, timestamp: 0 },
      { price: 110, timestamp: 1000 },
    ]
    expect(linearRegressionSlope(points)).toBeCloseTo(0.01, 4)
  })
})

// ==========================================
// computeOrderbookImbalance
// ==========================================

describe('computeOrderbookImbalance', () => {
  it('returns 0 for null orderbook', () => {
    expect(computeOrderbookImbalance(null)).toBe(0)
    expect(computeOrderbookImbalance(undefined)).toBe(0)
  })

  it('returns 0 for empty orderbook', () => {
    expect(computeOrderbookImbalance({ bids: [], asks: [] })).toBe(0)
  })

  it('returns positive for bid-heavy orderbook', () => {
    const orderbook = {
      bids: [{ price: 0.55, size: 100 }, { price: 0.54, size: 80 }],
      asks: [{ price: 0.56, size: 20 }, { price: 0.57, size: 10 }],
    }
    const imbalance = computeOrderbookImbalance(orderbook)
    expect(imbalance).toBeGreaterThan(0)
    expect(imbalance).toBeLessThanOrEqual(1)
  })

  it('returns negative for ask-heavy orderbook', () => {
    const orderbook = {
      bids: [{ price: 0.55, size: 10 }],
      asks: [{ price: 0.56, size: 100 }, { price: 0.57, size: 80 }],
    }
    const imbalance = computeOrderbookImbalance(orderbook)
    expect(imbalance).toBeLessThan(0)
    expect(imbalance).toBeGreaterThanOrEqual(-1)
  })

  it('returns 0 for balanced orderbook', () => {
    const orderbook = {
      bids: [{ price: 0.55, size: 50 }],
      asks: [{ price: 0.56, size: 50 }],
    }
    expect(computeOrderbookImbalance(orderbook)).toBe(0)
  })

  it('respects topN parameter', () => {
    const orderbook = {
      bids: [
        { price: 0.55, size: 100 },
        { price: 0.54, size: 200 },
        { price: 0.53, size: 300 },
      ],
      asks: [
        { price: 0.56, size: 50 },
        { price: 0.57, size: 50 },
        { price: 0.58, size: 50 },
      ],
    }
    const topAll = computeOrderbookImbalance(orderbook, 3)
    const top1 = computeOrderbookImbalance(orderbook, 1)
    // Top 1: bids 100, asks 50 → 50/150 = 0.333
    // Top 3: bids 600, asks 150 → 450/750 = 0.60
    expect(topAll).toBeGreaterThan(top1)
  })
})

// ==========================================
// RSI hard veto (two-tier filter)
// ==========================================

describe('RSI two-tier filter', () => {
  it('hard vetoes when RSI > 80 and direction is up (confidence = 0)', () => {
    // 25 monotonically rising prices → RSI = 100 (all gains, zero losses)
    const prices: Array<{ price: number; timestamp: number }> = []
    for (let i = 0; i < 25; i++) {
      prices.push({ price: 60000 + i * 200, timestamp: i * 1000 })
    }
    const input = makeInput({
      currentPrice: 64800,
      windowOpenPrice: 60000,
      recentPriceHistory: prices,
    })
    const signal = computeSignal(input, { ...defaultConfig, rsiFilterEnabled: true })
    expect(signal.direction).toBe('up')
    expect(signal.confidence).toBe(0)
  })

  it('hard vetoes when RSI < 20 and direction is down (confidence = 0)', () => {
    // 25 monotonically falling prices → RSI = 0 (all losses, zero gains)
    const prices: Array<{ price: number; timestamp: number }> = []
    for (let i = 0; i < 25; i++) {
      prices.push({ price: 70000 - i * 200, timestamp: i * 1000 })
    }
    const input = makeInput({
      currentPrice: 65200,
      windowOpenPrice: 70000,
      recentPriceHistory: prices,
    })
    const signal = computeSignal(input, { ...defaultConfig, rsiFilterEnabled: true })
    expect(signal.direction).toBe('down')
    expect(signal.confidence).toBe(0)
  })

  it('graduated fade in 75-80 zone (confidence reduced but not zero)', () => {
    // Need 20+ entries where RSI lands in [75, 80].
    // Strategy: 6 flat prices then 15 points with 10 up +50, 4 down -40 → RSI ~75.8
    const prices: Array<{ price: number; timestamp: number }> = []
    // 6 flat entries to get above the 20-entry minimum
    for (let i = 0; i < 6; i++) {
      prices.push({ price: 65000, timestamp: i * 1000 })
    }
    // 15 more points with deltas targeting RSI ~76 (10 ups, 4 downs over 14 deltas)
    let p = 65000
    const deltas = [50, 50, -40, 50, 50, -40, 50, 50, -40, 50, 50, -40, 50, 50]
    for (let i = 0; i < deltas.length; i++) {
      p += deltas[i]
      prices.push({ price: p, timestamp: (6 + i + 1) * 1000 })
    }

    // Verify our RSI is in the 75-80 zone (computeRSI uses last 15 entries)
    const rsi = computeRSI(prices, 14)
    expect(rsi).toBeGreaterThanOrEqual(75)
    expect(rsi).toBeLessThanOrEqual(80)

    // Need current price above window open for 'up' direction
    const input = makeInput({
      currentPrice: p,
      windowOpenPrice: 65000,
      recentPriceHistory: prices,
    })
    const withRSI = computeSignal(input, { ...defaultConfig, rsiFilterEnabled: true })
    const noRSI = computeSignal(input, { ...defaultConfig, rsiFilterEnabled: false })
    // Should be faded (< noRSI) but NOT zero
    expect(withRSI.confidence).toBeLessThan(noRSI.confidence)
    expect(withRSI.confidence).toBeGreaterThan(0)
  })
})
