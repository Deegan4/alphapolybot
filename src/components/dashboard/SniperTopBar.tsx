import React, { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { WindowTimer } from './WindowTimer'
import { StrategyDropdown } from './StrategyDropdown'
import { useWalletStore, useSettingsStore } from '@/stores'
import { strategyManager, type StrategyState } from '@/services/strategies'
import { tradeLogger, rejectionTracker, positionLifecycleManager, tradingService } from '@/services/trading'
import { btcUpDownStrategy } from '@/services/strategies/BtcUpDownStrategy'
import type { BacktestSummary } from '@/services/trading/TradeLogger'

interface SniperTopBarProps {
  activeTab: 'live' | 'history' | 'spotcrypto'
  onTabChange: (tab: 'live' | 'history' | 'spotcrypto') => void
}

export const SniperTopBar: React.FC<SniperTopBarProps> = ({ activeTab, onTabChange }) => {
  const balance = useWalletStore((s) => s.usdcBalance)
  const { dryRun, setDryRun } = useSettingsStore()
  const [confirmLive, setConfirmLive] = useState(false)
  const [strategies, setStrategies] = useState<StrategyState[]>(strategyManager.getStates())
  const [summary, setSummary] = useState<BacktestSummary>(tradeLogger.getSummary())
  const [window, setWindow] = useState(btcUpDownStrategy.getActiveWindow())

  useEffect(() => {
    return strategyManager.subscribe(setStrategies)
  }, [])

  const [rejectionTotal, setRejectionTotal] = useState(0)
  const [rejectionTooltip, setRejectionTooltip] = useState('')

  const [unrealizedPnl, setUnrealizedPnl] = useState(0)

  // Poll trade summary + window timing + rejections + unrealized PnL
  useEffect(() => {
    const tick = () => {
      setSummary(tradeLogger.getSummary())
      setWindow(btcUpDownStrategy.getActiveWindow())
      const rSummary = rejectionTracker.getSummary()
      setRejectionTotal(rSummary.total)
      setRejectionTooltip(
        Object.entries(rSummary.counts)
          .sort(([, a], [, b]) => (b ?? 0) - (a ?? 0))
          .map(([cat, n]) => `${cat}: ${n}`)
          .join(', ') || 'No rejections'
      )
      setUnrealizedPnl(positionLifecycleManager.getUnrealizedPnl().totalUsd)
    }
    tick()
    const id = setInterval(tick, 5000)
    return () => clearInterval(id)
  }, [])

  const [showDropdown, setShowDropdown] = useState(false)

  const anyRunning = strategies.some((s) => s.status === 'running')
  // Total PnL = realized (closed trades) + unrealized (open positions)
  const todayPnl = summary.totalPnlUSD + unrealizedPnl
  const winRate = summary.totalTrades > 0 ? Math.round(summary.winRate * 100) : 0

  return (
    <div className="relative z-50 flex items-center justify-between px-6 py-3.5 border-b border-agent-border bg-agent-card/60 backdrop-blur-sm">
      {/* Left: Brand + tabs */}
      <div className="flex items-center gap-5">
        {/* Brand */}
        <div className="flex items-center gap-2">
          <span className="text-agent-green text-lg">&#9889;</span>
          <span className="text-base font-sans font-bold text-agent-text tracking-wide">
            AlphaPolyBot HQ
          </span>
        </div>

        {/* Tabs */}
        <div className="flex items-center gap-1">
          <button
            onClick={() => onTabChange('live')}
            className={`px-3.5 py-1.5 rounded-md text-sm font-sans font-semibold transition-colors ${
              activeTab === 'live'
                ? 'bg-agent-green/15 text-agent-green border border-agent-green/30'
                : 'text-agent-text-muted hover:text-agent-text'
            }`}
          >
            <span className={activeTab === 'live' ? 'mr-1.5 inline-block w-1.5 h-1.5 rounded-full bg-agent-green' : 'mr-1.5 inline-block w-1.5 h-1.5 rounded-full bg-agent-text-label'} />
            Live Trading
          </button>
          <button
            onClick={() => onTabChange('history')}
            className={`px-3.5 py-1.5 rounded-md text-sm font-sans font-semibold transition-colors ${
              activeTab === 'history'
                ? 'bg-agent-green/15 text-agent-green border border-agent-green/30'
                : 'text-agent-text-muted hover:text-agent-text'
            }`}
          >
            <span className={activeTab === 'history' ? 'mr-1.5 inline-block w-1.5 h-1.5 rounded-full bg-agent-green' : 'mr-1.5 inline-block w-1.5 h-1.5 rounded-full bg-agent-text-label'} />
            History
          </button>
          <button
            onClick={() => onTabChange('spotcrypto')}
            className={`px-3.5 py-1.5 rounded-md text-sm font-sans font-semibold transition-colors ${
              activeTab === 'spotcrypto'
                ? 'bg-agent-green/15 text-agent-green border border-agent-green/30'
                : 'text-agent-text-muted hover:text-agent-text'
            }`}
          >
            <span className={activeTab === 'spotcrypto' ? 'mr-1.5 inline-block w-1.5 h-1.5 rounded-full bg-agent-green' : 'mr-1.5 inline-block w-1.5 h-1.5 rounded-full bg-agent-text-label'} />
            Spot Crypto
          </button>
        </div>

        {/* Dry Run / Live toggle */}
        <div className="relative">
          <button
            onClick={() => {
              if (dryRun) {
                // Going live — require confirmation
                setConfirmLive(true)
              } else {
                // Going to dry run — safe, immediate
                setDryRun(true)
                tradingService.setConfig({ dryRun: true })
                setConfirmLive(false)
              }
            }}
            className={`flex items-center gap-2 px-2.5 py-1 rounded-full border text-xs font-mono font-semibold cursor-pointer transition-all ${
              dryRun
                ? 'bg-agent-cyan/10 border-agent-cyan/30 text-agent-cyan hover:bg-agent-cyan/20'
                : 'bg-red-500/10 border-red-500/30 text-red-400 hover:bg-red-500/20'
            }`}
            title={dryRun ? 'Click to switch to LIVE trading' : 'Click to switch to DRY RUN mode'}
          >
            {/* Toggle track */}
            <span className={`relative inline-flex h-4 w-7 items-center rounded-full transition-colors ${dryRun ? 'bg-agent-cyan/30' : 'bg-red-500/30'}`}>
              <span className={`inline-block h-3 w-3 rounded-full transition-transform ${dryRun ? 'translate-x-0.5 bg-agent-cyan' : 'translate-x-3.5 bg-red-400'}`} />
            </span>
            {dryRun ? 'DRY RUN' : 'LIVE'}
          </button>

          {/* Confirmation popover for going live */}
          {confirmLive && (
            <>
              <div className="fixed inset-0 z-40" onClick={() => setConfirmLive(false)} />
              <div className="absolute top-full left-0 mt-2 z-50 bg-agent-elevated border border-red-500/40 rounded-lg p-3 shadow-lg shadow-red-500/10 w-56">
                <p className="text-xs font-sans text-agent-text mb-2.5">
                  Switch to <span className="text-red-400 font-bold">LIVE</span> mode? Real orders will be placed with real funds.
                </p>
                <div className="flex gap-2">
                  <button
                    onClick={() => {
                      setDryRun(false)
                      tradingService.setConfig({ dryRun: false })
                      setConfirmLive(false)
                    }}
                    className="flex-1 px-2.5 py-1.5 rounded text-xs font-mono font-bold bg-red-500/20 border border-red-500/40 text-red-400 hover:bg-red-500/30 transition-colors"
                  >
                    GO LIVE
                  </button>
                  <button
                    onClick={() => setConfirmLive(false)}
                    className="flex-1 px-2.5 py-1.5 rounded text-xs font-mono font-bold bg-agent-card border border-agent-border text-agent-text-muted hover:text-agent-text transition-colors"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            </>
          )}
        </div>

        {rejectionTotal > 0 && (
          <span className="text-xs font-mono px-2 py-0.5 rounded bg-orange-500/10 text-orange-400 border border-orange-500/20 cursor-help" title={rejectionTooltip}>
            {rejectionTotal} blocked
          </span>
        )}
      </div>

      {/* Center: Window timer */}
      <WindowTimer
        windowStartMs={window?.windowStartMs ?? null}
        windowEndMs={window?.windowEndMs ?? null}
        windowDurationMs={window?.windowDurationMs ?? null}
      />

      {/* Right: Stats + status */}
      <div className="flex items-center gap-6">
        {/* Inline stats */}
        <div className="flex items-center gap-5 text-sm font-mono">
          <div className="text-center">
            <div className="text-[11px] uppercase tracking-wider text-agent-text-muted font-sans">Balance</div>
            <div className="text-agent-text font-semibold tabular-nums">${balance.toFixed(2)}</div>
          </div>
          <div className="text-center">
            <div className="text-[11px] uppercase tracking-wider text-agent-text-muted font-sans">Today</div>
            <div className={`font-semibold tabular-nums ${todayPnl >= 0 ? 'text-agent-green' : 'text-agent-red'}`}>
              {todayPnl >= 0 ? '+' : ''}${todayPnl.toFixed(2)}
            </div>
          </div>
          <div className="text-center">
            <div className="text-[11px] uppercase tracking-wider text-agent-text-muted font-sans">Win Rate</div>
            <div className={`font-semibold tabular-nums ${winRate >= 50 ? 'text-agent-green' : winRate > 0 ? 'text-agent-red' : 'text-agent-text'}`}>
              {winRate}%
            </div>
          </div>
          <div className="text-center">
            <div className="text-[11px] uppercase tracking-wider text-agent-text-muted font-sans">Trades</div>
            <div className="text-agent-text font-semibold tabular-nums">{summary.totalTrades}</div>
          </div>
        </div>

        <div className="w-px h-6 bg-agent-border" />

        {/* Status badge — clickable, opens strategy dropdown */}
        <div className="relative">
          <button
            onClick={() => setShowDropdown((v) => !v)}
            className={`flex items-center gap-1.5 px-3 py-1 rounded-full border text-xs font-mono font-semibold cursor-pointer transition-all ${
              anyRunning
                ? 'bg-agent-green/10 border-agent-green/30 text-agent-green hover:bg-agent-green/20'
                : 'bg-agent-red/10 border-agent-red/30 text-agent-red hover:bg-agent-red/20'
            }`}
            title="Click to manage strategies"
          >
            <span className={`w-1.5 h-1.5 rounded-full ${anyRunning ? 'bg-agent-green animate-pulse' : 'bg-agent-red'}`} />
            {anyRunning ? 'Active' : 'Stopped'}
            <svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="ml-0.5 opacity-60">
              <polyline points="6 9 12 15 18 9" />
            </svg>
          </button>

          {showDropdown && (
            <StrategyDropdown onClose={() => setShowDropdown(false)} />
          )}
        </div>

        {/* Settings */}
        <Link
          to="/settings"
          className="text-agent-text-muted hover:text-agent-text transition-colors"
          title="Settings"
        >
          <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
            <circle cx="12" cy="12" r="3" />
          </svg>
        </Link>
      </div>
    </div>
  )
}
