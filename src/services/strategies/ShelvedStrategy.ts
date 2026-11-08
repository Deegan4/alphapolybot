import { BaseStrategy } from './BaseStrategy'
import { activityLogger } from '@/services/trading/ActivityLogger'

/**
 * ShelvedStrategy — base for strategies whose implementation targeted the
 * international Polymarket CLOB (token IDs, Gamma/Data APIs, on-chain merge)
 * and has not been ported to Polymarket US yet.
 *
 * The shell keeps the strategy's id, metadata and settings surface so persisted
 * settings and the Settings UI keep working, but it never trades: start() and
 * enable() log why and leave the strategy disabled. StrategyManager exposes
 * `available: false` so the dashboard hides the toggle.
 *
 * Reference implementations live in git history, e.g.
 *   git show <legacyRef>
 */
export abstract class ShelvedStrategy extends BaseStrategy {
  /** Always false for shelved strategies — hides the toggle in the UI */
  override readonly available: boolean = false

  /** `<commit>:<path>` of the legacy implementation, for the port */
  abstract readonly legacyRef: string

  async initialize(): Promise<void> {
    this.setStatus('idle')
  }

  async start(): Promise<void> {
    const msg =
      `${this.name} is not available on Polymarket US yet — not started. ` +
      `(legacy CLOB implementation: git show ${this.legacyRef})`
    this.log(msg)
    activityLogger.logWarning(msg)
    this.setStatus('idle')
  }

  async stop(): Promise<void> {
    this.setStatus('idle')
  }

  /** Refuses to enable: logs the reason and stays disabled. */
  override async enable(): Promise<void> {
    await this.start()
    this._enabled = false
    this._config.enabled = false
    this.emit('disabled', null)
  }
}
