import { describe, it, expect, beforeEach } from 'vitest'
import { OrderFlowImbalanceService } from '../OrderFlowImbalanceService'
import type { BinanceTradeUpdate } from '@/services/realtime/BinanceWSService'

function makeTrade(overrides: Partial<BinanceTradeUpdate> = {}): BinanceTradeUpdate {
  return {
    symbol: 'BTC',
    price: 97000,
    quantity: 0.01,
    quoteQuantity: 970,
    isBuyerMaker: false, // buyer is taker = buy aggressor
    timestamp: Date.now(),
    ...overrides,
  }
}

describe('OrderFlowImbalanceService', () => {
  let service: OrderFlowImbalanceService

  beforeEach(() => {
    service = new OrderFlowImbalanceService(60_000)
  })

  // ─── Trade Ingestion ──────────────────────────────────────

  describe('ingestTrade', () => {
    it('stores trades and reports count', () => {
      service.ingestTrade(makeTrade())
      service.ingestTrade(makeTrade())
      expect(service.getTradeCount('BTC')).toBe(2)
    })

    it('separates assets', () => {
      service.ingestTrade(makeTrade({ symbol: 'BTC' }))
      service.ingestTrade(makeTrade({ symbol: 'ETH', price: 3500 }))

      expect(service.getTradeCount('BTC')).toBe(1)
      expect(service.getTradeCount('ETH')).toBe(1)
    })
  })

  // ─── Snapshot ─────────────────────────────────────────────

  describe('getSnapshot', () => {
    it('returns null for empty asset', () => {
      expect(service.getSnapshot('BTC')).toBeNull()
    })

    it('computes buy-heavy OFI', () => {
      const now = Date.now()
      // 8 buy aggressors, 2 sell aggressors
      for (let i = 0; i < 8; i++) {
        service.ingestTrade(makeTrade({ isBuyerMaker: false, timestamp: now - 1000 + i })) // buy aggressor
      }
      for (let i = 0; i < 2; i++) {
        service.ingestTrade(makeTrade({ isBuyerMaker: true, timestamp: now - 500 + i })) // sell aggressor
      }

      const snap = service.getSnapshot('BTC')!
      expect(snap).not.toBeNull()
      expect(snap.ofi).toBeCloseTo(0.6) // (8-2)/10
      expect(snap.buyRatio).toBeCloseTo(0.8) // 8/10 by volume (equal sizes)
      expect(snap.tradeCount).toBe(10)
    })

    it('computes sell-heavy OFI', () => {
      const now = Date.now()
      for (let i = 0; i < 3; i++) {
        service.ingestTrade(makeTrade({ isBuyerMaker: false, timestamp: now + i }))
      }
      for (let i = 0; i < 7; i++) {
        service.ingestTrade(makeTrade({ isBuyerMaker: true, timestamp: now + 10 + i }))
      }

      const snap = service.getSnapshot('BTC')!
      expect(snap.ofi).toBeCloseTo(-0.4) // (3-7)/10
    })

    it('computes volume-weighted OFI correctly', () => {
      const now = Date.now()
      // 1 large buy
      service.ingestTrade(makeTrade({ isBuyerMaker: false, quoteQuantity: 10000, timestamp: now }))
      // 5 small sells
      for (let i = 0; i < 5; i++) {
        service.ingestTrade(makeTrade({ isBuyerMaker: true, quoteQuantity: 100, timestamp: now + i + 1 }))
      }

      const snap = service.getSnapshot('BTC')!
      // By count: (1-5)/6 = -0.67
      expect(snap.ofi).toBeCloseTo(-0.667, 2)
      // By volume: (10000-500)/10500 = 0.905
      expect(snap.volumeWeightedOfi).toBeCloseTo(0.905, 2)
    })

    it('respects window parameter', () => {
      const now = Date.now()
      // Old trade outside 10s window
      service.ingestTrade(makeTrade({ timestamp: now - 20_000 }))
      // Recent trade within 10s window
      service.ingestTrade(makeTrade({ timestamp: now - 5_000 }))

      const snap = service.getSnapshot('BTC', 10_000)!
      expect(snap.tradeCount).toBe(1)
    })

    it('computes VWAP delta', () => {
      const now = Date.now()
      // Buys at 97100
      service.ingestTrade(makeTrade({ isBuyerMaker: false, price: 97100, quoteQuantity: 971, timestamp: now }))
      // Sells at 96900
      service.ingestTrade(makeTrade({ isBuyerMaker: true, price: 96900, quoteQuantity: 969, timestamp: now + 1 }))

      const snap = service.getSnapshot('BTC')!
      expect(snap.vwapDelta).toBeCloseTo(200) // 97100 - 96900
    })
  })

  // ─── Signal ───────────────────────────────────────────────

  describe('getSignal', () => {
    it('returns neutral with insufficient trades', () => {
      service.ingestTrade(makeTrade())
      const sig = service.getSignal('BTC')
      expect(sig.direction).toBe('neutral')
      expect(sig.confidence).toBe(0)
    })

    it('returns buy signal with strong buy flow', () => {
      const now = Date.now()
      for (let i = 0; i < 50; i++) {
        service.ingestTrade(makeTrade({ isBuyerMaker: false, timestamp: now + i })) // buy aggressor
      }
      for (let i = 0; i < 5; i++) {
        service.ingestTrade(makeTrade({ isBuyerMaker: true, timestamp: now + 50 + i })) // sell aggressor
      }

      const sig = service.getSignal('BTC')
      expect(sig.direction).toBe('buy')
      expect(sig.signal).toBeGreaterThan(0.25)
      expect(sig.confidence).toBeGreaterThan(0.3)
      expect(sig.isSignificant).toBe(true)
    })

    it('returns sell signal with strong sell flow', () => {
      const now = Date.now()
      for (let i = 0; i < 5; i++) {
        service.ingestTrade(makeTrade({ isBuyerMaker: false, timestamp: now + i }))
      }
      for (let i = 0; i < 50; i++) {
        service.ingestTrade(makeTrade({ isBuyerMaker: true, timestamp: now + 10 + i }))
      }

      const sig = service.getSignal('BTC')
      expect(sig.direction).toBe('sell')
      expect(sig.signal).toBeLessThan(-0.25)
    })

    it('confidence increases with trade count', () => {
      const now = Date.now()
      // 15 trades
      for (let i = 0; i < 15; i++) {
        service.ingestTrade(makeTrade({ isBuyerMaker: false, timestamp: now + i }))
      }
      const sig15 = service.getSignal('BTC')

      // Add 85 more (100 total)
      for (let i = 0; i < 85; i++) {
        service.ingestTrade(makeTrade({ isBuyerMaker: false, timestamp: now + 15 + i }))
      }
      const sig100 = service.getSignal('BTC')

      expect(sig100.confidence).toBeGreaterThan(sig15.confidence)
    })
  })

  // ─── Callbacks ────────────────────────────────────────────

  describe('onFlowUpdate', () => {
    it('fires callback after EMIT_INTERVAL_TRADES trades', () => {
      let received: { asset: string } | null = null
      service.onFlowUpdate((asset) => { received = { asset } })

      const now = Date.now()
      // EMIT_INTERVAL_TRADES = 20
      for (let i = 0; i < 20; i++) {
        service.ingestTrade(makeTrade({ timestamp: now + i }))
      }

      expect(received).not.toBeNull()
      expect(received!.asset).toBe('BTC')
    })

    it('unsubscribe stops callbacks', () => {
      let count = 0
      const unsub = service.onFlowUpdate(() => { count++ })
      unsub()

      const now = Date.now()
      for (let i = 0; i < 40; i++) {
        service.ingestTrade(makeTrade({ timestamp: now + i }))
      }
      expect(count).toBe(0)
    })
  })

  // ─── Lifecycle ────────────────────────────────────────────

  describe('stop', () => {
    it('clears all state', () => {
      service.ingestTrade(makeTrade())
      service.stop()
      expect(service.getTradeCount('BTC')).toBe(0)
      expect(service.trackedAssets.length).toBe(0)
    })
  })
})
