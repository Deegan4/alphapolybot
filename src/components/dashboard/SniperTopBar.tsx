import React, { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { WindowTimer } from './WindowTimer'
import { StrategyDropdown } from './StrategyDropdown'
import { useWalletStore, useSettingsStore } from '@/stores'
import { walletService } from '@/services/wallet/WalletService'
import { strategyManager, type StrategyState } from '@/services/strategies/StrategyManager'
import { tradeLogger } from '@/services/trading/TradeLogger'
import { rejectionTracker } from '@/services/trading/RejectionTracker'
import { positionLifecycleManager } from '@/services/trading/PositionLifecycleManager'
import { tradingService } from '@/services/trading/TradingService'
import { btcUpDownStrategy } from '@/services/strategies/BtcUpDownStrategy'
import type { BacktestSummary } from '@/services/trading/TradeLogger'

interface SniperTopBarProps {
  activeTab: 'live' | 'history' | 'backtest' | 'analytics'
  onTabChange: (tab: 'live' | 'history' | 'backtest' | 'analytics') => void
}

export const SniperTopBar: React.FC<SniperTopBarProps> = ({ activeTab, onTabChange }) => {
  const balance = useWalletStore((s) => s.balance)
  const dryRun = useSettingsStore((s) => s.dryRun)
  const setDryRun = useSettingsStore((s) => s.setDryRun)
  const wallets = useSettingsStore((s) => s.wallets)
  const activeWalletId = useSettingsStore((s) => s.activeWalletId)
  const setActiveWallet = useSettingsStore((s) => s.setActiveWallet)
  const [confirmLive, setConfirmLive] = useState(false)
  const [showWalletPicker, setShowWalletPicker] = useState(false)
  const [strategies, setStrategies] = useState<StrategyState[]>(strategyManager.getStates())
  const [summary, setSummary] = useState<BacktestSummary>(tradeLogger.getSummary())
  const [activeWindows, setActiveWindows] = useState(btcUpDownStrategy.getActiveWindows())

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
      setActiveWindows(btcUpDownStrategy.getActiveWindows())
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

  // Listen for banner CTA to open the strategy dropdown
  useEffect(() => {
    const handler = () => setShowDropdown(true)
    window.addEventListener('open-strategy-dropdown', handler)
    return () => window.removeEventListener('open-strategy-dropdown', handler)
  }, [])

  const anyRunning = strategies.some((s) => s.status === 'running')
  // Total PnL = realized (closed trades) + unrealized (open positions)
  const todayPnl = summary.totalPnlUSD + unrealizedPnl
  const winRate = summary.totalTrades > 0 ? Math.round(summary.winRate * 100) : 0

  return (
    <div className="relative z-50 flex flex-wrap items-center justify-between gap-2 px-3 sm:px-6 py-2.5 sm:py-3.5 border-b border-agent-green/[0.07] bg-agent-card/50 backdrop-blur-lg shadow-glass">
      {/* Left: Brand + tabs */}
      <div className="flex items-center gap-3 sm:gap-5">
        {/* Brand */}
        <div className="flex items-center gap-2">
          <span className="text-agent-green text-lg">&#9889;</span>
          <span className="hidden sm:inline text-base font-sans font-bold text-agent-text tracking-wide">
            AlphaPolyBot HQ
          </span>
        </div>

        {/* Tabs — underline indicator style, horizontally scrollable on mobile */}
        <div className="flex items-center gap-0.5 overflow-x-auto no-scrollbar border-b border-transparent">
          {([
            { key: 'live' as const, label: 'Live', labelFull: 'Live Trading' },
            { key: 'history' as const, label: 'History', labelFull: 'History' },
            { key: 'backtest' as const, label: 'Backtest', labelFull: 'Backtest' },
            { key: 'analytics' as const, label: 'Stats', labelFull: 'Analytics' },
          ]).map(tab => (
            <button
              key={tab.key}
              onClick={() => onTabChange(tab.key)}
              className={`relative whitespace-nowrap px-3 sm:px-4 py-2 text-xs sm:text-sm font-sans font-medium transition-colors ${
                activeTab === tab.key
                  ? 'text-agent-green'
                  : 'text-agent-text-muted hover:text-agent-text'
              }`}
            >
              <span className="hidden sm:inline">{tab.labelFull}</span>
              <span className="sm:hidden">{tab.label}</span>
              {/* Active underline indicator */}
              {activeTab === tab.key && (
                <span className="absolute bottom-0 left-2 right-2 h-[2px] rounded-full bg-agent-green" />
              )}
            </button>
          ))}
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

      {/* Center: Window timer (hidden on small screens) */}
      <div className="hidden md:block">
        <WindowTimer windows={activeWindows} />
      </div>

      {/* Right: Stats + status */}
      <div className="flex items-center gap-3 sm:gap-6">
        {/* Inline stats (hidden on mobile) */}
        <div className="hidden lg:flex items-center gap-5 text-sm font-mono">
          <div className="text-center">
            <div className="text-[11px] uppercase tracking-wider text-agent-text-muted font-sans">Balance</div>
            <div className="text-agent-text font-semibold tabular-nums">${(balance ?? 0).toFixed(2)}</div>
          </div>
          <div className="text-center">
            <div className="text-[11px] uppercase tracking-wider text-agent-text-muted font-sans">Today</div>
            <div className={`font-semibold tabular-nums ${todayPnl >= 0 ? 'text-agent-green' : 'text-agent-red'}`}>
              {todayPnl >= 0 ? '+' : ''}${(todayPnl ?? 0).toFixed(2)}
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

        <div className="hidden lg:block w-px h-6 bg-agent-border" />

        {/* Wallet selector (only when multiple wallets configured) */}
        {wallets.length > 1 && (
          <div className="relative">
            <button
              onClick={() => setShowWalletPicker((v) => !v)}
              className="flex items-center gap-1.5 px-2.5 py-1 rounded-full border border-agent-cyan/20 bg-agent-cyan/5 text-xs font-mono font-semibold text-agent-cyan hover:bg-agent-cyan/10 transition-all"
              title="Switch wallet"
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect width="20" height="14" x="2" y="5" rx="2" />
                <path d="M2 10h20" />
              </svg>
              <span className="max-w-[80px] truncate">
                {wallets.find((w) => w.id === activeWalletId)?.label ?? 'Wallet'}
              </span>
              <svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="opacity-60">
                <polyline points="6 9 12 15 18 9" />
              </svg>
            </button>

            {showWalletPicker && (
              <>
                <div className="fixed inset-0 z-40" onClick={() => setShowWalletPicker(false)} />
                <div className="absolute top-full right-0 mt-2 z-50 bg-agent-elevated border border-agent-cyan/20 rounded-lg p-1.5 shadow-lg min-w-[160px]">
                  {wallets.map((w) => (
                    <button
                      key={w.id}
                      onClick={async () => {
                        if (w.id !== activeWalletId) {
                          setActiveWallet(w.id)
                          await walletService.switchWallet(w)
                        }
                        setShowWalletPicker(false)
                      }}
                      className={`w-full text-left px-3 py-1.5 rounded text-xs font-mono transition-colors flex items-center gap-2 ${
                        w.id === activeWalletId
                          ? 'bg-agent-cyan/15 text-agent-cyan'
                          : 'text-agent-text-muted hover:text-agent-text hover:bg-agent-card'
                      }`}
                    >
                      <span className={`w-1.5 h-1.5 rounded-full ${w.id === activeWalletId ? 'bg-agent-cyan' : 'bg-agent-text-label'}`} />
                      <span className="truncate">{w.label}</span>
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>
        )}

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
            <span className={`w-1.5 h-1.5 rounded-full ${anyRunning ? 'bg-agent-green dot-ping' : 'bg-agent-red'}`} />
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
          className="text-agent-text-muted hover:text-agent-text transition-colors hover-spin"
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
