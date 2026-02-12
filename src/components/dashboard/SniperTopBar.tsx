import React, { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { WindowTimer } from './WindowTimer'
import { StrategyDropdown } from './StrategyDropdown'
import { useWalletStore, useSettingsStore } from '@/stores'
import { strategyManager, type StrategyState } from '@/services/strategies'
import { tradeLogger, rejectionTracker } from '@/services/trading'
import { btcUpDownStrategy } from '@/services/strategies/BtcUpDownStrategy'
import type { BacktestSummary } from '@/services/trading/TradeLogger'

interface SniperTopBarProps {
  activeTab: 'live' | 'history'
  onTabChange: (tab: 'live' | 'history') => void
}

export const SniperTopBar: React.FC<SniperTopBarProps> = ({ activeTab, onTabChange }) => {
  const balance = useWalletStore((s) => s.usdcBalance)
  const { dryRun } = useSettingsStore()
  const [strategies, setStrategies] = useState<StrategyState[]>(strategyManager.getStates())
  const [summary, setSummary] = useState<BacktestSummary>(tradeLogger.getSummary())
  const [window, setWindow] = useState(btcUpDownStrategy.getActiveWindow())

  useEffect(() => {
    return strategyManager.subscribe(setStrategies)
  }, [])

  const [rejectionTotal, setRejectionTotal] = useState(0)

  // Poll trade summary + window timing + rejections
  useEffect(() => {
    const tick = () => {
      setSummary(tradeLogger.getSummary())
      setWindow(btcUpDownStrategy.getActiveWindow())
      setRejectionTotal(rejectionTracker.getSummary().total)
    }
    tick()
    const id = setInterval(tick, 5000)
    return () => clearInterval(id)
  }, [])

  const [showDropdown, setShowDropdown] = useState(false)

  const anyRunning = strategies.some((s) => s.status === 'running')
  const todayPnl = summary.totalPnlUSD
  const winRate = summary.totalTrades > 0 ? Math.round(summary.winRate * 100) : 0

  return (
    <div className="flex items-center justify-between px-5 py-3 border-b border-agent-border bg-agent-card/50">
      {/* Left: Brand + tabs */}
      <div className="flex items-center gap-5">
        {/* Brand */}
        <div className="flex items-center gap-2">
          <span className="text-agent-green text-lg">&#9889;</span>
          <span className="text-sm font-mono font-bold text-agent-text tracking-wide">
            AlphaPolyBot HQ
          </span>
        </div>

        {/* Tabs */}
        <div className="flex items-center gap-1">
          <button
            onClick={() => onTabChange('live')}
            className={`px-3 py-1 rounded text-xs font-mono font-semibold transition-colors ${
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
            className={`px-3 py-1 rounded text-xs font-mono font-semibold transition-colors ${
              activeTab === 'history'
                ? 'bg-agent-green/15 text-agent-green border border-agent-green/30'
                : 'text-agent-text-muted hover:text-agent-text'
            }`}
          >
            <span className="mr-1.5 inline-block w-1.5 h-1.5 rounded-full bg-agent-text-label" />
            History
          </button>
        </div>

        {dryRun && (
          <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-agent-cyan/10 text-agent-cyan border border-agent-cyan/20">
            DRY RUN
          </span>
        )}
        {rejectionTotal > 0 && (
          <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-orange-500/10 text-orange-400 border border-orange-500/20" title="Trade rejections in the last hour">
            {rejectionTotal} blocked
          </span>
        )}
      </div>

      {/* Center: Window timer */}
      <WindowTimer
        windowStartMs={window?.windowStartMs ?? null}
        windowEndMs={window?.windowEndMs ?? null}
      />

      {/* Right: Stats + status */}
      <div className="flex items-center gap-6">
        {/* Inline stats */}
        <div className="flex items-center gap-5 text-xs font-mono">
          <div className="text-center">
            <div className="text-[9px] uppercase tracking-wider text-agent-text-muted">Balance</div>
            <div className="text-agent-text font-semibold">${balance.toFixed(2)}</div>
          </div>
          <div className="text-center">
            <div className="text-[9px] uppercase tracking-wider text-agent-text-muted">Today</div>
            <div className={`font-semibold ${todayPnl >= 0 ? 'text-agent-green' : 'text-agent-red'}`}>
              {todayPnl >= 0 ? '+' : ''}${todayPnl.toFixed(2)}
            </div>
          </div>
          <div className="text-center">
            <div className="text-[9px] uppercase tracking-wider text-agent-text-muted">Win Rate</div>
            <div className={`font-semibold ${winRate >= 50 ? 'text-agent-green' : winRate > 0 ? 'text-agent-red' : 'text-agent-text'}`}>
              {winRate}%
            </div>
          </div>
          <div className="text-center">
            <div className="text-[9px] uppercase tracking-wider text-agent-text-muted">Trades</div>
            <div className="text-agent-text font-semibold">{summary.totalTrades}</div>
          </div>
        </div>

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
          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
            <circle cx="12" cy="12" r="3" />
          </svg>
        </Link>
      </div>
    </div>
  )
}
