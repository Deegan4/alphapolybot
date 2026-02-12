/**
 * ReadinessChecker — Pre-flight validation for live trading.
 *
 * Checks wallet, balance, credentials, strategies, and connectivity.
 * Used by ReadinessPanel to show an actionable setup checklist.
 *
 * Zero dependencies on stores at import time — uses dynamic getState()
 * calls at check time only.
 */

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
      const { useWalletStore } = require('@/stores/walletStore')
      const walletState = useWalletStore.getState()
      checks.push({
        id: 'wallet',
        label: 'Wallet connected',
        severity: 'critical',
        status: walletState.isConnected ? 'pass' : 'fail',
        detail: walletState.isConnected
          ? `${walletState.address?.slice(0, 6)}...${walletState.address?.slice(-4)}`
          : 'No wallet connected',
        action: walletState.isConnected ? undefined : { label: 'Connect', route: '/settings' },
      })

      // 2. USDC.e balance
      const usdcBal = walletState.usdcBridgedBalance ?? 0
      checks.push({
        id: 'usdc_balance',
        label: 'USDC.e balance',
        severity: 'critical',
        status: usdcBal > 0 ? 'pass' : 'fail',
        detail: usdcBal > 0 ? `$${usdcBal.toFixed(2)}` : 'No USDC.e — fund wallet with bridged USDC',
        action: usdcBal > 0 ? undefined : { label: 'Check wallet', route: '/settings' },
      })

      // 3. MATIC for gas
      const maticBal = walletState.balance ?? 0
      checks.push({
        id: 'matic_balance',
        label: 'MATIC for gas',
        severity: 'critical',
        status: maticBal > 0.01 ? 'pass' : 'fail',
        detail: maticBal > 0.01 ? `${maticBal.toFixed(4)} MATIC` : 'Need >0.01 MATIC for gas fees',
        action: maticBal > 0.01 ? undefined : { label: 'Check wallet', route: '/settings' },
      })
    } catch {
      checks.push({
        id: 'wallet',
        label: 'Wallet connected',
        severity: 'critical',
        status: 'fail',
        detail: 'Wallet store unavailable',
      })
    }

    // 4. CLOB credentials
    try {
      const { clobClient } = require('@/services/api')
      const creds = clobClient.getCredentials()
      checks.push({
        id: 'clob_creds',
        label: 'CLOB credentials',
        severity: 'critical',
        status: creds ? 'pass' : 'fail',
        detail: creds ? 'API key derived' : 'Credentials not derived — connect wallet first',
        action: creds ? undefined : { label: 'Connect wallet', route: '/settings' },
      })
    } catch {
      checks.push({
        id: 'clob_creds',
        label: 'CLOB credentials',
        severity: 'critical',
        status: 'fail',
        detail: 'CLOB client unavailable',
      })
    }

    // 5. OpenRouter API key (warn only)
    try {
      const { useSettingsStore } = require('@/stores/settingsStore')
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
    try {
      const { strategyManager } = require('@/services/strategies')
      const states = strategyManager.getStates()
      const anyEnabled = states.some((s: { enabled: boolean }) => s.enabled)
      const anyRunning = states.some((s: { status: string }) => s.status === 'running')
      checks.push({
        id: 'strategies',
        label: 'Strategies enabled',
        severity: 'warn',
        status: anyRunning ? 'pass' : anyEnabled ? 'warn' : 'warn',
        detail: anyRunning
          ? `${states.filter((s: { status: string }) => s.status === 'running').length} running`
          : anyEnabled
            ? 'Enabled but not running — start from dropdown'
            : 'No strategies enabled',
      })
    } catch {
      // Skip if unavailable
    }

    // 7. WebSocket connected
    try {
      const { realtimeService } = require('@/services/realtime')
      const wsConnected = realtimeService.isConnected()
      checks.push({
        id: 'websocket',
        label: 'WebSocket connected',
        severity: 'warn',
        status: wsConnected ? 'pass' : 'warn',
        detail: wsConnected ? 'Receiving market data' : 'Not connected — connects when strategies start',
      })
    } catch {
      // Skip if unavailable
    }

    // 8. Dry run status (info)
    try {
      const { useSettingsStore } = require('@/stores/settingsStore')
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
      const { useSettingsStore } = require('@/stores/settingsStore')
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
