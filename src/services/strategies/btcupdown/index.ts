export {
  computeSignal,
  computeVolatility,
  classifyRegime,
  computeRSI,
  linearRegressionSlope,
  computeOrderbookImbalance,
} from './signalEngine'
export type { SignalInput, Signal, SignalEngineConfig } from './signalEngine'

export { BacktestRunner, backtestRunner } from './BacktestRunner'
export type { BacktestOptions } from './BacktestRunner'

export { HistoricalEnrichment, historicalEnrichment } from './HistoricalEnrichment'
