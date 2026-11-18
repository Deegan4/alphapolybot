import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/services/trading/ActivityLogger', () => ({
  activityLogger: {
    logWarning: vi.fn(),
    logSystem: vi.fn(),
    logInfo: vi.fn(),
    logError: vi.fn(),
  },
}))

import { activityLogger } from '@/services/trading/ActivityLogger'
import { DipArbStrategy } from '../DipArbStrategy'
import { ProjectFWStrategy } from '../ProjectFWStrategy'
import { ShelvedStrategy } from '../ShelvedStrategy'

describe('Shelved strategies (pending Polymarket US port)', () => {
  beforeEach(() => vi.clearAllMocks())

  describe.each([
    ['DipArbStrategy', () => new DipArbStrategy(), 'Dip Arbitrage'],
    ['ProjectFWStrategy', () => new ProjectFWStrategy(), 'ProjectFW Arb'],
  ] as const)('%s', (_label, make, expectedName) => {
    it('is a ShelvedStrategy flagged unavailable', () => {
      const s = make()
      expect(s).toBeInstanceOf(ShelvedStrategy)
      expect(s.available).toBe(false)
      expect(s.name).toBe(expectedName)
      expect(s.strategyType).toBe('arbitrage')
      expect(s.legacyRef).toMatch(/^[0-9a-f]{7,}:src\//)
    })

    it('refuses to start and stays disabled on enable()', async () => {
      const s = make()
      await s.initialize()
      expect(s.status).toBe('idle')

      const disabled = vi.fn()
      s.on('disabled', disabled)

      await s.enable()
      expect(s.enabled).toBe(false)
      expect(s.config.enabled).toBe(false)
      expect(s.status).toBe('idle')
      expect(disabled).toHaveBeenCalled()
      expect(activityLogger.logWarning).toHaveBeenCalledWith(expect.stringContaining('not available on Polymarket US'))
    })

    it('start() is a logged no-op', async () => {
      const s = make()
      const log = vi.fn()
      s.on('log', log)
      await s.start()
      expect(s.status).toBe('idle')
      expect(log).toHaveBeenCalled()
    })

    it('reports empty arb stats', () => {
      const s = make()
      expect(s.getArbRounds()).toEqual([])
      expect(s.getArbStats()).toEqual({ rounds: 0, completed: 0, failed: 0, totalProfit: 0 })
      expect(s.getStats().totalTrades).toBe(0)
    })
  })

  describe('DipArbStrategy config surface', () => {
    it('keeps legacy defaults and merges updates', () => {
      const s = new DipArbStrategy()
      expect(s.getDipConfig().sumTarget).toBe(0.96)
      expect(s.getDipConfig().shares).toBe(5)

      const handler = vi.fn()
      s.on('configUpdated', handler)
      s.setDipConfig({ shares: 10 })
      expect(s.getDipConfig().shares).toBe(10)
      expect(s.getDipConfig().sumTarget).toBe(0.96)
      expect(handler).toHaveBeenCalled()
    })

    it('accepts constructor overrides', () => {
      expect(new DipArbStrategy({ cooldownMs: 1 }).getDipConfig().cooldownMs).toBe(1)
    })
  })

  describe('ProjectFWStrategy config surface', () => {
    it('keeps legacy defaults and merges updates', () => {
      const s = new ProjectFWStrategy()
      const c = s.getFWConfig()
      expect(c.alpha).toBe(0.5)
      expect(c.tradeSize).toBe(5)
      expect(c.minProfitBps).toBe(30)
      expect(c.maxConcurrentArbs).toBe(2)
      expect(c.takerFeeBps).toBe(100)

      const handler = vi.fn()
      s.on('configUpdated', handler)
      s.setFWConfig({ tradeSize: 10, alpha: 0.8 })
      expect(s.getFWConfig().tradeSize).toBe(10)
      expect(s.getFWConfig().alpha).toBe(0.8)
      expect(s.getFWConfig().minProfitBps).toBe(30)
      expect(handler).toHaveBeenCalled()
    })

    it('setCrossMarket toggles the config flag', () => {
      const s = new ProjectFWStrategy()
      s.setCrossMarket(true)
      expect(s.getFWConfig().enableCrossMarket).toBe(true)
    })

    it('accepts constructor overrides', () => {
      const s = new ProjectFWStrategy({ tradeSize: 10, alpha: 0.9 })
      expect(s.getFWConfig().tradeSize).toBe(10)
      expect(s.getFWConfig().alpha).toBe(0.9)
    })
  })
})
