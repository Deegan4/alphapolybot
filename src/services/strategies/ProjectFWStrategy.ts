import type { FWArbRound, ProjectFWConfig } from '@/types'
import { ShelvedStrategy } from './ShelvedStrategy'

/**
 * Defaults preserved from the legacy implementation so persisted settings and
 * the Settings panel keep their meaning across the port.
 */
const DEFAULT_CONFIG: ProjectFWConfig = {
  // Algorithm parameters
  alpha: 0.5,
  epsilonD: 0.001,
  epsilon0: 0.1,
  maxIterations: 50,
  // Trading parameters
  tradeSize: 5,
  minProfitBps: 30,
  maxConcurrentArbs: 2,
  scanIntervalMs: 30000,
  cooldownMs: 60000,
  // Fee model
  takerFeeBps: 100,
  gasEstimateUSD: 0.01,
  // Market filters
  minLiquidity: 50,
  minVolume24h: 10,
  maxSpreadBps: 500,
  // Multi-outcome
  enableMultiOutcome: false,
  // Safety
  stopLossPercent: 0.15,
  takeProfitPercent: 0.10,
  // Cross-market analysis
  enableCrossMarket: false,
  crossMarketBudgetUSD: 0.25,
  mutexConfidenceThreshold: 0.75,
  crossMarketCacheTTL: 3_600_000,
  maxPairsPerLLMCall: 10,
  minEventLiquidity: 10_000,
}

/**
 * ProjectFW Arbitrage Strategy — SHELVED pending Polymarket US port.
 *
 * The Frank-Wolfe optimizer and cross-market analysis modules under
 * `./projectfw/` are exchange-agnostic and remain in the tree (and tested).
 * The market scanner / execution layer targeted the international CLOB
 * (ArbitrageScanner) and must be rebuilt on polymarketUSClient before this
 * strategy can trade again. Until then this shell keeps the strategy id and
 * settings surface but never trades.
 */
export class ProjectFWStrategy extends ShelvedStrategy {
  name = 'ProjectFW Arb'
  description = 'Frank-Wolfe optimized arbitrage: detects price incoherence via KL divergence (not yet available on Polymarket US)'
  strategyType = 'arbitrage' as const
  readonly legacyRef = '9eb00b9:src/services/strategies/ProjectFWStrategy.ts'

  private fwConfig: ProjectFWConfig = DEFAULT_CONFIG

  constructor(config?: Partial<ProjectFWConfig>) {
    super()
    if (config) this.fwConfig = { ...DEFAULT_CONFIG, ...config }
    this._config = { enabled: false, ...this.fwConfig }
  }

  setCrossMarket(enabled: boolean): void {
    this.setFWConfig({ enableCrossMarket: enabled })
  }

  getFWConfig(): ProjectFWConfig {
    return { ...this.fwConfig }
  }

  setFWConfig(config: Partial<ProjectFWConfig>): void {
    this.fwConfig = { ...this.fwConfig, ...config }
    this._config = { ...this._config, ...this.fwConfig }
    this.emit('configUpdated', this.fwConfig)
  }

  getArbRounds(): FWArbRound[] {
    return []
  }

  getArbStats(): { rounds: number; completed: number; failed: number; totalProfit: number } {
    return { rounds: 0, completed: 0, failed: 0, totalProfit: 0 }
  }
}

export const projectFWStrategy = new ProjectFWStrategy()
