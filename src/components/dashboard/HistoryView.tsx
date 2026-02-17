import React, { useEffect, useState, useMemo } from 'react'
import { tradeLogger } from '@/services/trading'
import type { TradeRecord } from '@/services/trading/TradeLogger'

type SortKey = 'time' | 'pnl' | 'duration'
type SortDir = 'asc' | 'desc'
type ModeFilter = 'all' | 'paper' | 'live'

const stratLabel = (s: string): string => {
  const map: Record<string, string> = { llm: 'LLM', dip: 'DIP', fw: 'FW', btc: 'BTC', micro: 'MICRO' }
  return map[s] ?? s.toUpperCase()
}

const formatDuration = (ms: number): string => {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`
  return `${(ms / 3_600_000).toFixed(1)}h`
}

const formatDate = (ts: number): string => {
  const d = new Date(ts)
  return d.toLocaleString(undefined, {
    month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: false,
  })
}

export const HistoryView: React.FC = () => {
  const [records, setRecords] = useState<TradeRecord[]>([])
  const [sortKey, setSortKey] = useState<SortKey>('time')
  const [sortDir, setSortDir] = useState<SortDir>('desc')
  const [modeFilter, setModeFilter] = useState<ModeFilter>('all')

  // Poll for new closed trades (matches 5s interval used by other dashboard components)
  useEffect(() => {
    const tick = () => {
      const all = tradeLogger.getRecords(5000)
      const closed = all.filter((r) => r.exitTimestamp != null)
      setRecords(closed)
    }
    tick()
    const id = setInterval(tick, 5000)
    return () => clearInterval(id)
  }, [])

  const filtered = useMemo(() => {
    if (modeFilter === 'all') return records
    if (modeFilter === 'paper') return records.filter(r => r.dryRun === true)
    return records.filter(r => !r.dryRun)
  }, [records, modeFilter])

  const sorted = useMemo(() => {
    const arr = [...filtered]
    arr.sort((a, b) => {
      let cmp = 0
      switch (sortKey) {
        case 'time':
          cmp = (a.exitTimestamp ?? 0) - (b.exitTimestamp ?? 0)
          break
        case 'pnl':
          cmp = (a.pnlUSD ?? 0) - (b.pnlUSD ?? 0)
          break
        case 'duration':
          cmp = (a.holdTimeMs ?? 0) - (b.holdTimeMs ?? 0)
          break
      }
      return sortDir === 'asc' ? cmp : -cmp
    })
    return arr
  }, [filtered, sortKey, sortDir])

  const toggleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))
    } else {
      setSortKey(key)
      setSortDir('desc')
    }
  }

  const sortIcon = (key: SortKey) => {
    if (sortKey !== key) return ''
    return sortDir === 'asc' ? ' \u25B2' : ' \u25BC'
  }

  // Filtered summary stats
  const filteredSummary = useMemo(() => {
    const wins = filtered.filter(r => (r.pnlUSD ?? 0) > 0)
    const totalPnl = filtered.reduce((sum, r) => sum + (r.pnlUSD ?? 0), 0)
    return {
      totalTrades: filtered.length,
      winRate: filtered.length > 0 ? wins.length / filtered.length : 0,
      totalPnlUSD: totalPnl,
      avgPnlPerTrade: filtered.length > 0 ? totalPnl / filtered.length : 0,
    }
  }, [filtered])

  // Best/worst trade
  const bestTrade = filtered.length > 0
    ? filtered.reduce((best, r) => (r.pnlUSD ?? 0) > (best.pnlUSD ?? 0) ? r : best, filtered[0])
    : null
  const worstTrade = filtered.length > 0
    ? filtered.reduce((worst, r) => (r.pnlUSD ?? 0) < (worst.pnlUSD ?? 0) ? r : worst, filtered[0])
    : null

  return (
    <div className="flex-1 flex flex-col gap-4 p-5 min-h-0 overflow-hidden">
      {/* Mode filter + Summary stats */}
      <div className="flex items-center gap-3">
        <div className="flex items-center gap-1 bg-agent-elevated/50 rounded-full p-0.5 border border-agent-border/40">
          {(['all', 'paper', 'live'] as ModeFilter[]).map((mode) => (
            <button
              key={mode}
              onClick={() => setModeFilter(mode)}
              className={`text-[10px] font-mono font-bold px-3 py-1 rounded-full transition-colors ${
                modeFilter === mode
                  ? mode === 'paper' ? 'bg-agent-cyan/20 text-agent-cyan'
                    : mode === 'live' ? 'bg-red-500/20 text-red-400'
                    : 'bg-agent-green/20 text-agent-green'
                  : 'text-agent-text-muted hover:text-agent-text'
              }`}
            >
              {mode.toUpperCase()}
            </button>
          ))}
        </div>
        <span className="text-[10px] font-mono text-agent-text-label">
          {filtered.length} trade{filtered.length !== 1 ? 's' : ''}
        </span>
      </div>

      {/* Summary stats row */}
      <div className="grid grid-cols-6 gap-4">
        {[
          { label: 'Total P&L', value: `${filteredSummary.totalPnlUSD >= 0 ? '+' : ''}$${filteredSummary.totalPnlUSD.toFixed(2)}`, color: filteredSummary.totalPnlUSD >= 0 ? 'text-agent-green' : 'text-agent-red' },
          { label: 'Win Rate', value: `${filteredSummary.totalTrades > 0 ? Math.round(filteredSummary.winRate * 100) : 0}%`, color: filteredSummary.winRate >= 0.5 ? 'text-agent-green' : 'text-agent-red' },
          { label: 'Trades', value: `${filteredSummary.totalTrades}`, color: 'text-agent-text' },
          { label: 'Avg P&L', value: `${filteredSummary.avgPnlPerTrade >= 0 ? '+' : ''}$${filteredSummary.avgPnlPerTrade.toFixed(2)}`, color: filteredSummary.avgPnlPerTrade >= 0 ? 'text-agent-green' : 'text-agent-red' },
          { label: 'Best Trade', value: bestTrade ? `+$${(bestTrade.pnlUSD ?? 0).toFixed(2)}` : '--', color: 'text-agent-green' },
          { label: 'Worst Trade', value: worstTrade ? `$${(worstTrade.pnlUSD ?? 0).toFixed(2)}` : '--', color: 'text-agent-red' },
        ].map((stat) => (
          <div key={stat.label} className="card-base p-3.5 text-center">
            <div className="text-[11px] uppercase tracking-wider text-agent-text-muted font-sans font-medium">{stat.label}</div>
            <div className={`text-lg font-mono font-bold tabular-nums ${stat.color}`}>{stat.value}</div>
          </div>
        ))}
      </div>

      {/* Trade table */}
      <div className="card-base flex-1 flex flex-col min-h-0 overflow-hidden">
        {/* Table header */}
        <div className="grid grid-cols-[130px_65px_90px_80px_80px_80px_80px_1fr] gap-2 px-4 py-2.5 border-b border-agent-border bg-agent-elevated/30 text-[11px] uppercase tracking-wider text-agent-text-muted font-sans font-medium">
          <button onClick={() => toggleSort('time')} className="text-left hover:text-agent-text">
            Time{sortIcon('time')}
          </button>
          <span>Strategy</span>
          <span>Outcome</span>
          <span className="text-right">Entry</span>
          <span className="text-right">Exit</span>
          <button onClick={() => toggleSort('pnl')} className="text-right hover:text-agent-text">
            P&L{sortIcon('pnl')}
          </button>
          <button onClick={() => toggleSort('duration')} className="text-right hover:text-agent-text">
            Duration{sortIcon('duration')}
          </button>
          <span>Reason</span>
        </div>

        {/* Table rows */}
        <div className="flex-1 overflow-y-auto min-h-0">
          {sorted.length === 0 ? (
            <div className="h-full flex flex-col items-center justify-center text-center gap-2">
              <span className="text-2xl opacity-30">&#128200;</span>
              <span className="text-sm font-sans text-agent-text-label">No closed trades yet</span>
            </div>
          ) : (
            sorted.map((r, index) => {
              const pnl = r.pnlUSD ?? 0
              const isWin = pnl >= 0
              return (
                <div
                  key={r.id}
                  className={`grid grid-cols-[130px_65px_90px_80px_80px_80px_80px_1fr] gap-2 px-4 py-2 border-b border-agent-border/50 text-xs font-mono hover:bg-agent-elevated/40 transition-colors ${index % 2 === 1 ? 'bg-agent-elevated/15' : ''}`}
                >
                  <span className="text-agent-text-muted tabular-nums">
                    {formatDate(r.exitTimestamp!)}
                  </span>
                  <span className="text-agent-cyan">
                    {stratLabel(r.strategy)}
                    {r.dryRun && <span className="text-[8px] text-agent-cyan/50 ml-0.5">SIM</span>}
                  </span>
                  <span className="text-agent-text truncate">{r.outcome}</span>
                  <span className="text-right text-agent-text-muted">${r.marketPrice.toFixed(3)}</span>
                  <span className="text-right text-agent-text-muted">${(r.exitPrice ?? 0).toFixed(3)}</span>
                  <span className={`text-right font-semibold ${isWin ? 'text-agent-green' : 'text-agent-red'}`}>
                    {isWin ? '+' : ''}${pnl.toFixed(2)}
                  </span>
                  <span className="text-right text-agent-text-muted">
                    {r.holdTimeMs ? formatDuration(r.holdTimeMs) : '--'}
                  </span>
                  <span className="text-agent-text-label truncate">{r.exitReason ?? '--'}</span>
                </div>
              )
            })
          )}
        </div>
      </div>
    </div>
  )
}
