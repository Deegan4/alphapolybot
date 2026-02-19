import { describe, it, expect, vi, beforeEach } from 'vitest'
import { DualSideHedgeStrategy } from '../DualSideHedgeStrategy'
import { DynamicFeeService } from '@/services/trading/DynamicFeeService'
import type { Signal } from '../btcupdown/signalEngine'

// ==========================================
// MOCK SETTINGS
// ==========================================

const mockSettings = {
  dualSideEnabled: true,
  dualSideTradeSize: 2.0,
  dualSideBiasRatio: 0.70,
  dualSideMakerOnly: true,
  dualSideMaxCombinedAsk: 0.995,
  dualSideRequireBothLegs: true,
}

vi.mock('@/stores/settingsStore', () => ({
  useSettingsStore: {
    getState: () => mockSettings,
  },
}))

vi.mock('@/services/trading/ActivityLogger', () => ({
  activityLogger: {
    logTrade: vi.fn(),
    logScan: vi.fn(),
    logSystem: vi.fn(),
  },
}))

vi.mock('@/services/trading/RejectionTracker', () => ({
  rejectionTracker: {
    record: vi.fn(),
  },
}))

// ==========================================
// HELPERS
// ==========================================

const feeService = new DynamicFeeService()

function makeSignal(overrides?: Partial<Signal>): Signal {
  return {
    direction: 'up',
    confidence: 0.65,
    factors: {
      momentumScore: 0.7,
      velocityScore: 0.5,
      timeScore: 0.6,
      valueScore: 0.4,
      flowScore: 0.3,
    },
    regime: 'trending',
    rsi: 55,
    ...overrides,
  }
}

// ==========================================
// BIAS SIZING
// ==========================================

describe('DualSideHedgeStrategy — computeBiasedSizes', () => {
  const strategy = new DualSideHedgeStrategy()

  it('allocates 70/30 with biasRatio=0.70 when direction=up', () => {
    const { yesSize, noSize } = strategy.computeBiasedSizes(2.0, 0.70, 'up')
    expect(yesSize).toBeCloseTo(1.40, 2)
    expect(noSize).toBeCloseTo(0.60, 2)
  })

  it('allocates 70/30 inversely when direction=down', () => {
    const { yesSize, noSize } = strategy.computeBiasedSizes(2.0, 0.70, 'down')
    expect(yesSize).toBeCloseTo(0.60, 2)
    expect(noSize).toBeCloseTo(1.40, 2)
  })

  it('50/50 split with biasRatio=0.50', () => {
    const { yesSize, noSize } = strategy.computeBiasedSizes(2.0, 0.50, 'up')
    expect(yesSize).toBeCloseTo(1.00, 2)
    expect(noSize).toBeCloseTo(1.00, 2)
  })

  it('all-in on winner with biasRatio=1.0', () => {
    const { yesSize, noSize } = strategy.computeBiasedSizes(2.0, 1.0, 'up')
    expect(yesSize).toBeCloseTo(2.00, 2)
    expect(noSize).toBeCloseTo(0.00, 2)
  })
})

// ==========================================
// FEE VIABILITY (via DynamicFeeService)
// ==========================================

describe('DualSideHedgeStrategy — fee viability integration', () => {
  it('maker (0 bps) with combined 0.98 is profitable', () => {
    const ev = feeService.computeDualSideEV({
      yesPrice: 0.49,
      noPrice: 0.49,
      yesFeeRateBps: 0,    // maker
      noFeeRateBps: 0,      // maker
      winProbability: 0.60,
    })
    expect(ev.isViable).toBe(true)
    expect(ev.netEV).toBeCloseTo(0.02, 4)
  })

  it('taker (1000 bps) with combined 0.98 is NOT profitable', () => {
    const ev = feeService.computeDualSideEV({
      yesPrice: 0.49,
      noPrice: 0.49,
      yesFeeRateBps: 1000,  // 10% taker
      noFeeRateBps: 1000,
      winProbability: 0.60,
    })
    expect(ev.isViable).toBe(false)
  })

  it('taker dynamic fee (~315 bps) at 50/50 with combined 0.98 is NOT profitable', () => {
    const ev = feeService.computeDualSideEV({
      yesPrice: 0.50,
      noPrice: 0.48,
      yesFeeRateBps: 315,
      noFeeRateBps: 315,
      winProbability: 0.60,
    })
    expect(ev.isViable).toBe(false)
  })

  it('maker with combined 0.995 is barely profitable', () => {
    const ev = feeService.computeDualSideEV({
      yesPrice: 0.50,
      noPrice: 0.495,
      yesFeeRateBps: 0,
      noFeeRateBps: 0,
      winProbability: 0.50,
    })
    expect(ev.isViable).toBe(true)
    expect(ev.netEV).toBeCloseTo(0.005, 4)
  })
})

// ==========================================
// SIGNAL GATING
// ==========================================

describe('DualSideHedgeStrategy — signal gating', () => {
  let strategy: DualSideHedgeStrategy

  beforeEach(() => {
    strategy = new DualSideHedgeStrategy()
    // Enable the strategy
    strategy['_enabled'] = true
    // Override dualConfig to return enabled
    Object.assign(mockSettings, {
      dualSideEnabled: true,
      dualSideTradeSize: 2.0,
      dualSideBiasRatio: 0.70,
      dualSideMakerOnly: true,
      dualSideMaxCombinedAsk: 0.995,
      dualSideRequireBothLegs: true,
    })
  })

  it('rejects signals below minSignalConfidence', async () => {
    const emitted: unknown[] = []
    strategy.on('hedgePlaced', (_e, d) => emitted.push(d))

    await strategy.onSignal('BTC', makeSignal({ confidence: 0.30 }), 65000, 65300)
    expect(emitted).toHaveLength(0)
  })

  it('rejects when strategy is disabled', async () => {
    strategy['_enabled'] = false
    const emitted: unknown[] = []
    strategy.on('hedgePlaced', (_e, d) => emitted.push(d))

    await strategy.onSignal('BTC', makeSignal({ confidence: 0.65 }), 65000, 65300)
    expect(emitted).toHaveLength(0)
  })

  it('rejects when dualSideEnabled is false', async () => {
    mockSettings.dualSideEnabled = false
    const emitted: unknown[] = []
    strategy.on('hedgePlaced', (_e, d) => emitted.push(d))

    await strategy.onSignal('BTC', makeSignal({ confidence: 0.65 }), 65000, 65300)
    expect(emitted).toHaveLength(0)
  })

  it('rejects duplicate hedge for same asset', async () => {
    // Manually add a pending hedge
    strategy.getPendingHedges().set('BTC', {
      marketId: 'test',
      asset: 'BTC',
      yesPrice: 0.49,
      noPrice: 0.49,
      yesFilled: false,
      noFilled: false,
      direction: 'up',
      confidence: 0.65,
      placedAt: Date.now(),
    })

    const emitted: unknown[] = []
    strategy.on('hedgePlaced', (_e, d) => emitted.push(d))

    await strategy.onSignal('BTC', makeSignal({ confidence: 0.65 }), 65000, 65300)
    expect(emitted).toHaveLength(0) // rejected — already pending
  })
})

// ==========================================
// LIFECYCLE
// ==========================================

describe('DualSideHedgeStrategy — lifecycle', () => {
  it('starts with correct initial state', () => {
    const strategy = new DualSideHedgeStrategy()
    expect(strategy.name).toBe('Dual-Side Hedge')
    expect(strategy.strategyType).toBe('mechanical')
    expect(strategy.enabled).toBe(false)
    expect(strategy.status).toBe('idle')
  })

  it('stop clears pending hedges', async () => {
    const strategy = new DualSideHedgeStrategy()
    strategy.getPendingHedges().set('BTC', {
      marketId: 'test',
      asset: 'BTC',
      yesPrice: 0.49,
      noPrice: 0.49,
      yesFilled: false,
      noFilled: false,
      direction: 'up',
      confidence: 0.65,
      placedAt: Date.now(),
    })
    expect(strategy.getPendingHedges().size).toBe(1)
    await strategy.stop()
    expect(strategy.getPendingHedges().size).toBe(0)
  })
})
