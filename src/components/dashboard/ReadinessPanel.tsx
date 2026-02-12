import React, { useEffect, useState, useCallback } from 'react'
import { readinessChecker, type ReadinessReport, type ReadinessCheck } from '@/services/trading/ReadinessChecker'
import { useSettingsStore } from '@/stores'
import { strategyManager } from '@/services/strategies'

/**
 * ReadinessPanel — Pre-flight checklist for live trading.
 * Shows in the left column when critical checks are failing.
 * Collapses to a compact badge when everything passes.
 */
export const ReadinessPanel: React.FC = () => {
  const [report, setReport] = useState<ReadinessReport>(readinessChecker.getReport())
  const [showGoLiveConfirm, setShowGoLiveConfirm] = useState(false)
  const [quickStartDone, setQuickStartDone] = useState(false)

  // Poll every 2s
  useEffect(() => {
    const tick = () => setReport(readinessChecker.getReport())
    tick()
    const id = setInterval(tick, 2000)
    return () => clearInterval(id)
  }, [])

  const handleGoLive = useCallback(() => {
    useSettingsStore.getState().setDryRun(false)
    setShowGoLiveConfirm(false)
  }, [])

  const handleQuickStart = useCallback(() => {
    // Enable LLM Prediction + BTC Up/Down
    const states = strategyManager.getStates()
    for (const s of states) {
      if (s.id === 'llm-prediction' || s.id === 'btc-updown') {
        if (!s.enabled) strategyManager.toggleStrategy(s.id)
      }
    }
    // Enable BTC asset
    useSettingsStore.getState().setBtcEnableBtc(true)
    setQuickStartDone(true)
  }, [])

  // Compact badge when all critical checks pass and not many warnings
  if (report.allCriticalPass && report.warnCount <= 1) {
    return (
      <div className="mx-1 mb-2 px-3 py-1.5 rounded bg-green-950/30 border border-green-500/20 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="w-2 h-2 bg-green-500 rounded-full" />
          <span className="text-[10px] font-mono font-bold text-green-400">READY</span>
        </div>
        {useSettingsStore.getState().dryRun && (
          <button
            onClick={() => setShowGoLiveConfirm(true)}
            className="text-[10px] font-mono font-bold text-agent-cyan border border-agent-cyan/30 hover:bg-agent-cyan/10 rounded px-2 py-0.5 transition-colors"
          >
            GO LIVE
          </button>
        )}
        {showGoLiveConfirm && (
          <GoLiveConfirmDialog onConfirm={handleGoLive} onCancel={() => setShowGoLiveConfirm(false)} />
        )}
      </div>
    )
  }

  // Full checklist
  return (
    <div className="mx-1 mb-2 rounded bg-agent-card border border-agent-border overflow-hidden">
      {/* Header */}
      <div className="px-3 py-2 border-b border-agent-border flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="w-2 h-2 bg-yellow-500 rounded-full animate-pulse" />
          <span className="text-[11px] font-mono font-bold text-yellow-400">
            SETUP ({report.failCount} issue{report.failCount !== 1 ? 's' : ''})
          </span>
        </div>
        {!quickStartDone && (
          <button
            onClick={handleQuickStart}
            className="text-[10px] font-mono font-bold text-agent-cyan border border-agent-cyan/30 hover:bg-agent-cyan/10 rounded px-2 py-0.5 transition-colors"
          >
            Quick Start
          </button>
        )}
      </div>

      {/* Checks */}
      <div className="p-2 space-y-1">
        {report.checks.map(check => (
          <CheckRow key={check.id} check={check} />
        ))}
      </div>

      {/* Go Live button — only when all critical pass */}
      {report.allCriticalPass && (
        <div className="px-3 py-2 border-t border-agent-border">
          {showGoLiveConfirm ? (
            <GoLiveConfirmDialog onConfirm={handleGoLive} onCancel={() => setShowGoLiveConfirm(false)} />
          ) : (
            <button
              onClick={() => setShowGoLiveConfirm(true)}
              className="w-full text-[11px] font-mono font-bold text-green-400 border border-green-500/30 hover:bg-green-500/10 rounded py-1.5 transition-colors"
            >
              GO LIVE
            </button>
          )}
        </div>
      )}
    </div>
  )
}

const CheckRow: React.FC<{ check: ReadinessCheck }> = ({ check }) => {
  const dotColor = {
    pass: 'bg-green-500',
    fail: 'bg-red-500',
    warn: 'bg-yellow-500',
    info: 'bg-agent-cyan',
  }[check.status]

  const textColor = {
    pass: 'text-green-400',
    fail: 'text-red-400',
    warn: 'text-yellow-400',
    info: 'text-agent-cyan',
  }[check.status]

  return (
    <div className="flex items-center gap-2 px-1 py-0.5">
      <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${dotColor}`} />
      <span className={`text-[10px] font-mono ${textColor} min-w-0 truncate`}>
        {check.label}
      </span>
      <span className="text-[9px] font-mono text-agent-text-muted flex-1 truncate text-right">
        {check.detail}
      </span>
      {check.action && (
        <a
          href={check.action.route}
          className="text-[9px] font-mono font-bold text-agent-cyan hover:underline shrink-0"
        >
          {check.action.label}
        </a>
      )}
    </div>
  )
}

const GoLiveConfirmDialog: React.FC<{ onConfirm: () => void; onCancel: () => void }> = ({
  onConfirm,
  onCancel,
}) => (
  <div className="flex items-center gap-2">
    <span className="text-[10px] font-mono text-yellow-400">Real orders will be placed.</span>
    <button
      onClick={onConfirm}
      className="text-[10px] font-mono font-bold text-white bg-green-600 hover:bg-green-500 rounded px-2 py-0.5 transition-colors"
    >
      Confirm
    </button>
    <button
      onClick={onCancel}
      className="text-[10px] font-mono text-agent-text-muted hover:text-agent-text px-1 transition-colors"
    >
      Cancel
    </button>
  </div>
)
