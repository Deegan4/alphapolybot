import React, { useEffect, useState } from 'react'
import { useSettingsStore, useWalletStore } from '@/stores'
import { riskManager, rejectionTracker, readinessChecker, positionLifecycleManager } from '@/services/trading'
import { polymarketUSClient } from '@/services/api'
import { realtimeService } from '@/services/realtime/RealtimeService'
import { strategyManager, type StrategyState } from '@/services/strategies'
import type { RejectionSummary } from '@/services/trading/RejectionTracker'

type Severity = 'red' | 'yellow' | 'cyan'

interface BannerState {
  severity: Severity
  message: string
  detail?: string
  action?: { label: string; onClick: () => void }
}

/**
 * DiagnosticsBanner — Conditional banner that surfaces the highest-priority
 * trade blocker. Disappears when healthy. Priority order:
 * 1. Emergency stop active (red)
 * 2. Wallet not connected (red)
 * 3. No strategies enabled/running (yellow)
 * 4. Dry run mode (cyan)
 * 5. All strategies hitting position limits (yellow)
 * 6. No trades in >30 min despite running (yellow) — shows rejection summary
 */
export const DiagnosticsBanner: React.FC = () => {
  const dryRun = useSettingsStore((s) => s.dryRun)
  const isConnected = useWalletStore((s) => s.isConnected)
  const [strategies, setStrategies] = useState<StrategyState[]>(strategyManager.getStates())
  const [rejections, setRejections] = useState<RejectionSummary>(rejectionTracker.getSummary())
  const [emergencyStopped, setEmergencyStopped] = useState(false)
  const [wsConnected, setWsConnected] = useState(realtimeService.isConnected())

  useEffect(() => {
    return strategyManager.subscribe(setStrategies)
  }, [])

  // Poll rejection summary + emergency stop + WS state every 3s
  useEffect(() => {
    const tick = () => {
      setRejections(rejectionTracker.getSummary())
      setEmergencyStopped(riskManager.getStatus().emergencyStopped)
      setWsConnected(realtimeService.isConnected())
    }
    tick()
    const id = setInterval(tick, 3000)
    return () => clearInterval(id)
  }, [])

  // Compute the banner to show (or null if healthy)
  const banner = computeBanner({
    emergencyStopped,
    isConnected,
    strategies,
    dryRun,
    rejections,
    pmCredentials: polymarketUSClient.hasCredentials(),
    wsConnected,
  })

  if (!banner) return null

  const borderColor = {
    red: 'border-l-red-500 bg-red-950/40',
    yellow: 'border-l-yellow-500 bg-yellow-950/30',
    cyan: 'border-l-agent-cyan bg-agent-cyan/5',
  }[banner.severity]

  const textColor = {
    red: 'text-red-400',
    yellow: 'text-yellow-400',
    cyan: 'text-agent-cyan',
  }[banner.severity]

  return (
    <div className={`mx-4 mt-3 px-4 py-2 rounded border-l-4 ${borderColor} flex items-center justify-between`}>
      <div className="flex items-center gap-3 min-w-0">
        <span className={`text-xs font-mono font-bold ${textColor} shrink-0`}>
          {banner.message}
        </span>
        {banner.detail && (
          <span className="text-[10px] font-mono text-agent-text-muted truncate">
            {banner.detail}
          </span>
        )}
      </div>
      {banner.action && (
        <button
          onClick={banner.action.onClick}
          className={`text-[10px] font-mono font-bold px-2 py-0.5 rounded ${textColor} border border-current/20 hover:bg-white/5 transition-colors shrink-0`}
        >
          {banner.action.label}
        </button>
      )}
    </div>
  )
}

function computeBanner(ctx: {
  emergencyStopped: boolean
  isConnected: boolean
  strategies: StrategyState[]
  dryRun: boolean
  rejections: RejectionSummary
  pmCredentials: boolean
  wsConnected: boolean
}): BannerState | null {
  // 1. Emergency stop (most critical)
  if (ctx.emergencyStopped) {
    return {
      severity: 'red',
      message: 'EMERGENCY STOP ACTIVE',
      detail: 'All trading halted. Reset in Settings > Risk Management.',
      action: {
        label: 'Go to Settings',
        onClick: () => { window.location.hash = ''; window.location.pathname = '/settings' },
      },
    }
  }

  // 2. Wallet not connected
  if (!ctx.isConnected) {
    return {
      severity: 'red',
      message: 'WALLET NOT CONNECTED',
      detail: 'Connect wallet in Settings to enable trading.',
      action: {
        label: 'Go to Settings',
        onClick: () => { window.location.hash = ''; window.location.pathname = '/settings' },
      },
    }
  }

  // 2b. Critical readiness checks failing (balance, credentials, etc.)
  const readiness = readinessChecker.getReport()
  if (!readiness.allCriticalPass && readiness.failCount > 0) {
    const firstFail = readiness.checks.find(c => c.status === 'fail')
    return {
      severity: 'yellow',
      message: `SETUP INCOMPLETE (${readiness.failCount})`,
      detail: firstFail?.detail ?? 'Check readiness panel for details',
      action: firstFail?.action ? {
        label: firstFail.action.label,
        onClick: () => { window.location.pathname = firstFail!.action!.route },
      } : undefined,
    }
  }

  // 3. No strategies enabled or running
  const anyRunning = ctx.strategies.some(s => s.status === 'running')
  const anyEnabled = ctx.strategies.some(s => s.enabled)
  if (!anyRunning && !anyEnabled) {
    return {
      severity: 'yellow',
      message: 'NO STRATEGIES ENABLED',
      detail: 'Enable and start strategies from the dropdown above.',
    }
  }
  if (!anyRunning && anyEnabled) {
    return {
      severity: 'yellow',
      message: 'STRATEGIES ENABLED BUT NOT RUNNING',
      detail: 'Start strategies from the dropdown above.',
    }
  }

  // 4. Dry run mode (informational, not blocking)
  if (ctx.dryRun) {
    return {
      severity: 'cyan',
      message: 'SIMULATION MODE',
      detail: 'Dry run enabled — no real orders will be placed. Disable in Settings.',
    }
  }

  // 5. Polymarket WS not connected — showing spot prices only
  if (!ctx.pmCredentials) {
    return {
      severity: 'cyan',
      message: 'PM WS NOT CONFIGURED',
      detail: 'Showing Binance spot prices. Add Polymarket US keys in Settings for live markets.',
      action: {
        label: 'Settings',
        onClick: () => { window.location.hash = ''; window.location.pathname = '/settings' },
      },
    }
  }
  if (ctx.pmCredentials && !ctx.wsConnected) {
    return {
      severity: 'yellow',
      message: 'PM WS DISCONNECTED',
      detail: 'Polymarket WebSocket offline — showing Binance spot prices as fallback.',
    }
  }

  // 6. High rejection rate — show top blocker with actionable resolution
  if (ctx.rejections.total > 10 && ctx.rejections.topBlocker) {
    const tb = ctx.rejections.topBlocker
    const countStr = Object.entries(ctx.rejections.counts)
      .sort(([, a], [, b]) => (b ?? 0) - (a ?? 0))
      .slice(0, 3)
      .map(([cat, n]) => `${cat}: ${n}`)
      .join(' · ')

    // Offer "Clean Stale" action when position_limit is the top blocker
    let action: BannerState['action'] = undefined
    if (tb.category === 'position_limit') {
      const stalePositions = positionLifecycleManager.getPositions().filter(p => p.isStale)
      if (stalePositions.length > 0) {
        action = {
          label: `Clean ${stalePositions.length} Stale`,
          onClick: () => {
            for (const p of stalePositions) {
              positionLifecycleManager.abandonPosition(p.tokenId)
            }
          },
        }
      }
    }

    return {
      severity: 'yellow',
      message: `TOP BLOCKER: ${tb.category.toUpperCase()}`,
      detail: `${ctx.rejections.total} rejections in 1h — ${countStr}`,
      action,
    }
  }

  // No issues — banner hidden
  return null
}
