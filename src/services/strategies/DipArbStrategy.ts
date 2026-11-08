import type { ArbRound, DipArbConfig } from '@/types'
import { ShelvedStrategy } from './ShelvedStrategy'

/**
 * Defaults preserved from the legacy implementation so persisted settings and
 * the Settings panel keep their meaning across the port.
 */
const DEFAULT_CONFIG: DipArbConfig = {
  shares: 5,
  sumTarget: 0.96,
  dipThreshold: 0.05,
  slidingWindowMs: 30000,
  targetResolutionMinutes: 15,
  minVolume: 50,
  maxConcurrentTrades: 2,
  cooldownMs: 30000,
  spreadScanEnabled: true,
  spreadScanIntervalMs: 15_000,
  spreadScanBatchSize: 150,
}

/**
 * Dip Arbitrage Strategy — SHELVED pending Polymarket US port.
 *
 * The legacy implementation bought both outcomes when YES+NO < $1 and merged
 * the pair on-chain for a guaranteed profit. On Polymarket US there is no
 * on-chain merge; the equivalent is buy-long + buy-short on one market slug
 * held to resolution. That port has not been done yet, so this shell keeps the
 * strategy id and settings surface but never trades.
 */
export class DipArbStrategy extends ShelvedStrategy {
  name = 'Dip Arbitrage'
  description = 'Two-leg arbitrage: buys both outcomes when YES+NO < $1 (not yet available on Polymarket US)'
  strategyType = 'arbitrage' as const
  readonly legacyRef = '9eb00b9:src/services/strategies/DipArbStrategy.ts'

  private dipConfig: DipArbConfig = DEFAULT_CONFIG

  constructor(config?: Partial<DipArbConfig>) {
    super()
    if (config) this.dipConfig = { ...DEFAULT_CONFIG, ...config }
    this._config = { enabled: false, ...this.dipConfig }
  }

  getDipConfig(): DipArbConfig {
    return { ...this.dipConfig }
  }

  setDipConfig(config: Partial<DipArbConfig>): void {
    this.dipConfig = { ...this.dipConfig, ...config }
    this._config = { ...this._config, ...this.dipConfig }
    this.emit('configUpdated', this.dipConfig)
  }

  getArbRounds(): ArbRound[] {
    return []
  }

  getArbStats(): { rounds: number; completed: number; failed: number; totalProfit: number } {
    return { rounds: 0, completed: 0, failed: 0, totalProfit: 0 }
  }
}

export const dipArbStrategy = new DipArbStrategy()
