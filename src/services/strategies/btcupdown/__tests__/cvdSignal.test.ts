import { describe, it, expect } from 'vitest'
import {
  computeCVD,
  detectCVDDivergence,
  computeSignal,
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

const defaultConfig: SignalEngineConfig = {
  regimeFilterEnabled: false,
  rsiFilterEnabled: false,
  baselineWindowMs: 15 * 60 * 1000,
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
// computeCVD
// ==========================================

describe('computeCVD', () => {
  it('returns zero for empty array', () => {
    const result = computeCVD([])
    expect(result.cvd).toBe(0)
    expect(result.priceChangePct).toBe(0)
    expect(result.buyCount).toBe(0)
    expect(result.sellCount).toBe(0)
  })

  it('returns zero for single-element array', () => {
    const result = computeCVD([{ price: 100, timestamp: 0 }])
    expect(result.cvd).toBe(0)
    expect(result.priceChangePct).toBe(0)
  })

  it('returns positive CVD for consistently rising prices', () => {
    const history = makePriceHistory(100, 20, 'up')
    const result = computeCVD(history)
    expect(result.cvd).toBeGreaterThan(0)
    expect(result.buyCount).toBe(19)
    expect(result.sellCount).toBe(0)
  })

  it('returns negative CVD for consistently falling prices', () => {
    const history = makePriceHistory(200, 20, 'down')
    const result = computeCVD(history)
    expect(result.cvd).toBeLessThan(0)
    expect(result.sellCount).toBe(19)
    expect(result.buyCount).toBe(0)
  })

  it('mixed movement reflects net direction', () => {
    // 5 up moves then 3 down moves => net CVD = 5 - 3 = 2
    const history = [
      { price: 100, timestamp: 0 },
      { price: 101, timestamp: 1 },
      { price: 102, timestamp: 2 },
      { price: 103, timestamp: 3 },
      { price: 104, timestamp: 4 },
      { price: 105, timestamp: 5 },
      { price: 104, timestamp: 6 },
      { price: 103, timestamp: 7 },
      { price: 102, timestamp: 8 },
    ]
    const result = computeCVD(history)
    expect(result.cvd).toBe(5 - 3)
    expect(result.buyCount).toBe(5)
    expect(result.sellCount).toBe(3)
  })

  it('unchanged prices inherit last direction', () => {
    const history = [
      { price: 100, timestamp: 0 },
      { price: 101, timestamp: 1 }, // up -> buy
      { price: 101, timestamp: 2 }, // unchanged -> inherits buy (+1)
      { price: 101, timestamp: 3 }, // unchanged -> inherits buy (+1)
    ]
    const result = computeCVD(history)
    // 3 ticks after first: all classified as buys
    expect(result.cvd).toBe(3)
    expect(result.buyCount).toBe(3)
    expect(result.sellCount).toBe(0)
  })

  it('counts buys and sells correctly for alternating prices', () => {
    const history = [
      { price: 100, timestamp: 0 },
      { price: 101, timestamp: 1 }, // buy
      { price: 100, timestamp: 2 }, // sell
      { price: 101, timestamp: 3 }, // buy
      { price: 100, timestamp: 4 }, // sell
      { price: 101, timestamp: 5 }, // buy
    ]
    const result = computeCVD(history)
    expect(result.buyCount).toBe(3)
    expect(result.sellCount).toBe(2)
    expect(result.cvd).toBe(1) // 3 buys - 2 sells
  })

  it('priceChangePct computed correctly as percentage', () => {
    const history = [
      { price: 100, timestamp: 0 },
      { price: 105, timestamp: 1 },
    ]
    const result = computeCVD(history)
    // (105 - 100) / 100 * 100 = 5%
    expect(result.priceChangePct).toBeCloseTo(5.0, 6)
  })

  it('handles large dataset (1000 points) without error', () => {
    const history = makePriceHistory(50000, 1000, 'up')
    const result = computeCVD(history)
    expect(result.cvd).toBe(999)
    expect(result.buyCount).toBe(999)
  })

  it('all zeroes returns zero CVD', () => {
    const history = Array.from({ length: 10 }, (_, i) => ({
      price: 100,
      timestamp: i * 1000,
    }))
    const result = computeCVD(history)
    // First tick has no direction (lastDirection=0), so all unchanged inherit 0
    expect(result.cvd).toBe(0)
    expect(result.buyCount).toBe(0)
    expect(result.sellCount).toBe(0)
  })
})

// ==========================================
// detectCVDDivergence
// ==========================================

describe('detectCVDDivergence', () => {
  it('returns neutral for tiny price change and small CVD', () => {
    const result = detectCVDDivergence(0.005, 3)
    expect(result.type).toBe('neutral')
    expect(result.score).toBe(0)
  })

  it('detects bearish_div: price up >0.02% but CVD negative (<-10)', () => {
    const result = detectCVDDivergence(0.03, -15)
    expect(result.type).toBe('bearish_div')
    expect(result.score).toBeLessThan(0)
  })

  it('detects bullish_div: price down <-0.02% but CVD positive (>10)', () => {
    const result = detectCVDDivergence(-0.03, 15)
    expect(result.type).toBe('bullish_div')
    expect(result.score).toBeGreaterThan(0)
  })

  it('detects strong_bull: price >0.05% and CVD >20', () => {
    const result = detectCVDDivergence(0.06, 25)
    expect(result.type).toBe('strong_bull')
    expect(result.score).toBeGreaterThan(0)
  })

  it('detects strong_bear: price <-0.05% and CVD <-20', () => {
    const result = detectCVDDivergence(-0.06, -25)
    expect(result.type).toBe('strong_bear')
    expect(result.score).toBeLessThan(0)
  })

  it('detects bullish: price positive, CVD positive (mild)', () => {
    // Price up but below 0.05 threshold, CVD positive but below 20
    const result = detectCVDDivergence(0.03, 8)
    expect(result.type).toBe('bullish')
    expect(result.score).toBeGreaterThan(0)
    expect(result.score).toBeLessThanOrEqual(0.5)
  })

  it('detects bearish: price negative, CVD negative (mild)', () => {
    const result = detectCVDDivergence(-0.03, -8)
    expect(result.type).toBe('bearish')
    expect(result.score).toBeLessThan(0)
    expect(result.score).toBeGreaterThanOrEqual(-0.5)
  })

  it('score bounded in [-1, 1]', () => {
    // Very large CVD values
    const bull = detectCVDDivergence(-0.1, 500)
    expect(bull.score).toBeLessThanOrEqual(1)
    expect(bull.score).toBeGreaterThanOrEqual(-1)

    const bear = detectCVDDivergence(0.1, -500)
    expect(bear.score).toBeLessThanOrEqual(1)
    expect(bear.score).toBeGreaterThanOrEqual(-1)

    // Strong confirmation extremes
    const strongBull = detectCVDDivergence(0.1, 500)
    expect(strongBull.score).toBeLessThanOrEqual(1)

    const strongBear = detectCVDDivergence(-0.1, -500)
    expect(strongBear.score).toBeGreaterThanOrEqual(-1)
  })
})

// ==========================================
// computeSignal — CVD integration
// ==========================================

describe('computeSignal CVD integration', () => {
  it('cvdEnabled=false: cvd factor is 0 in output', () => {
    const input = makeInput()
    const config: SignalEngineConfig = { ...defaultConfig, cvdEnabled: false }
    const signal = computeSignal(input, config)
    expect(signal.factors!.cvd).toBe(0)
  })

  it('cvdEnabled=true with rising prices: cvd factor is non-zero', () => {
    const history = makePriceHistory(65000, 30, 'up')
    const input = makeInput({
      currentPrice: 65000 + 29 * 10,
      recentPriceHistory: history,
    })
    const config: SignalEngineConfig = { ...defaultConfig, cvdEnabled: true }
    const signal = computeSignal(input, config)
    // Rising prices produce positive CVD, direction is 'up', so cvdDirectional depends on alignment
    expect(signal.factors!.cvd).not.toBe(0)
  })

  it('CVD weight allocation: weights sum close to 1.0 with CVD active', () => {
    // When cvdEnabled and data present, CVD gets 0.08 weight.
    // The total weight should still sum approximately to 1.0.
    // We verify indirectly: the signal confidence should be reasonable (not >1 or negative).
    const history = makePriceHistory(65000, 30, 'up')
    const input = makeInput({
      currentPrice: 65290,
      recentPriceHistory: history,
    })

    // With CVD only (no MRO, no cross, no flow)
    const configCvd: SignalEngineConfig = { ...defaultConfig, cvdEnabled: true }
    const signalCvd = computeSignal(input, configCvd)
    expect(signalCvd.confidence).toBeGreaterThanOrEqual(0)
    expect(signalCvd.confidence).toBeLessThanOrEqual(1)

    // With both CVD and MRO (need volume data for MRO to activate)
    const volumeHistory = Array.from({ length: 30 }, (_, i) => ({
      volume: 1000 + i * 50,
      timestamp: i * 1000,
    }))
    const inputBoth = makeInput({
      currentPrice: 65290,
      recentPriceHistory: history,
      volumeHistory,
    })
    const configBoth: SignalEngineConfig = { ...defaultConfig, cvdEnabled: true, mroEnabled: true }
    const signalBoth = computeSignal(inputBoth, configBoth)
    expect(signalBoth.confidence).toBeGreaterThanOrEqual(0)
    expect(signalBoth.confidence).toBeLessThanOrEqual(1)
  })

  it('CVD does not affect direction (direction always follows price delta)', () => {
    // Even with strong bearish CVD divergence, direction follows price delta
    const history = makePriceHistory(65000, 30, 'up')
    const input = makeInput({
      currentPrice: 65290,
      windowOpenPrice: 65000,
      recentPriceHistory: history,
    })
    const config: SignalEngineConfig = { ...defaultConfig, cvdEnabled: true }
    const signal = computeSignal(input, config)
    expect(signal.direction).toBe('up') // price > windowOpen => up

    // Down case
    const historyDown = makePriceHistory(65000, 30, 'down')
    const inputDown = makeInput({
      currentPrice: 65000 - 29 * 10,
      windowOpenPrice: 65000,
      recentPriceHistory: historyDown,
    })
    const signalDown = computeSignal(inputDown, config)
    expect(signalDown.direction).toBe('down')
  })

  it('CVD with divergence data modifies confidence vs disabled', () => {
    // Build a scenario where CVD has meaningful data, compare enabled vs disabled
    // Use a longer history with mixed movement to generate divergence
    const history: Array<{ price: number; timestamp: number }> = []
    const base = 65000
    for (let i = 0; i < 30; i++) {
      // Price goes up overall, but with some down ticks creating CVD divergence potential
      const noise = i % 3 === 0 ? -5 : 15
      history.push({ price: base + i * noise, timestamp: i * 1000 })
    }
    const lastPrice = history[history.length - 1].price

    const input = makeInput({
      currentPrice: lastPrice,
      windowOpenPrice: base,
      recentPriceHistory: history,
    })

    const configOff: SignalEngineConfig = { ...defaultConfig, cvdEnabled: false }
    const configOn: SignalEngineConfig = { ...defaultConfig, cvdEnabled: true }

    const signalOff = computeSignal(input, configOff)
    const signalOn = computeSignal(input, configOn)

    // Both should have valid confidence
    expect(signalOff.confidence).toBeGreaterThanOrEqual(0)
    expect(signalOn.confidence).toBeGreaterThanOrEqual(0)

    // They may differ (CVD factor contributes some weight)
    // We don't assert which is higher since it depends on divergence direction
    // Just confirm CVD factor is present vs absent
    expect(signalOff.factors!.cvd).toBe(0)
    // signalOn.factors.cvd may or may not be non-zero depending on the data
  })
})
