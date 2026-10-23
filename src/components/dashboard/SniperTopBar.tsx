import React, { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { WindowTimer } from './WindowTimer'
import { StrategyDropdown } from './StrategyDropdown'
import { useWalletStore, useSettingsStore } from '@/stores'
import { walletService } from '@/services/wallet/WalletService'
import type { WalletEntry } from '@/types'
import { strategyManager, type StrategyState } from '@/services/strategies'
import { tradeLogger, rejectionTracker, positionLifecycleManager, tradingService } from '@/services/trading'
import { btcUpDownStrategy } from '@/services/strategies/BtcUpDownStrategy'
import type { BacktestSummary } from '@/services/trading/TradeLogger'

interface SniperTopBarProps {
  activeTab: 'live' | 'history' | 'spotcrypto' | 'backtest' | 'analytics'
  onTabChange: (tab: 'live' | 'history' | 'spotcrypto' | 'backtest' | 'analytics') => void
}

const TABS = [
  { key: 'live' as const, label: 'Live', labelFull: 'Live Trading' },
  { key: 'history' as const, label: 'History', labelFull: 'History' },
  { key: 'spotcrypto' as const, label: 'Spot', labelFull: 'Spot Crypto' },
  { key: 'backtest' as const, label: 'Backtest', labelFull: 'Backtest' },
  { key: 'analytics' as const, label: 'Stats', labelFull: 'Analytics' },
]

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
    <div className="relative z-50 flex flex-col gap-2 px-3 sm:px-6 py-2.5 sm:py-3.5 border-b border-agent-green/[0.07] bg-agent-card/50 backdrop-blur-lg shadow-glass">
      {/* Row 1: brand + mode/status/settings */}
      <div className="flex items-center justify-between gap-2 min-w-0">
        <div className="flex items-center gap-2 shrink-0">
          <span className="text-agent-green text-lg" aria-hidden>&#9889;</span>
          <span className="hidden sm:inline text-base font-sans font-bold text-agent-text tracking-wide">
            AlphaPolyBot HQ
          </span>
        </div>

        <div className="flex items-center gap-2 sm:gap-3 min-w-0">
          {/* Compact Bal / PnL — phones only */}
          <div className="flex lg:hidden items-center gap-2 text-xs font-mono">
            <div className="text-center px-1">
              <div className="text-[9px] uppercase tracking-wider text-agent-text-muted font-sans">Bal</div>
              <div className="text-agent-text font-semibold tabular-nums">${balance.toFixed(2)}</div>
            </div>
            <div className="text-center px-1">
              <div className="text-[9px] uppercase tracking-wider text-agent-text-muted font-sans">PnL</div>
              <div className={`font-semibold tabular-nums ${todayPnl >= 0 ? 'text-agent-green' : 'text-agent-red'}`}>
                {todayPnl >= 0 ? '+' : ''}${todayPnl.toFixed(2)}
              </div>
            </div>
          </div>

          {/* Full stats — large screens */}
          <div className="hidden lg:flex items-center gap-5 text-sm font-mono">
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

          <div className="hidden lg:block w-px h-6 bg-agent-border" />

          {/* Dry Run / Live toggle */}
          <div className="relative shrink-0">
            <button
              type="button"
              onClick={() => {
                if (dryRun) {
                  setConfirmLive(true)
                } else {
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
              <span className={`relative inline-flex h-4 w-7 items-center rounded-full transition-colors ${dryRun ? 'bg-agent-cyan/30' : 'bg-red-500/30'}`}>
                <span className={`inline-block h-3 w-3 rounded-full transition-transform ${dryRun ? 'translate-x-0.5 bg-agent-cyan' : 'translate-x-3.5 bg-red-400'}`} />
              </span>
              {dryRun ? 'DRY RUN' : 'LIVE'}
            </button>

            {confirmLive && (
              <>
                <div className="fixed inset-0 z-40" onClick={() => setConfirmLive(false)} />
                <div className="absolute top-full right-0 mt-2 z-50 bg-agent-elevated border border-red-500/40 rounded-lg p-3 shadow-lg shadow-red-500/10 w-56">
                  <p className="text-xs font-sans text-agent-text mb-2.5">
                    Switch to <span className="text-red-400 font-bold">LIVE</span> mode? Real orders will be placed with real funds.
                  </p>
                  <div className="flex gap-2">
                    <button
                      type="button"
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
                      type="button"
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
            <span className="hidden sm:inline text-xs font-mono px-2 py-0.5 rounded bg-orange-500/10 text-orange-400 border border-orange-500/20 cursor-help" title={rejectionTooltip}>
              {rejectionTotal} blocked
            </span>
          )}

          {wallets.length > 1 && (
            <div className="relative shrink-0">
              <button
                type="button"
                onClick={() => setShowWalletPicker((v) => !v)}
                className="flex items-center gap-1.5 px-2.5 py-1 rounded-full border border-agent-cyan/20 bg-agent-cyan/5 text-xs font-mono font-semibold text-agent-cyan hover:bg-agent-cyan/10 transition-all"
                title="Switch wallet"
              >
                <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <rect width="20" height="14" x="2" y="5" rx="2" />
                  <path d="M2 10h20" />
                </svg>
                <span className="max-w-[80px] truncate">
                  {wallets.find((w: WalletEntry) => w.id === activeWalletId)?.label ?? 'Wallet'}
                </span>
                <svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="opacity-60">
                  <polyline points="6 9 12 15 18 9" />
                </svg>
              </button>

              {showWalletPicker && (
                <>
                  <div className="fixed inset-0 z-40" onClick={() => setShowWalletPicker(false)} />
                  <div className="absolute top-full right-0 mt-2 z-50 bg-agent-elevated border border-agent-cyan/20 rounded-lg p-1.5 shadow-lg min-w-[160px]">
                    {wallets.map((w: WalletEntry) => (
                      <button
                        type="button"
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

          <div className="relative shrink-0">
            <button
              type="button"
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

          <Link
            to="/settings"
            className="text-agent-text-muted hover:text-agent-text transition-colors min-h-[44px] min-w-[44px] inline-flex items-center justify-center shrink-0"
            title="Settings"
            aria-label="Settings"
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
              <circle cx="12" cy="12" r="3" />
            </svg>
          </Link>
        </div>
      </div>

      {/* Row 2: tabs (full width, scrollable) + optional window timer */}
      <div className="flex items-center gap-3 min-w-0">
        <div className="flex-1 min-w-0 flex items-center gap-1 overflow-x-auto no-scrollbar">
          {TABS.map((tab) => (
            <button
              type="button"
              key={tab.key}
              onClick={() => onTabChange(tab.key)}
              className={`whitespace-nowrap px-2.5 sm:px-3.5 py-2 min-h-[40px] rounded-md text-xs sm:text-sm font-sans font-semibold transition-colors shrink-0 ${
                activeTab === tab.key
                  ? 'bg-agent-green/15 text-agent-green border border-agent-green/30'
                  : 'text-agent-text-muted hover:text-agent-text'
              }`}
            >
              <span className={`mr-1.5 inline-block w-1.5 h-1.5 rounded-full ${activeTab === tab.key ? 'bg-agent-green' : 'bg-agent-text-label'}`} />
              <span className="hidden sm:inline">{tab.labelFull}</span>
              <span className="sm:hidden">{tab.label}</span>
            </button>
          ))}
        </div>

        <div className="hidden md:block shrink-0">
          <WindowTimer
            windowStartMs={window?.windowStartMs ?? null}
            windowEndMs={window?.windowEndMs ?? null}
            windowDurationMs={window?.windowDurationMs ?? null}
          />
        </div>
      </div>
    </div>
  )
}
