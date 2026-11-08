import type { ArbRound, DipArbConfig } from '@/types'
import { ShelvedStrategy } from './ShelvedStrategy'

/** Defaults kept so persisted settings and the Settings panel keep their meaning */
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
  marketRefreshMs: 60_000,
  askPremium: 0.01,
  stopLossPercent: 0.20,
  takeProfitPercent: 0.10,
}

/**
 * Dip Arbitrage Strategy — SHELVED on Polymarket US.
 *
 * The legacy strategy bought YES and NO of one question when their asks
 * summed below $1 (international CLOB: two token books, merged on-chain).
 *
 * On Polymarket US each market is a single YES-quoted book, so YES + NO on
 * one market always costs at least $1 plus the spread: there is nothing to
 * buy below par. The cross-market variant (buy YES on every market of an
 * event) is only riskless when the event's markets are mutually exclusive
 * AND exhaustive, and the gateway does not say so — live events include
 * nested markets ("BTC hits $150k before December" / "before January") and
 * partial lists. Buying YES on both nested markets loses both stakes if
 * neither happens. Until an event can be verified as a complete partition,
 * this strategy stays shelved.
 *
 * The two-leg implementation (WS detection, FOK legs, unwind, hold to
 * resolution) is preserved at `legacyRef` for that future port.
 */
export class DipArbStrategy extends ShelvedStrategy {
  name = 'Dip Arbitrage'
  description = 'Two-leg arbitrage below $1 — shelved: Polymarket US does not mark which events are complete, exclusive outcome sets'
  strategyType = 'arbitrage' as const
  readonly legacyRef = 'f614500:src/services/strategies/DipArbStrategy.ts'

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
