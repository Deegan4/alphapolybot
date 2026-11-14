import { describe, it, expect } from 'vitest'
import {
  DEFAULT_REPLAY_CONFIG, readWindow, tradeFromReadings, summarize, settlePnlPerShare, takerFee,
  type WindowData, type PricePoint, type ReplayReading,
} from '../exchangeBacktest'

const START = 1_700_000_100_000 - (1_700_000_100_000 % 900_000)
const END = START + 900_000

function makeWindow(overrides: Partial<WindowData> = {}): WindowData {
  return {
    slug: 'cpc-btc-updown-15m-test',
    asset: 'BTC',
    startMs: START,
    endMs: END,
    priceToBeat: 50_000,
    upWon: true,
    feeCoefficient: 0.095,
    marketPrices: Array.from({ length: 16 }, (_, i) => ({ timestamp: START + i * 60_000, up: 0.4, down: 0.61 })),
    ...overrides,
  }
}

/** One tick per second from 5 minutes before the window, drifting by `perSecond` */
function makeTicks(startPrice: number, perSecond: number): PricePoint[] {
  const ticks: PricePoint[] = []
  for (let t = START - 300_000, i = 0; t < END; t += 1000, i++) {
    ticks.push({ timestamp: t, price: startPrice + perSecond * i + (i % 2 === 0 ? 0.5 : -0.5) })
  }
  return ticks
}

describe('fees and settlement', () => {
  it('charges Θ·p·(1−p) per share', () => {
    expect(takerFee(0.5, 0.095)).toBeCloseTo(0.02375, 6)
    expect(takerFee(0.1, 0.095)).toBeCloseTo(0.00855, 6)
  })

  it('pays 1 − price on a win and loses the price otherwise, fee either way', () => {
    expect(settlePnlPerShare(0.4, true, 0.095)).toBeCloseTo(0.6 - 0.0228, 6)
    expect(settlePnlPerShare(0.4, false, 0.095)).toBeCloseTo(-0.4 - 0.0228, 6)
  })
})

describe('readWindow', () => {
  it('scans only between the warm-up and the entry cut-off', () => {
    const readings = readWindow(makeWindow(), makeTicks(50_000, 0.1), DEFAULT_REPLAY_CONFIG)
    expect(readings.length).toBeGreaterThan(0)
    expect(readings[0].entryMs).toBe(START + 45_000)
    expect(readings[readings.length - 1].entryMs).toBeLessThanOrEqual(END - 120_000)
  })

  it('reads a rising price as up and marks it right when the window settled up', () => {
    const readings = readWindow(makeWindow({ upWon: true }), makeTicks(50_000, 0.2), DEFAULT_REPLAY_CONFIG)
    const late = readings[readings.length - 1]
    expect(late.direction).toBe('up')
    expect(late.won).toBe(true)
    expect(late.price).toBe(0.4)
  })

  it('uses the Down price and loses when it calls down in an up window', () => {
    const readings = readWindow(makeWindow({ upWon: true }), makeTicks(50_000, -0.2), DEFAULT_REPLAY_CONFIG)
    const late = readings[readings.length - 1]
    expect(late.direction).toBe('down')
    expect(late.won).toBe(false)
    expect(late.price).toBe(0.61)
  })

  it("anchoring to the feed's own window-start price cancels a constant venue gap", () => {
    // Venue trades $80 above the index and falls $30 in the window: truly down.
    const ticks = makeTicks(50_080 + 300 * 0.0, -30 / 900)
    const window = makeWindow({ priceToBeat: 50_000 - 300 * (30 / 900), upWon: false })
    const naive = readWindow(window, ticks, { ...DEFAULT_REPLAY_CONFIG, reference: 'exchange' })
    const anchored = readWindow(window, ticks, { ...DEFAULT_REPLAY_CONFIG, reference: 'venue' })
    expect(naive[naive.length - 1].direction).toBe('up')       // fooled by the gap
    expect(anchored[anchored.length - 1].direction).toBe('down')
    expect(anchored[anchored.length - 1].won).toBe(true)
  })

  it('returns nothing when anchoring is asked for but the feed has no reading near the start', () => {
    const ticks = makeTicks(50_000, 0.1).filter(t => t.timestamp > START + 120_000)
    expect(readWindow(makeWindow(), ticks, { ...DEFAULT_REPLAY_CONFIG, reference: 'venue' })).toEqual([])
  })

  it('skips scans with no usable market price', () => {
    const window = makeWindow({ marketPrices: [{ timestamp: START, up: 0, down: 1 }] })
    expect(readWindow(window, makeTicks(50_000, 0.1), DEFAULT_REPLAY_CONFIG)).toEqual([])
  })
})

describe('tradeFromReadings', () => {
  const reading = (confidence: number, price: number, won = true, entryMs = START + 60_000): ReplayReading =>
    ({ slug: 's', entryMs, direction: 'up', confidence, price, won })

  it('takes the first reading that passes confidence and price limits', () => {
    const trade = tradeFromReadings(
      [reading(0.3, 0.4), reading(0.6, 0.6), reading(0.6, 0.4, true, START + 90_000), reading(0.9, 0.3)],
      makeWindow(), DEFAULT_REPLAY_CONFIG)
    expect(trade?.entryMs).toBe(START + 90_000)
    expect(trade?.pnlPerShare).toBeCloseTo(0.6 - 0.0228, 6)
    expect(trade?.pnlPerDollar).toBeCloseTo((0.6 - 0.0228) / 0.4, 6)
  })

  it('makes no trade when nothing passes', () => {
    expect(tradeFromReadings([reading(0.5, 0.4), reading(0.9, 0.05)], makeWindow(), DEFAULT_REPLAY_CONFIG)).toBeNull()
  })
})

describe('summarize', () => {
  it('reports win rate, break-even and the result of $1 stakes', () => {
    const window = makeWindow()
    const win = tradeFromReadings([{ slug: 's', entryMs: 1, direction: 'up', confidence: 0.6, price: 0.4, won: true }], window, DEFAULT_REPLAY_CONFIG)!
    const loss = tradeFromReadings([{ slug: 's', entryMs: 1, direction: 'up', confidence: 0.6, price: 0.4, won: false }], window, DEFAULT_REPLAY_CONFIG)!
    const s = summarize([win, loss, loss], 10, 0.095)
    expect(s.trades).toBe(3)
    expect(s.winRate).toBeCloseTo(1 / 3, 6)
    expect(s.breakEvenWinRate).toBeCloseTo(0.4 + 0.0228, 6)
    expect(s.pnlPerDollarStaked).toBeCloseTo(win.pnlPerDollar + 2 * loss.pnlPerDollar, 6)
    expect(s.pnlPerDollarStaked).toBeLessThan(0) // 33% wins at 0.40 loses money
  })

  it('handles no trades', () => {
    expect(summarize([], 5, 0.095)).toMatchObject({ windows: 5, trades: 0, roi: 0 })
  })
})
