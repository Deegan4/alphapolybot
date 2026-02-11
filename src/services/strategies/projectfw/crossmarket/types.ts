import type { Market } from '@/types'
import type { ArbOpportunity } from '../types'

// ==========================================
// CROSS-MARKET DEPENDENCY TYPES
// ==========================================

/** How two markets relate logically */
export type DependencyType =
  | 'independent'    // No relationship
  | 'mutex'          // At most one YES (e.g., Trump wins PA ⊕ Harris wins PA)
  | 'conditional'    // A implies B (e.g., GOP wins by 5+ → GOP wins)
  | 'complementary'  // Exactly one must be YES (binary flip)

/** A classified relationship between two markets */
export interface MarketDependency {
  marketIdA: string
  marketIdB: string
  type: DependencyType
  /** LLM confidence 0-1 */
  confidence: number
  /** LLM reasoning for the classification */
  reasoning: string
  /** When this was classified */
  classifiedAt: number
}

/** Event-scoped graph of all market dependencies */
export interface DependencyGraph {
  eventId: string
  eventTitle: string
  /** Market ID → Market */
  markets: Map<string, Market>
  /** All classified edges */
  edges: MarketDependency[]
  /** When the graph was built */
  cachedAt: number
}

/** A group of related markets from a single event */
export interface MarketGroup {
  eventId: string
  eventTitle: string
  markets: Market[]
  /** Combined liquidity across all markets in the group */
  totalLiquidity: number
  /** Number of active markets */
  activeCount: number
}

// ==========================================
// VALIDATION RESULT TYPES
// ==========================================

/** Result of checking price coherence for mutex markets */
export interface CoherenceResult {
  isCoherent: boolean
  /** Expected sum of YES prices across mutex markets */
  expectedSum: number
  /** Actual sum of YES prices */
  actualSum: number
  /** abs(actual - expected) */
  incoherence: number
  /** Direction of mispricing */
  signal: 'overpriced' | 'underpriced' | 'coherent'
}

/** Cross-market validation attached to an arb opportunity */
export interface MutexValidation {
  /** Whether validation was performed */
  isValidated: boolean
  /** The mutex partner market (if found) */
  mutexPartner?: Market
  /** Combined YES price sum across mutex markets */
  combinedPriceSum?: number
  /** Magnitude of price incoherence */
  incoherence?: number
  /** Human-readable explanation */
  reasoning: string
}

/** ArbOpportunity enhanced with cross-market validation metadata */
export interface CrossMarketOpportunity extends ArbOpportunity {
  /** Related markets discovered via dependency analysis */
  relatedMarkets: Market[]
  /** Mutex validation result */
  mutexValidation: MutexValidation
}
