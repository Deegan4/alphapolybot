import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Market } from '@/types'
import type { MarketGroup, MarketDependency, DependencyGraph } from '../projectfw/crossmarket/types'

// Mock modules that depend on browser APIs (localStorage, fetch)
// before importing modules that reference them.
vi.mock('@/services/llm/OpenRouterService', () => ({
  openRouterService: {
    classifyDependencies: vi.fn().mockResolvedValue([]),
    getCostStats: vi.fn().mockReturnValue({ dailySpendUSD: 0, dailyBudgetUSD: 0.5, dailyRemaining: 0.5, callCountToday: 0, totalSpendUSD: 0, budgetExhausted: false }),
    setDailyBudget: vi.fn(),
  },
}))

vi.mock('@/services/api', () => ({
  polymarketClient: {
    getEvents: vi.fn().mockResolvedValue([]),
  },
}))

import { MutexValidator } from '../projectfw/crossmarket/MutexValidator'
import { EventAnalyzer } from '../projectfw/crossmarket/EventAnalyzer'
import { DependencyClassifier } from '../projectfw/crossmarket/DependencyClassifier'

// ==========================================
// HELPERS
// ==========================================

function makeMarket(overrides: Partial<Market> = {}): Market {
  return {
    id: `market-${Math.random().toString(36).slice(2, 8)}`,
    question: 'Will X happen?',
    outcomes: ['Yes', 'No'],
    slug: 'test-market',
    active: true,
    closed: false,
    endDate: '2025-12-31',
    createdAt: '2024-01-01',
    volume: 50000,
    liquidity: 20000,
    outcomePrices: [0.5, 0.5],
    ...overrides,
  }
}

function makeGroup(markets: Market[], eventId = 'event-1', eventTitle = 'Test Event'): MarketGroup {
  return {
    eventId,
    eventTitle,
    markets,
    totalLiquidity: markets.reduce((s, m) => s + m.liquidity, 0),
    activeCount: markets.filter(m => m.active && !m.closed).length,
  }
}

// ==========================================
// MutexValidator Tests
// ==========================================

describe('MutexValidator', () => {
  let validator: MutexValidator

  beforeEach(() => {
    validator = new MutexValidator(0.02) // 2% tolerance
  })

  describe('validateCoherence', () => {
    it('detects coherent mutex prices (sum ≈ 1.0)', () => {
      const marketA = makeMarket({ outcomePrices: [0.60, 0.40] })
      const marketB = makeMarket({ outcomePrices: [0.40, 0.60] })
      const dep: MarketDependency = {
        marketIdA: marketA.id,
        marketIdB: marketB.id,
        type: 'mutex',
        confidence: 0.95,
        reasoning: 'Same race',
        classifiedAt: Date.now(),
      }

      const result = validator.validateCoherence(marketA, marketB, dep)
      expect(result.isCoherent).toBe(true)
      expect(result.actualSum).toBeCloseTo(1.0)
      expect(result.signal).toBe('coherent')
    })

    it('detects overpriced mutex (sum > 1.0)', () => {
      const marketA = makeMarket({ outcomePrices: [0.55, 0.45] })
      const marketB = makeMarket({ outcomePrices: [0.50, 0.50] })
      const dep: MarketDependency = {
        marketIdA: marketA.id, marketIdB: marketB.id,
        type: 'mutex', confidence: 0.9, reasoning: '', classifiedAt: Date.now(),
      }

      const result = validator.validateCoherence(marketA, marketB, dep)
      expect(result.isCoherent).toBe(false)
      expect(result.actualSum).toBeCloseTo(1.05)
      expect(result.incoherence).toBeCloseTo(0.05)
      expect(result.signal).toBe('overpriced')
    })

    it('detects underpriced mutex (sum < 1.0)', () => {
      const marketA = makeMarket({ outcomePrices: [0.30, 0.70] })
      const marketB = makeMarket({ outcomePrices: [0.60, 0.40] })
      const dep: MarketDependency = {
        marketIdA: marketA.id, marketIdB: marketB.id,
        type: 'mutex', confidence: 0.9, reasoning: '', classifiedAt: Date.now(),
      }

      const result = validator.validateCoherence(marketA, marketB, dep)
      expect(result.isCoherent).toBe(false)
      expect(result.actualSum).toBeCloseTo(0.90)
      expect(result.signal).toBe('underpriced')
    })

    it('handles edge case: both near 0.5 (coherent)', () => {
      const marketA = makeMarket({ outcomePrices: [0.49, 0.51] })
      const marketB = makeMarket({ outcomePrices: [0.50, 0.50] })
      const dep: MarketDependency = {
        marketIdA: marketA.id, marketIdB: marketB.id,
        type: 'mutex', confidence: 0.9, reasoning: '', classifiedAt: Date.now(),
      }

      const result = validator.validateCoherence(marketA, marketB, dep)
      expect(result.isCoherent).toBe(true)
      expect(result.signal).toBe('coherent')
    })

    it('handles missing outcomePrices gracefully', () => {
      const marketA = makeMarket({ outcomePrices: [] })
      const marketB = makeMarket({ outcomePrices: [0.40, 0.60] })
      const dep: MarketDependency = {
        marketIdA: marketA.id, marketIdB: marketB.id,
        type: 'mutex', confidence: 0.9, reasoning: '', classifiedAt: Date.now(),
      }

      // Should use fallback 0.5
      const result = validator.validateCoherence(marketA, marketB, dep)
      expect(result.actualSum).toBeCloseTo(0.9)
    })
  })

  describe('buildValidation', () => {
    it('builds validation with coherent reasoning', () => {
      const marketA = makeMarket({ question: 'Will Trump win PA?' })
      const marketB = makeMarket({ question: 'Will Harris win PA?' })
      const dep: MarketDependency = {
        marketIdA: marketA.id, marketIdB: marketB.id,
        type: 'mutex', confidence: 0.95, reasoning: '', classifiedAt: Date.now(),
      }

      // Make coherent
      marketA.outcomePrices = [0.60, 0.40]
      marketB.outcomePrices = [0.40, 0.60]

      const validation = validator.buildValidation(marketA, marketB, dep)
      expect(validation.isValidated).toBe(true)
      expect(validation.mutexPartner).toBe(marketB)
      expect(validation.combinedPriceSum).toBeCloseTo(1.0)
      expect(validation.reasoning).toContain('coherent')
    })

    it('builds validation with incoherent reasoning', () => {
      const marketA = makeMarket({ question: 'Will Trump win PA?', outcomePrices: [0.70, 0.30] })
      const marketB = makeMarket({ question: 'Will Harris win PA?', outcomePrices: [0.40, 0.60] })
      const dep: MarketDependency = {
        marketIdA: marketA.id, marketIdB: marketB.id,
        type: 'mutex', confidence: 0.95, reasoning: '', classifiedAt: Date.now(),
      }

      const validation = validator.buildValidation(marketA, marketB, dep)
      expect(validation.isValidated).toBe(true)
      expect(validation.incoherence).toBeGreaterThan(0.02)
      expect(validation.reasoning).toContain('overpriced')
    })

    it('truncates long market questions in reasoning', () => {
      const longQuestion = 'A'.repeat(100)
      const marketA = makeMarket({ question: 'Short question' })
      const marketB = makeMarket({ question: longQuestion })
      const dep: MarketDependency = {
        marketIdA: marketA.id, marketIdB: marketB.id,
        type: 'mutex', confidence: 0.95, reasoning: '', classifiedAt: Date.now(),
      }

      const validation = validator.buildValidation(marketA, marketB, dep)
      expect(validation.reasoning.length).toBeLessThan(200)
      expect(validation.reasoning).toContain('...')
    })
  })

  describe('notValidated', () => {
    it('returns not-validated result', () => {
      const result = MutexValidator.notValidated()
      expect(result.isValidated).toBe(false)
      expect(result.mutexPartner).toBeUndefined()
    })
  })

  describe('setCoherenceTolerance', () => {
    it('adjusts tolerance', () => {
      validator.setCoherenceTolerance(0.10) // 10% tolerance

      const marketA = makeMarket({ outcomePrices: [0.55, 0.45] })
      const marketB = makeMarket({ outcomePrices: [0.50, 0.50] })
      const dep: MarketDependency = {
        marketIdA: marketA.id, marketIdB: marketB.id,
        type: 'mutex', confidence: 0.9, reasoning: '', classifiedAt: Date.now(),
      }

      // 1.05 is within 10% of 1.0
      const result = validator.validateCoherence(marketA, marketB, dep)
      expect(result.isCoherent).toBe(true)
    })
  })
})

// ==========================================
// EventAnalyzer Tests
// ==========================================

describe('EventAnalyzer', () => {
  describe('generatePairs', () => {
    it('generates all unique pairs for 3 markets', () => {
      const analyzer = new EventAnalyzer()
      const markets = [
        makeMarket({ id: 'a' }),
        makeMarket({ id: 'b' }),
        makeMarket({ id: 'c' }),
      ]
      const group = makeGroup(markets)
      const pairs = analyzer.generatePairs(group)

      expect(pairs).toHaveLength(3) // C(3,2) = 3
      expect(pairs[0].marketA.id).toBe('a')
      expect(pairs[0].marketB.id).toBe('b')
      expect(pairs[1].marketA.id).toBe('a')
      expect(pairs[1].marketB.id).toBe('c')
      expect(pairs[2].marketA.id).toBe('b')
      expect(pairs[2].marketB.id).toBe('c')
    })

    it('generates 0 pairs for 1 market', () => {
      const analyzer = new EventAnalyzer()
      const group = makeGroup([makeMarket({ id: 'only' })])
      expect(analyzer.generatePairs(group)).toHaveLength(0)
    })

    it('generates 6 pairs for 4 markets', () => {
      const analyzer = new EventAnalyzer()
      const markets = Array.from({ length: 4 }, (_, i) => makeMarket({ id: `m${i}` }))
      const group = makeGroup(markets)
      expect(analyzer.generatePairs(group)).toHaveLength(6) // C(4,2) = 6
    })
  })

  describe('filterCandidates', () => {
    it('filters by liquidity threshold', () => {
      const analyzer = new EventAnalyzer()
      const groups: MarketGroup[] = [
        makeGroup([makeMarket({ liquidity: 3000 }), makeMarket({ liquidity: 3000 })]),
        makeGroup([makeMarket({ liquidity: 8000 }), makeMarket({ liquidity: 8000 })]),
      ]
      groups[0].totalLiquidity = 6000
      groups[1].totalLiquidity = 16000

      const filtered = analyzer.filterCandidates(groups, 10_000)
      expect(filtered).toHaveLength(1)
      expect(filtered[0].totalLiquidity).toBe(16000)
    })

    it('filters by minimum markets', () => {
      const analyzer = new EventAnalyzer()
      const groups: MarketGroup[] = [
        { ...makeGroup([makeMarket()]), activeCount: 1 },
        { ...makeGroup([makeMarket(), makeMarket()]), activeCount: 2 },
      ]

      const filtered = analyzer.filterCandidates(groups, 0, 2)
      expect(filtered).toHaveLength(1)
      expect(filtered[0].activeCount).toBe(2)
    })
  })

  describe('findGroupForMarket', () => {
    it('returns undefined for unknown market', () => {
      const analyzer = new EventAnalyzer()
      expect(analyzer.findGroupForMarket('unknown-id')).toBeUndefined()
    })
  })
})

// ==========================================
// DependencyClassifier Tests
// ==========================================

describe('DependencyClassifier', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  describe('getMutexPartners', () => {
    it('returns mutex partners above confidence threshold', () => {
      const classifier = new DependencyClassifier({ confidenceThreshold: 0.75 })
      const marketA = makeMarket({ id: 'a' })
      const marketB = makeMarket({ id: 'b' })
      const marketC = makeMarket({ id: 'c' })

      const graph: DependencyGraph = {
        eventId: 'evt-1',
        eventTitle: 'Test',
        markets: new Map([
          ['a', marketA],
          ['b', marketB],
          ['c', marketC],
        ]),
        edges: [
          {
            marketIdA: 'a', marketIdB: 'b',
            type: 'mutex', confidence: 0.90, reasoning: 'Same race', classifiedAt: Date.now(),
          },
          {
            marketIdA: 'a', marketIdB: 'c',
            type: 'mutex', confidence: 0.50, reasoning: 'Maybe related', classifiedAt: Date.now(),
          },
        ],
        cachedAt: Date.now(),
      }

      const partners = classifier.getMutexPartners('a', graph)
      expect(partners).toHaveLength(1) // Only 'b' (0.90 > 0.75)
      expect(partners[0].partner.id).toBe('b')
      expect(partners[0].dependency.confidence).toBe(0.90)
    })

    it('returns empty for market with no mutex edges', () => {
      const classifier = new DependencyClassifier()
      const graph: DependencyGraph = {
        eventId: 'evt-1',
        eventTitle: 'Test',
        markets: new Map([['a', makeMarket({ id: 'a' })]]),
        edges: [{
          marketIdA: 'a', marketIdB: 'x',
          type: 'independent', confidence: 0.95, reasoning: '', classifiedAt: Date.now(),
        }],
        cachedAt: Date.now(),
      }

      expect(classifier.getMutexPartners('a', graph)).toHaveLength(0)
    })

    it('handles both directions of edge lookup', () => {
      const classifier = new DependencyClassifier({ confidenceThreshold: 0.5 })
      const marketA = makeMarket({ id: 'a' })
      const marketB = makeMarket({ id: 'b' })

      const graph: DependencyGraph = {
        eventId: 'evt-1',
        eventTitle: 'Test',
        markets: new Map([['a', marketA], ['b', marketB]]),
        edges: [{
          marketIdA: 'b', marketIdB: 'a', // B→A direction
          type: 'mutex', confidence: 0.85, reasoning: '', classifiedAt: Date.now(),
        }],
        cachedAt: Date.now(),
      }

      // Should still find when querying from 'a'
      const partners = classifier.getMutexPartners('a', graph)
      expect(partners).toHaveLength(1)
      expect(partners[0].partner.id).toBe('b')
    })
  })

  describe('getDependentEdges', () => {
    it('filters out independent and low-confidence edges', () => {
      const classifier = new DependencyClassifier({ confidenceThreshold: 0.75 })
      const graph: DependencyGraph = {
        eventId: 'evt-1',
        eventTitle: 'Test',
        markets: new Map(),
        edges: [
          { marketIdA: 'a', marketIdB: 'b', type: 'mutex', confidence: 0.90, reasoning: '', classifiedAt: Date.now() },
          { marketIdA: 'a', marketIdB: 'c', type: 'independent', confidence: 0.95, reasoning: '', classifiedAt: Date.now() },
          { marketIdA: 'b', marketIdB: 'c', type: 'conditional', confidence: 0.50, reasoning: '', classifiedAt: Date.now() },
        ],
        cachedAt: Date.now(),
      }

      const deps = classifier.getDependentEdges(graph)
      expect(deps).toHaveLength(1) // Only the mutex edge with 0.90 confidence
      expect(deps[0].type).toBe('mutex')
    })
  })

  describe('setConfig', () => {
    it('updates confidence threshold', () => {
      const classifier = new DependencyClassifier({ confidenceThreshold: 0.75 })
      const graph: DependencyGraph = {
        eventId: 'evt-1',
        eventTitle: 'Test',
        markets: new Map([
          ['a', makeMarket({ id: 'a' })],
          ['b', makeMarket({ id: 'b' })],
        ]),
        edges: [{
          marketIdA: 'a', marketIdB: 'b',
          type: 'mutex', confidence: 0.60, reasoning: '', classifiedAt: Date.now(),
        }],
        cachedAt: Date.now(),
      }

      // Initially below threshold
      expect(classifier.getMutexPartners('a', graph)).toHaveLength(0)

      // Lower threshold
      classifier.setConfig({ confidenceThreshold: 0.50 })
      expect(classifier.getMutexPartners('a', graph)).toHaveLength(1)
    })
  })

  describe('cache management', () => {
    it('returns undefined for uncached graph', () => {
      const classifier = new DependencyClassifier()
      expect(classifier.getCachedGraph('nonexistent')).toBeUndefined()
    })

    it('clearCache removes all entries', () => {
      const classifier = new DependencyClassifier()
      classifier.clearCache()
      expect(classifier.getCachedGraph('any')).toBeUndefined()
    })
  })
})
