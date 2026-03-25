import React, { useState, useEffect, Suspense } from 'react'
import { useWalletStore, useSettingsStore } from '@/stores'

// Lazy-load recharts — it's 1.2MB and only needed for the equity curve chart.
// This keeps the initial dashboard render free of recharts overhead.
const LazyRechartsChart = React.lazy(() => import('./PortfolioPanelChart'))
import { useBalanceHistoryStore } from '@/stores/balanceHistoryStore'
import { tradeLogger } from '@/services/trading/TradeLogger'
import type { BacktestSummary } from '@/services/trading/TradeLogger'

export const PortfolioPanel: React.FC = () => {
  const balance = useWalletStore((s) => s.balance)
  const dryRun = useSettingsStore((s) => s.dryRun)
  const paperBalance = useSettingsStore((s) => s.paperBalance)
  const snapshots = useBalanceHistoryStore((s) => s.snapshots)
  const initialBalance = useBalanceHistoryStore((s) => s.initialBalance)
  const simulatedBalance = useBalanceHistoryStore((s) => s.simulatedBalance)
  const [summary, setSummary] = useState<BacktestSummary>(tradeLogger.getSummary())

  // Bot stats — fast interval (5s)
  useEffect(() => {
    const tick = () => {
      setSummary(tradeLogger.getSummary())
    }
    tick()
    const id = setInterval(tick, 5000)
    return () => clearInterval(id)
  }, [])

  // In dry run: use simulatedBalance if tracked, otherwise fall back to paperBalance setting.
  // In live: use simulatedBalance if tracked, otherwise real wallet balance.
  const displayBalance = dryRun
    ? (simulatedBalance > 0 ? simulatedBalance : paperBalance)
    : (simulatedBalance > 0 ? simulatedBalance : balance)

  const data = snapshots.map((s) => ({
    time: s.timestamp,
    balance: s.balance,
  }))

  const isFlat = data.length >= 2 && data.every(d => d.balance === data[0].balance)

  return (
    <div className="flex flex-col gap-2">
      {/* Portfolio Value — compact */}
      <div className="card-base p-3 gradient-border">
        <div className="flex items-baseline justify-between">
          <div>
            <div className="text-[10px] uppercase tracking-wider text-agent-text-muted font-sans font-medium flex items-center gap-1.5">
              Portfolio
              {dryRun && <span className="text-agent-orange bg-agent-orange/15 px-1 py-0.5 rounded text-[8px] font-bold">PAPER</span>}
            </div>
            <div className="text-2xl font-mono font-bold text-agent-text leading-tight animate-text-glow">
              ${(displayBalance ?? 0).toFixed(2)}
            </div>
          </div>
          {/* Live signal pulse */}
          <div className="flex items-end gap-[2px] h-6 self-center">
            {[0, 1, 2, 3, 4].map((i) => (
              <div
                key={i}
                className={`w-[3px] rounded-full bg-agent-green/70 bar-bounce-${i}`}
              />
            ))}
          </div>
        </div>

        {/* Inline quick stats */}
        <div className="grid grid-cols-4 gap-1.5 mt-2 pt-2 border-t border-agent-border/40 stagger-fade">
          <div className="text-center">
            <div className="text-[9px] text-agent-text-muted font-sans uppercase">Win%</div>
            <div className={`text-xs font-mono font-semibold ${summary.winRate >= 0.5 ? 'text-agent-green' : summary.totalTrades > 0 ? 'text-agent-red' : 'text-agent-text'}`}>
              {summary.totalTrades > 0 ? `${Math.round(summary.winRate * 100)}%` : '--'}
            </div>
          </div>
          <div className="text-center">
            <div className="text-[9px] text-agent-text-muted font-sans uppercase">Trades</div>
            <div className="text-xs font-mono font-semibold text-agent-text">{summary.totalTrades}</div>
          </div>
          <div className="text-center">
            <div className="text-[9px] text-agent-text-muted font-sans uppercase">Avg</div>
            <div className={`text-xs font-mono font-semibold ${summary.avgPnlPerTrade >= 0 ? 'text-agent-green' : 'text-agent-red'}`}>
              {summary.totalTrades > 0 ? `${(summary.avgPnlPerTrade ?? 0) >= 0 ? '+' : ''}$${(summary.avgPnlPerTrade ?? 0).toFixed(2)}` : '--'}
            </div>
          </div>
          <div className="text-center">
            <div className="text-[9px] text-agent-text-muted font-sans uppercase">DD</div>
            <div className="text-xs font-mono font-semibold text-agent-red">
              {(summary.maxDrawdownPercent ?? 0) > 0 ? `-${(summary.maxDrawdownPercent ?? 0).toFixed(1)}%` : '--'}
            </div>
          </div>
        </div>
      </div>

      {/* Equity Curve — lazy-loaded (defers recharts 1.2MB download) */}
      <div className="card-base p-3 flex flex-col min-h-0">
        <div className="text-[10px] uppercase tracking-wider text-agent-text-muted font-sans font-medium mb-1">
          Equity Curve
        </div>

        <Suspense fallback={
          <div className="flex-1 min-h-[100px] flex items-center justify-center text-agent-text-label text-[11px] font-mono animate-pulse">
            Loading chart...
          </div>
        }>
          <LazyRechartsChart data={data} initialBalance={initialBalance} isFlat={isFlat} />
        </Suspense>
      </div>
    </div>
  )
}
