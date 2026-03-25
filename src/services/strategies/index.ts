export { BaseStrategy } from './BaseStrategy'
export { DipDetector, dipDetector, type DipEvent } from './DipDetector'
export { StrategyManager, strategyManager, type StrategyState } from './StrategyManager'

// Strategy classes/singletons are NOT re-exported here to enable code-splitting.
// StrategyManager lazy-loads them via dynamic import() during initialize().
// Consumers that need a typed strategy reference should import directly:
//   import { llmPredictionStrategy } from './LLMPredictionStrategy'
