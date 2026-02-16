import { describe, it, expect } from 'vitest'
import {
  computeSignal,
  computeVolatility,
  classifyRegime,
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
