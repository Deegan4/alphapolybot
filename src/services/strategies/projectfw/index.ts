// ArbitrageScanner (CLOB-era market scanning/execution) was retired with the
// Polymarket US migration; see ProjectFWStrategy for the port status.
export { FrankWolfeOptimizer } from './FrankWolfeOptimizer'
export type {
  TradeVertex,
  FWOptimizationResult,
  TradeLeg,
  MarketSnapshot,
  ArbOpportunity,
  FWOptimizerConfig,
} from './types'

// Cross-market combinatorial arbitrage
export { EventAnalyzer, DependencyClassifier, MutexValidator } from './crossmarket'
export type {
  DependencyType,
  MarketDependency,
  DependencyGraph,
  MarketGroup,
  CoherenceResult,
  MutexValidation,
  CrossMarketOpportunity,
} from './crossmarket'
