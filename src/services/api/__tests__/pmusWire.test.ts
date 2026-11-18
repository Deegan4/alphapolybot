import { describe, it, expect } from 'vitest'
import live from './fixtures/pmus-live.json'
import {
  unwrapMarketData,
  normalizeEventToMarkets,
  normalizeWireMarket,
  statsFromBbo,
  priceDataFromBbo,
  orderBookFromWire,
  priceForOutcome,
  bookForOutcome,
  upDownEventSlugs,
  reportedPriceForOutcome,
  type WireEvent,
  type WireBBO,
  type WireBook,
  type WireMarket,
} from '../pmusWire'
import type { PriceData } from '@/types/api'

const ev = (x: unknown) => x as WireEvent

describe('unwrapMarketData', () => {
  it('unwraps the live { marketData } envelope and passes bare objects through', () => {
    const bbo = unwrapMarketData<WireBBO>(live.bboOpen)
    expect(bbo.marketSlug).toBe('tec-mls-winner-2026-11-07-nas')
    expect(unwrapMarketData<WireBBO>(bbo)).toBe(bbo)
  })
})

describe('normalizeEventToMarkets (live fixtures)', () => {
  it('turns a multi-market event into one binary market per tradeable slug', () => {
    const markets = normalizeEventToMarkets(ev(live.eventMultiMarket))
    expect(markets).toHaveLength(2)
    const [nas, mia] = markets
    expect(nas.slug).toBe('tec-mls-winner-2026-11-07-nas')
    expect(nas.eventSlug).toBe('mls-winner-2026-11-07')
    expect(nas.question).toBe('Major League Soccer Champion: Nashville SC')
    expect(nas.outcomes).toEqual(['Yes', 'No'])
    expect(nas.outcomeSlugs).toEqual([nas.slug, nas.slug])
    // bid 0.274 / ask 0.34 → mid 0.307
    expect(nas.bestBid).toBe(0.274)
    expect(nas.bestAsk).toBe(0.34)
    expect(nas.outcomePrices).toEqual([0.307, 0.693])
    expect(nas.spread).toBe(0.066)
    expect(nas.orderPriceMinTickSize).toBe(0.001)
    expect(nas.orderMinSize).toBe(1)
    expect(nas.feeCoefficient).toBe(0.095)
    expect(mia.slug).toBe('tec-mls-winner-2026-11-07-mia')
    expect(mia.id).not.toBe(nas.id)
  })

  it('ignores the unreliable outcomes/outcomePrices strings on the wire', () => {
    const raw = (live.eventMultiMarket.markets[0] as unknown as { outcomes: string }).outcomes
    expect(raw).toBe('["No","Yes"]') // labels reversed vs. prices — must not be trusted
    expect(normalizeEventToMarkets(ev(live.eventMultiMarket))[0].outcomes).toEqual(['Yes', 'No'])
  })

  it('maps crypto Up/Down to Up/Down outcomes with the window end and price to beat', () => {
    const [m] = normalizeEventToMarkets(ev(live.eventUpDown))
    expect(m.slug).toBe('cpc-btc-updown-15m-2026-11-08-0130z')
    expect(m.outcomes).toEqual(['Up', 'Down'])
    expect(m.windowStart).toBe('2026-11-08T01:30:00Z')
    expect(m.windowEnd).toBe('2026-11-08T01:45:00Z')
    // endDate is the window end, not the settlement time 30 min later
    expect(m.endDate).toBe('2026-11-08T01:45:00Z')
    expect(m.priceToBeat).toBeCloseTo(75672.03, 2)
    expect(m.question).toContain('BTC Up or Down 15m')
  })

  it('keeps nested (non-exclusive) markets separate — they are not YES/NO halves', () => {
    const markets = normalizeEventToMarkets(ev(live.eventNested))
    expect(markets.map(m => m.slug)).toEqual(['cpc-btc-150k-11-30-2026', 'cpc-btc-150k-12-31-2026'])
    for (const m of markets) expect(m.outcomes).toEqual(['Yes', 'No'])
  })

  it('reports zero prices for an unquoted market and honors optional volume/liquidity', () => {
    const m = normalizeWireMarket({ id: 1, slug: 's', title: 'T', active: true, closed: false, volume: 5, liquidity: 7 } as WireMarket)
    expect(m.outcomePrices).toEqual([0, 0])
    expect(m.volume).toBe(5)
    expect(m.liquidity).toBe(7)
    expect(m.question).toBe('T')
  })
})

describe('BBO and book', () => {
  it('derives USD volume / liquidity proxies from an open BBO', () => {
    const { volume, liquidity } = statsFromBbo(unwrapMarketData<WireBBO>(live.bboOpen))
    // 1,719,969 shares × mid 0.307; 36,241 OI × 0.307
    expect(volume).toBe(Math.round(1719969 * 0.307))
    expect(liquidity).toBe(Math.round(36241 * 0.307))
  })

  it('handles an expired market with no quotes', () => {
    const bbo = unwrapMarketData<WireBBO>(live.bboExpired)
    expect(bbo.state).toBe('MARKET_STATE_EXPIRED')
    const pd = priceDataFromBbo(bbo)
    expect(pd.bid).toBe(0)
    expect(pd.ask).toBe(0)
    expect(pd.last).toBe(0.01)
    expect(statsFromBbo(bbo).liquidity).toBe(0)
  })

  it('parses the live book (bids best-first, offers best-first)', () => {
    const book = orderBookFromWire(unwrapMarketData<WireBook>(live.book))
    expect(book.marketSlug).toBe('tec-mls-winner-2026-11-07-nas')
    expect(book.bids[0]).toEqual({ price: 0.274, size: 6 })
    expect(book.asks[0].price).toBe(0.34)
    expect(book.bids.length).toBe(4)
  })
})

describe('outcome-aware views of the YES book', () => {
  const pd: PriceData = { bid: 0.274, ask: 0.34, last: 0.255, mid: 0.307, spread: 0.066, timestamp: new Date(0) }

  it('YES passes through; NO swaps and inverts bid/ask', () => {
    expect(priceForOutcome(pd, 'yes')).toBe(pd)
    const no = priceForOutcome(pd, 'no')
    expect(no.bid).toBe(0.66)
    expect(no.ask).toBe(0.726)
    expect(no.mid).toBe(0.693)
    expect(no.last).toBe(0.745)
    expect(no.spread).toBe(pd.spread)
  })

  it('NO book: asks are the inverted YES bids, still best-first', () => {
    const book = orderBookFromWire(unwrapMarketData<WireBook>(live.book))
    const no = bookForOutcome(book, 'no')
    expect(no.asks[0].price).toBe(0.726) // 1 - best YES bid 0.274
    expect(no.asks[0].size).toBe(6)
    expect(no.asks[1].price).toBeGreaterThan(no.asks[0].price)
    expect(no.bids[0].price).toBe(0.66) // 1 - best YES ask 0.34
    expect(bookForOutcome(book, 'yes')).toBe(book)
  })

  it('reportedPriceForOutcome converts YES-side fills for NO orders', () => {
    expect(reportedPriceForOutcome(0.34, 'yes', 0.35)).toBe(0.34)
    expect(reportedPriceForOutcome(0.34, 'no', 0.67)).toBe(0.66) // reported YES-side
    expect(reportedPriceForOutcome(0.66, 'no', 0.67)).toBe(0.66) // already NO-side
    expect(reportedPriceForOutcome(0, 'no', 0.5)).toBe(0)
  })
})

describe('upDownEventSlugs', () => {
  const at = (iso: string) => new Date(iso)

  it('matches the live slug format for intraday windows (current + next)', () => {
    expect(upDownEventSlugs('BTC', '15m', at('2026-11-08T01:41:10Z'))).toEqual([
      'btc-updown-15m-2026-11-08-0130z',
      'btc-updown-15m-2026-11-08-0145z',
    ])
    expect(upDownEventSlugs('eth', '5m', at('2026-11-08T01:39:59Z'))).toEqual([
      'eth-updown-5m-2026-11-08-0135z',
      'eth-updown-5m-2026-11-08-0140z',
    ])
    expect(upDownEventSlugs('sol', '1h', at('2026-11-08T01:59:00Z'))[0]).toBe('sol-updown-1h-2026-11-08-0100z')
  })

  it('starts daily windows at 5pm New York in winter (22:00Z) and summer (21:00Z)', () => {
    // 01:41Z on Nov 8 is 8:41pm EST Nov 7 → window opened Nov 7 22:00Z
    expect(upDownEventSlugs('btc', '1d', at('2026-11-08T01:41:00Z'))).toEqual([
      'btc-updown-1d-2026-11-07-2200z',
      'btc-updown-1d-2026-11-08-2200z',
    ])
    // July: EDT → 21:00Z; at 20:00Z the current window is the previous day's
    expect(upDownEventSlugs('xrp', '1d', at('2026-07-15T20:00:00Z'))[0]).toBe('xrp-updown-1d-2026-07-14-2100z')
    expect(upDownEventSlugs('xrp', '1d', at('2026-07-15T21:30:00Z'))[0]).toBe('xrp-updown-1d-2026-07-15-2100z')
  })
})

describe('rankForStats', () => {
  it('keeps two-sided markets only, tightest relative spread first', async () => {
    const { rankForStats } = await import('../pmusWire')
    const mk = (slug: string, bid?: number, ask?: number) =>
      normalizeWireMarket({
        id: slug, slug, title: slug, active: true, closed: false,
        bestBidQuote: bid ? { value: String(bid) } : null,
        bestAskQuote: ask ? { value: String(ask) } : null,
      } as WireMarket)
    const ranked = rankForStats([mk('wide', 0.10, 0.30), mk('none'), mk('tight', 0.50, 0.51), mk('oneSided', undefined, 0.4)])
    expect(ranked.map(m => m.slug)).toEqual(['tight', 'wide'])
  })
})
