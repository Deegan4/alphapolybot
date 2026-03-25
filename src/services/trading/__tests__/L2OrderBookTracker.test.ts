import { describe, it, expect, beforeEach, vi } from 'vitest'
import { L2OrderBookTracker } from '../L2OrderBookTracker'

describe('L2OrderBookTracker', () => {
  let tracker: L2OrderBookTracker

  beforeEach(() => {
    tracker = new L2OrderBookTracker()
  })

  // ─── Tracking Lifecycle ───────────────────────────────────

  describe('track/untrack', () => {
    it('tracks and untracks tokens', () => {
      tracker.track('token1')
      expect(tracker.isTracking('token1')).toBe(true)
      expect(tracker.trackedCount).toBe(1)

      tracker.untrack('token1')
      expect(tracker.isTracking('token1')).toBe(false)
      expect(tracker.trackedCount).toBe(0)
    })

    it('ignores snapshots for untracked tokens', () => {
      tracker.applySnapshot('token1', [{ price: 0.40, size: 100 }], [{ price: 0.60, size: 100 }])
      expect(tracker.getSnapshot('token1')).toBeNull()
    })
  })

  // ─── Snapshot Application ─────────────────────────────────

  describe('applySnapshot', () => {
    it('stores and sorts bid/ask levels', () => {
      tracker.track('tok1')
      tracker.applySnapshot('tok1', [
        { price: 0.38, size: 50 },
        { price: 0.40, size: 100 },
        { price: 0.35, size: 75 },
      ], [
        { price: 0.62, size: 80 },
        { price: 0.60, size: 120 },
        { price: 0.65, size: 60 },
      ])

      const snap = tracker.getSnapshot('tok1')!
      expect(snap.bids[0].price).toBe(0.40) // best bid = highest
      expect(snap.bids[2].price).toBe(0.35)
      expect(snap.asks[0].price).toBe(0.60) // best ask = lowest
      expect(snap.asks[2].price).toBe(0.65)
    })
  })

  // ─── Delta Application ────────────────────────────────────

  describe('applyDelta', () => {
    it('updates existing levels', () => {
      tracker.track('tok1')
      tracker.applySnapshot('tok1', [{ price: 0.40, size: 100 }], [{ price: 0.60, size: 100 }])

      tracker.applyDelta('tok1', [{ price: 0.40, side: 'bid', size: 200 }])
      expect(tracker.getSnapshot('tok1')!.bids[0].size).toBe(200)
    })

    it('removes levels with size=0', () => {
      tracker.track('tok1')
      tracker.applySnapshot('tok1', [
        { price: 0.40, size: 100 },
        { price: 0.38, size: 50 },
      ], [{ price: 0.60, size: 100 }])

      tracker.applyDelta('tok1', [{ price: 0.40, side: 'bid', size: 0 }])
      const snap = tracker.getSnapshot('tok1')!
      expect(snap.bids.length).toBe(1)
      expect(snap.bids[0].price).toBe(0.38)
    })

    it('inserts new levels', () => {
      tracker.track('tok1')
      tracker.applySnapshot('tok1', [{ price: 0.40, size: 100 }], [{ price: 0.60, size: 100 }])

      tracker.applyDelta('tok1', [{ price: 0.42, side: 'bid', size: 50 }])
      const snap = tracker.getSnapshot('tok1')!
      expect(snap.bids.length).toBe(2)
      expect(snap.bids[0].price).toBe(0.42) // new best bid
    })

    it('creates book from deltas if no snapshot exists', () => {
      tracker.track('tok1')
      tracker.applyDelta('tok1', [
        { price: 0.40, side: 'bid', size: 100 },
        { price: 0.60, side: 'ask', size: 80 },
      ])
      const snap = tracker.getSnapshot('tok1')!
      expect(snap.bids.length).toBe(1)
      expect(snap.asks.length).toBe(1)
    })
  })

  // ─── BBO ──────────────────────────────────────────────────

  describe('getBBO', () => {
    it('returns best bid/ask and spread', () => {
      tracker.track('tok1')
      tracker.applySnapshot('tok1', [
        { price: 0.40, size: 100 },
        { price: 0.38, size: 50 },
      ], [
        { price: 0.60, size: 80 },
        { price: 0.62, size: 60 },
      ])

      const bbo = tracker.getBBO('tok1')!
      expect(bbo.bid).toBe(0.40)
      expect(bbo.ask).toBe(0.60)
      expect(bbo.spread).toBeCloseTo(0.20)
    })

    it('returns null for empty book', () => {
      expect(tracker.getBBO('nonexistent')).toBeNull()
    })
  })

  // ─── Depth Imbalance ─────────────────────────────────────

  describe('getDepthImbalance', () => {
    it('returns positive imbalance when bids dominate', () => {
      tracker.track('tok1')
      tracker.applySnapshot('tok1', [
        { price: 0.40, size: 300 },
      ], [
        { price: 0.60, size: 100 },
      ])

      const imb = tracker.getDepthImbalance('tok1')
      expect(imb.imbalance).toBe(0.5) // (300-100)/400
      expect(imb.bidSize).toBe(300)
      expect(imb.askSize).toBe(100)
    })

    it('returns negative imbalance when asks dominate', () => {
      tracker.track('tok1')
      tracker.applySnapshot('tok1', [
        { price: 0.40, size: 50 },
      ], [
        { price: 0.60, size: 200 },
      ])

      const imb = tracker.getDepthImbalance('tok1')
      expect(imb.imbalance).toBe(-0.6) // (50-200)/250
    })

    it('returns zero for equal sides', () => {
      tracker.track('tok1')
      tracker.applySnapshot('tok1', [
        { price: 0.40, size: 100 },
      ], [
        { price: 0.60, size: 100 },
      ])

      expect(tracker.getDepthImbalance('tok1').imbalance).toBe(0)
    })

    it('respects topN parameter', () => {
      tracker.track('tok1')
      tracker.applySnapshot('tok1', [
        { price: 0.40, size: 100 },
        { price: 0.38, size: 900 }, // will be excluded with topN=1
      ], [
        { price: 0.60, size: 50 },
        { price: 0.62, size: 500 },
      ])

      const imb1 = tracker.getDepthImbalance('tok1', 1)
      expect(imb1.bidSize).toBe(100)
      expect(imb1.askSize).toBe(50)
    })

    it('returns zero for untracked token', () => {
      expect(tracker.getDepthImbalance('nonexistent').imbalance).toBe(0)
    })
  })

  // ─── Liquidity Walls ─────────────────────────────────────

  describe('findLiquidityWalls', () => {
    it('finds levels with outsized liquidity', () => {
      tracker.track('tok1')
      tracker.applySnapshot('tok1', [
        { price: 0.40, size: 100 },
        { price: 0.38, size: 100 },
        { price: 0.35, size: 1000 }, // 10x avg → wall
      ], [
        { price: 0.60, size: 100 },
        { price: 0.62, size: 100 },
      ])

      const walls = tracker.findLiquidityWalls('tok1', 3.0)
      expect(walls.length).toBeGreaterThan(0)
      expect(walls[0].price).toBe(0.35)
      expect(walls[0].side).toBe('bid')
      expect(walls[0].sizeMultiple).toBeGreaterThan(3)
    })

    it('returns empty for balanced books', () => {
      tracker.track('tok1')
      tracker.applySnapshot('tok1', [
        { price: 0.40, size: 100 },
      ], [
        { price: 0.60, size: 100 },
      ])

      const walls = tracker.findLiquidityWalls('tok1', 3.0)
      expect(walls.length).toBe(0)
    })
  })

  // ─── Queue Position ──────────────────────────────────────

  describe('queue position tracking', () => {
    it('estimates queue position for resting orders', () => {
      tracker.track('tok1')
      tracker.applySnapshot('tok1', [
        { price: 0.40, size: 500 },
      ], [
        { price: 0.60, size: 300 },
      ])

      // Place our order for 50 shares at 0.40
      tracker.registerRestingOrder('tok1', 0.40, 50)

      const pos = tracker.getQueuePosition('tok1', 0.40)
      expect(pos.levelExists).toBe(true)
      expect(pos.totalAtLevel).toBe(500)
      expect(pos.sharesAhead).toBe(450) // 500 - 50 = 450 ahead
    })

    it('improves position as fills consume queue', () => {
      tracker.track('tok1')
      tracker.applySnapshot('tok1', [{ price: 0.40, size: 500 }], [{ price: 0.60, size: 300 }])
      tracker.registerRestingOrder('tok1', 0.40, 50)

      // Simulate 200 shares being filled (consumed from front)
      tracker.applyDelta('tok1', [{ price: 0.40, side: 'bid', size: 300 }])

      const pos = tracker.getQueuePosition('tok1', 0.40)
      expect(pos.sharesAhead).toBe(250) // 450 - 200 consumed
    })

    it('returns levelExists=false when level removed', () => {
      tracker.track('tok1')
      tracker.applySnapshot('tok1', [{ price: 0.40, size: 500 }], [{ price: 0.60, size: 300 }])
      tracker.registerRestingOrder('tok1', 0.40, 50)

      tracker.applyDelta('tok1', [{ price: 0.40, side: 'bid', size: 0 }])

      const pos = tracker.getQueuePosition('tok1', 0.40)
      expect(pos.levelExists).toBe(false)
    })

    it('unregisters on cancel', () => {
      tracker.track('tok1')
      tracker.applySnapshot('tok1', [{ price: 0.40, size: 500 }], [{ price: 0.60, size: 300 }])
      tracker.registerRestingOrder('tok1', 0.40, 50)
      tracker.unregisterRestingOrder('tok1', 0.40)

      const pos = tracker.getQueuePosition('tok1', 0.40)
      expect(pos.levelExists).toBe(false) // no registered order
    })
  })

  // ─── Depth Metrics ────────────────────────────────────────

  describe('depth metrics', () => {
    it('getBidDepth sums bid sizes', () => {
      tracker.track('tok1')
      tracker.applySnapshot('tok1', [
        { price: 0.40, size: 100 },
        { price: 0.38, size: 200 },
        { price: 0.35, size: 300 },
      ], [])

      expect(tracker.getBidDepth('tok1', 2)).toBe(300) // top 2 levels
      expect(tracker.getBidDepth('tok1', 10)).toBe(600) // all 3
    })

    it('estimateBuySlippage returns 0 for small orders', () => {
      tracker.track('tok1')
      tracker.applySnapshot('tok1', [], [
        { price: 0.60, size: 1000 },
        { price: 0.62, size: 500 },
      ])

      // Small order that fills entirely at best ask
      const slip = tracker.estimateBuySlippage('tok1', 10)
      expect(slip).toBeCloseTo(0, 2)
    })

    it('estimateBuySlippage increases for large orders', () => {
      tracker.track('tok1')
      tracker.applySnapshot('tok1', [], [
        { price: 0.60, size: 100 },  // 60 USD
        { price: 0.65, size: 100 },  // 65 USD
      ])

      // Large order that needs both levels
      const slip = tracker.estimateBuySlippage('tok1', 100)
      expect(slip).toBeGreaterThan(0)
    })
  })

  // ─── Callbacks ────────────────────────────────────────────

  describe('onDepthUpdate', () => {
    it('fires callback on snapshot', () => {
      const cb = vi.fn()
      tracker.onDepthUpdate(cb)
      tracker.track('tok1')
      tracker.applySnapshot('tok1', [{ price: 0.40, size: 100 }], [{ price: 0.60, size: 100 }])

      expect(cb).toHaveBeenCalledOnce()
      expect(cb.mock.calls[0][0]).toBe('tok1')
    })

    it('fires callback on delta', () => {
      const cb = vi.fn()
      tracker.onDepthUpdate(cb)
      tracker.track('tok1')
      tracker.applySnapshot('tok1', [{ price: 0.40, size: 100 }], [])
      tracker.applyDelta('tok1', [{ price: 0.42, side: 'bid', size: 50 }])

      expect(cb).toHaveBeenCalledTimes(2) // snapshot + delta
    })

    it('unsubscribe stops callbacks', () => {
      const cb = vi.fn()
      const unsub = tracker.onDepthUpdate(cb)
      tracker.track('tok1')
      unsub()
      tracker.applySnapshot('tok1', [{ price: 0.40, size: 100 }], [])

      expect(cb).not.toHaveBeenCalled()
    })
  })

  // ─── Clear ────────────────────────────────────────────────

  describe('clear', () => {
    it('removes all state', () => {
      tracker.track('tok1')
      tracker.applySnapshot('tok1', [{ price: 0.40, size: 100 }], [])
      tracker.registerRestingOrder('tok1', 0.40, 50)
      tracker.clear()

      expect(tracker.trackedCount).toBe(0)
      expect(tracker.getSnapshot('tok1')).toBeNull()
    })
  })
})
