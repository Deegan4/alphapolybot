export { FrankWolfeOptimizer } from './FrankWolfeOptimizer'
export { ArbitrageScanner } from './ArbitrageScanner'
export type {
  TradeVertex,
  FWOptimizationResult,
  TradeLeg,
  MarketSnapshot,
  ArbOpportunity,
  FWOptimizerConfig,
} from './types'
export type { ScannerConfig, ScanResult, RejectionStats } from './ArbitrageScanner'

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
