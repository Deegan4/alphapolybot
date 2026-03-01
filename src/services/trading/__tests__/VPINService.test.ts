import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock settingsStore before importing VPINService
const mockSettings = vi.hoisted(() => ({
  vpinToxicityThreshold: 0.7,
}))

vi.mock('@/stores/settingsStore', () => ({
  useSettingsStore: {
    getState: () => mockSettings,
  },
}))

// Mock realtime services (not used in unit tests, but prevents import errors)
vi.mock('@/services/realtime', () => ({
  userChannelService: { onTrade: vi.fn(() => () => {}) },
  realtimeService: { onPriceUpdate: vi.fn(() => () => {}) },
}))

vi.mock('@/stores/walletStore', () => ({
  useWalletStore: {
    getState: () => ({ address: '0xabc', proxyAddress: '0xdef' }),
  },
}))

import { VPINService } from '../VPINService'

describe('VPINService', () => {
  let service: VPINService

  beforeEach(() => {
    service = new VPINService()
    mockSettings.vpinToxicityThreshold = 0.7
  })

  // ─── Bucket Management ─────────────────────────────────

  describe('recordTrade()', () => {
    it('creates buckets and assigns to correct time slot', () => {
      const now = Date.now()
      service.recordTrade('token-a', 'buy', 100, now)
      expect(service.getVPIN('token-a')).toBe(1.0) // All one direction
    })

    it('assigns to same bucket for trades in same 30s window', () => {
      const base = 1000000 * 30  // Clean bucket boundary
      service.recordTrade('token-a', 'buy', 100, base + 1000)
      service.recordTrade('token-a', 'sell', 100, base + 15000)
      expect(service.getVPIN('token-a')).toBe(0) // Equal volume
    })

    it('ignores zero or negative volume', () => {
      service.recordTrade('token-a', 'buy', 0)
      service.recordTrade('token-a', 'sell', -10)
      expect(service.getVPIN('token-a')).toBe(0)
    })
  })

  // ─── VPIN Calculation ──────────────────────────────────

  describe('computeVPIN / getVPIN', () => {
    it('all buy volume => VPIN = 1.0', () => {
      const now = Date.now()
      service.recordTrade('token-a', 'buy', 100, now)
      service.recordTrade('token-a', 'buy', 200, now + 1000)
      expect(service.getVPIN('token-a')).toBe(1.0)
    })

    it('equal buy/sell => VPIN = 0.0', () => {
      const now = Date.now()
      service.recordTrade('token-a', 'buy', 100, now)
      service.recordTrade('token-a', 'sell', 100, now + 1000)
      expect(service.getVPIN('token-a')).toBe(0)
    })

    it('70% buy / 30% sell => VPIN = 0.4', () => {
      const now = Date.now()
      service.recordTrade('token-a', 'buy', 70, now)
      service.recordTrade('token-a', 'sell', 30, now + 1000)
      expect(service.getVPIN('token-a')).toBeCloseTo(0.4, 10)
    })

    it('unknown token returns 0', () => {
      expect(service.getVPIN('nonexistent')).toBe(0)
    })

    it('zero volume in window returns 0', () => {
      // Old bucket that will be pruned
      const veryOld = Date.now() - 2_000_000 // Well beyond 25 min window
      service.recordTrade('token-a', 'buy', 100, veryOld)
      // After pruning, no current data
      expect(service.getVPIN('token-a')).toBe(0)
    })
  })

  // ─── Bucket Rotation ───────────────────────────────────

  describe('bucket pruning', () => {
    it('old buckets (> 25 min) are pruned', () => {
      const now = Date.now()
      const oldTime = now - (30_000 * 51) // 51 buckets ago = beyond 50-bucket window

      // Record old buy-heavy data
      service.recordTrade('token-a', 'buy', 1000, oldTime)
      // Record recent balanced data
      service.recordTrade('token-a', 'buy', 50, now)
      service.recordTrade('token-a', 'sell', 50, now + 1000)

      // Old data should be pruned, leaving balanced recent data
      expect(service.getVPIN('token-a')).toBe(0)
    })
  })

  // ─── Threshold Detection ───────────────────────────────

  describe('isToxic()', () => {
    it('returns true when VPIN > threshold', () => {
      service.recordTrade('token-a', 'buy', 100)
      // VPIN = 1.0, threshold = 0.7
      expect(service.isToxic('token-a')).toBe(true)
    })

    it('returns false when VPIN < threshold', () => {
      const now = Date.now()
      service.recordTrade('token-a', 'buy', 60, now)
      service.recordTrade('token-a', 'sell', 40, now + 100)
      // VPIN = 0.2, threshold = 0.7
      expect(service.isToxic('token-a')).toBe(false)
    })

    it('uses custom threshold when provided', () => {
      const now = Date.now()
      service.recordTrade('token-a', 'buy', 65, now)
      service.recordTrade('token-a', 'sell', 35, now + 100)
      // VPIN = 0.30
      expect(service.isToxic('token-a', 0.25)).toBe(true)
      expect(service.isToxic('token-a', 0.35)).toBe(false)
    })

    it('uses settingsStore threshold by default', () => {
      mockSettings.vpinToxicityThreshold = 0.3
      const now = Date.now()
      service.recordTrade('token-a', 'buy', 65, now)
      service.recordTrade('token-a', 'sell', 35, now + 100)
      // VPIN = 0.30, threshold = 0.30
      expect(service.isToxic('token-a')).toBe(true)
    })
  })

  // ─── Event Emission ────────────────────────────────────

  describe('onToxicityChange()', () => {
    it('fires callback when crossing threshold', () => {
      const callback = vi.fn()
      service.onToxicityChange(callback)

      // Record trade that makes VPIN = 1.0 > 0.7 threshold
      service.recordTrade('token-a', 'buy', 100)

      expect(callback).toHaveBeenCalledWith('token-a', 1.0, true)
    })

    it('does not fire twice when already toxic', () => {
      const callback = vi.fn()
      service.onToxicityChange(callback)

      service.recordTrade('token-a', 'buy', 100)
      service.recordTrade('token-a', 'buy', 200) // Still toxic

      // Only one transition notification
      expect(callback).toHaveBeenCalledTimes(1)
    })

    it('fires on recovery (toxic → not toxic)', () => {
      const callback = vi.fn()
      service.onToxicityChange(callback)

      const now = Date.now()
      // Become toxic
      service.recordTrade('token-a', 'buy', 100, now)
      expect(callback).toHaveBeenCalledWith('token-a', 1.0, true)

      // Add balancing sell volume to recover
      service.recordTrade('token-a', 'sell', 200, now + 1000)
      // VPIN = |100-200|/(100+200) = 1/3 ≈ 0.33 < 0.7
      expect(callback).toHaveBeenCalledTimes(2)
      expect(callback).toHaveBeenLastCalledWith('token-a', expect.any(Number), false)
    })

    it('unsubscribe function works', () => {
      const callback = vi.fn()
      const unsub = service.onToxicityChange(callback)
      unsub()

      service.recordTrade('token-a', 'buy', 100)
      expect(callback).not.toHaveBeenCalled()
    })
  })

  // ─── Multiple Tokens ───────────────────────────────────

  describe('multi-token tracking', () => {
    it('tracks tokens independently', () => {
      const now = Date.now()
      // Token A: toxic (all buys)
      service.recordTrade('token-a', 'buy', 100, now)
      // Token B: balanced
      service.recordTrade('token-b', 'buy', 50, now)
      service.recordTrade('token-b', 'sell', 50, now + 100)

      expect(service.isToxic('token-a')).toBe(true)
      expect(service.isToxic('token-b')).toBe(false)
    })
  })

  // ─── Trade Direction Classification ────────────────────

  describe('classifyTradeDirection()', () => {
    it('our buy trade => buy', () => {
      expect(service.classifyTradeDirection({
        tradePrice: 0.50, tradeSide: 'BUY', bestBid: 0.49, bestAsk: 0.51, isOurTrade: true,
      })).toBe('buy')
    })

    it('our sell trade => sell', () => {
      expect(service.classifyTradeDirection({
        tradePrice: 0.50, tradeSide: 'SELL', bestBid: 0.49, bestAsk: 0.51, isOurTrade: true,
      })).toBe('sell')
    })

    it('external trade at/above ask => buy-initiated', () => {
      expect(service.classifyTradeDirection({
        tradePrice: 0.51, tradeSide: 'BUY', bestBid: 0.49, bestAsk: 0.51, isOurTrade: false,
      })).toBe('buy')
    })

    it('external trade at/below bid => sell-initiated', () => {
      expect(service.classifyTradeDirection({
        tradePrice: 0.49, tradeSide: 'SELL', bestBid: 0.49, bestAsk: 0.51, isOurTrade: false,
      })).toBe('sell')
    })

    it('mid-quote falls back to tick test', () => {
      expect(service.classifyTradeDirection({
        tradePrice: 0.50, tradeSide: 'BUY', bestBid: 0.49, bestAsk: 0.51,
        isOurTrade: false, lastTradePrice: 0.48,
      })).toBe('buy') // Price went up from last trade
    })

    it('mid-quote falls back to midpoint when no last trade', () => {
      expect(service.classifyTradeDirection({
        tradePrice: 0.501, tradeSide: 'BUY', bestBid: 0.49, bestAsk: 0.51, isOurTrade: false,
      })).toBe('buy') // Above midpoint (0.50)
    })
  })

  // ─── Cleanup ───────────────────────────────────────────

  describe('destroy()', () => {
    it('clears all state', () => {
      service.recordTrade('token-a', 'buy', 100)
      service.updateBBO('token-a', 0.49, 0.51)
      service.onToxicityChange(vi.fn())

      service.destroy()

      expect(service.getVPIN('token-a')).toBe(0)
    })
  })
})
