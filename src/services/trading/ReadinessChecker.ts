/**
 * ReadinessChecker — Pre-flight validation for live trading.
 *
 * Checks credentials, balance, strategies, and connectivity.
 * Used by ReadinessPanel to show an actionable setup checklist.
 *
 * Uses top-level imports for stores/services. This is safe because
 * ReadinessChecker is a leaf node — only UI components import it.
 */

import { useWalletStore } from '@/stores/walletStore'
import { useSettingsStore } from '@/stores/settingsStore'
import { polymarketClient } from '@/services/api'
import { strategyManager } from '@/services/strategies'
import { realtimeService } from '@/services/realtime'

export type CheckSeverity = 'critical' | 'warn' | 'info'
export type CheckStatus = 'pass' | 'fail' | 'warn' | 'info'

export interface ReadinessCheck {
  id: string
  label: string
  status: CheckStatus
  detail: string
  severity: CheckSeverity
  action?: { label: string; route: string }
}

export interface ReadinessReport {
  checks: ReadinessCheck[]
  allCriticalPass: boolean
  failCount: number
  warnCount: number
}

class ReadinessCheckerService {
  private _testOrderResult: { success: boolean; error?: string } | null = null

  /** Cache result from a successful/failed test order */
  setTestOrderResult(result: { success: boolean; error?: string }) {
    this._testOrderResult = result
  }

  getTestOrderResult() {
    return this._testOrderResult
  }

  /** Run all readiness checks. Safe to call frequently (no network calls). */
  getReport(): ReadinessReport {
    const checks: ReadinessCheck[] = []

    // 1. Wallet connected
    try {
      const walletState = useWalletStore.getState()
      checks.push({
        id: 'credentials',
        label: 'Wallet connected',
        severity: 'critical',
        status: walletState.isConnected ? 'pass' : 'fail',
        detail: walletState.isConnected
          ? `Address: ${walletState.address?.slice(0, 10)}...`
          : 'No wallet connected',
        action: walletState.isConnected ? undefined : { label: 'Connect', route: '/settings' },
      })

      // 2. USD balance
      const balance = walletState.balance ?? 0
      checks.push({
        id: 'usd_balance',
        label: 'USDC.e balance',
        severity: 'critical',
        status: balance > 0 ? 'pass' : 'fail',
        detail: balance > 0 ? `$${balance.toFixed(2)}` : 'No USDC.e balance — deposit on Polygon',
        action: balance > 0 ? undefined : { label: 'Check balance', route: '/settings' },
      })

      // 3. Buying power
      const buyingPower = walletState.buyingPower ?? 0
      if (walletState.isConnected) {
        checks.push({
          id: 'buying_power',
          label: 'Buying power',
          severity: 'warn',
          status: buyingPower > 1 ? 'pass' : 'warn',
          detail: buyingPower > 1 ? `$${buyingPower.toFixed(2)} available` : 'Low buying power — close positions or deposit',
        })
      }
    } catch {
      checks.push({
        id: 'credentials',
        label: 'Wallet connected',
        severity: 'critical',
        status: 'fail',
        detail: 'Wallet store unavailable',
      })
    }

    // 4. CLOB API credentials derived
    {
      const hasCreds = polymarketClient.hasCredentials()
      checks.push({
        id: 'api_creds',
        label: 'CLOB API credentials',
        severity: 'critical',
        status: hasCreds ? 'pass' : 'fail',
        detail: hasCreds
          ? 'HMAC credentials derived from wallet'
          : 'Connect wallet to derive CLOB API credentials',
        action: hasCreds ? undefined : { label: 'Connect wallet', route: '/settings' },
      })
    }

    // 5. OpenRouter API key (warn only)
    try {
      const settings = useSettingsStore.getState()
      const hasKey = !!settings.openRouterApiKey
      checks.push({
        id: 'openrouter_key',
        label: 'OpenRouter API key',
        severity: 'warn',
        status: hasKey ? 'pass' : 'warn',
        detail: hasKey ? 'API key set' : 'Needed for LLM Prediction strategy',
        action: hasKey ? undefined : { label: 'Add key', route: '/settings' },
      })
    } catch {
      // Skip if store unavailable
    }

    // 6. At least 1 strategy enabled
    {
      const states = strategyManager.getStates()
      const anyEnabled = states.some(s => s.enabled)
      const anyRunning = states.some(s => s.status === 'running')
      checks.push({
        id: 'strategies',
        label: 'Strategies enabled',
        severity: 'warn',
        status: anyRunning ? 'pass' : anyEnabled ? 'warn' : 'warn',
        detail: anyRunning
          ? `${states.filter(s => s.status === 'running').length} running`
          : anyEnabled
            ? 'Enabled but not running — start from dropdown'
            : 'No strategies enabled',
      })
    }

    // 7. WebSocket connected
    {
      const wsConnected = realtimeService.isConnected()
      checks.push({
        id: 'websocket',
        label: 'WebSocket connected',
        severity: 'warn',
        status: wsConnected ? 'pass' : 'warn',
        detail: wsConnected ? 'Receiving market data' : 'Not connected — connects when strategies start',
      })
    }

    // 8. Dry run status (info)
    try {
      const { dryRun } = useSettingsStore.getState()
      checks.push({
        id: 'dry_run',
        label: 'Trading mode',
        severity: 'info',
        status: dryRun ? 'info' : 'pass',
        detail: dryRun ? 'SIMULATION — no real orders' : 'LIVE — real orders will be placed',
      })
    } catch {
      // Skip
    }

    // 9. Penny trader mode (info)
    try {
      const { pennyTraderMode } = useSettingsStore.getState()
      checks.push({
        id: 'penny_mode',
        label: 'Position sizing',
        severity: 'info',
        status: 'info',
        detail: pennyTraderMode ? '$1 trades (penny mode)' : 'Kelly-sized trades',
      })
    } catch {
      // Skip
    }

    const failCount = checks.filter(c => c.status === 'fail').length
    const warnCount = checks.filter(c => c.status === 'warn').length
    const allCriticalPass = checks
      .filter(c => c.severity === 'critical')
      .every(c => c.status === 'pass')

    return { checks, allCriticalPass, failCount, warnCount }
  }
}

export const readinessChecker = new ReadinessCheckerService()
