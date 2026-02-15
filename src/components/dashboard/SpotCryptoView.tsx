import React, { useState, useEffect, useMemo } from 'react'
import { meanReversionStrategy } from '@/services/strategies/MeanReversionStrategy'
import { strategyManager } from '@/services/strategies'
import type { SpotPosition } from '@/types'

type SortKey = 'pnlPercent' | 'entryTime' | 'symbol'
type SortDir = 'asc' | 'desc'

/**
 * SpotCryptoView — Full-width tab showing Coinbase spot positions from Mean Reversion Strategy
 * Matches HistoryView pattern: 6 summary stats + sortable table, 5-second polling
 */
export const SpotCryptoView: React.FC = () => {
  const [positions, setPositions] = useState<SpotPosition[]>([])
  const [mrEnabled, setMrEnabled] = useState(false)
  const [sortKey, setSortKey] = useState<SortKey>('pnlPercent')
  const [sortDir, setSortDir] = useState<SortDir>('desc')

  // Poll for positions + strategy status every 5 seconds (matches HistoryView)
  useEffect(() => {
    const tick = () => {
      const states = strategyManager.getStates()
      const mrState = states.find((s) => s.name === 'Mean Reversion')
      setMrEnabled(mrState?.enabled ?? false)
      setPositions(meanReversionStrategy.getOpenPositions())
    }
    tick() // immediate call
    const id = setInterval(tick, 5000)
    return () => clearInterval(id)
  }, [])

  // Summary stats calculations
  const stats = useMemo(() => {
    if (positions.length === 0) {
      return {
        totalInvested: 0,
        totalUnrealizedPnl: 0,
        avgPnlPercent: 0,
        bestPosition: 0,
        worstPosition: 0,
      }
    }

    const totalInvested = positions.reduce((sum, p) => sum + p.costBasis, 0)
    const totalUnrealizedPnl = positions.reduce((sum, p) => sum + p.unrealizedPnl, 0)
    const avgPnlPercent =
      positions.reduce((sum, p) => sum + p.unrealizedPnlPercent, 0) / positions.length
    const bestPosition = Math.max(...positions.map((p) => p.unrealizedPnlPercent))
    const worstPosition = Math.min(...positions.map((p) => p.unrealizedPnlPercent))

    return {
      totalInvested,
      totalUnrealizedPnl,
      avgPnlPercent,
      bestPosition,
      worstPosition,
    }
  }, [positions])

  // Sorting logic
  const sorted = useMemo(() => {
    const copy = [...positions]
    copy.sort((a, b) => {
      let aVal: number | string = 0
      let bVal: number | string = 0

      if (sortKey === 'pnlPercent') {
        aVal = a.unrealizedPnlPercent
        bVal = b.unrealizedPnlPercent
      } else if (sortKey === 'entryTime') {
        aVal = a.entryTime
        bVal = b.entryTime
      } else if (sortKey === 'symbol') {
        aVal = a.symbol
        bVal = b.symbol
      }

      if (aVal < bVal) return sortDir === 'asc' ? -1 : 1
      if (aVal > bVal) return sortDir === 'asc' ? 1 : -1
      return 0
    })
    return copy
  }, [positions, sortKey, sortDir])

  // Toggle sort on column click
  const handleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))
    } else {
      setSortKey(key)
      setSortDir('desc')
    }
  }

  // Helper: format duration (ms → "Xm" or "Xh")
  const formatDuration = (ms: number): string => {
    if (ms < 60_000) return `${Math.round(ms / 1000)}s`
    if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`
    return `${(ms / 3_600_000).toFixed(1)}h`
  }

  return (
    <div className="flex-1 flex flex-col gap-4 p-5 min-h-0 overflow-hidden">
      {/* 1. Summary Stats Row — 6 cards */}
      <div className="grid grid-cols-6 gap-4">
        {/* Total Invested */}
        <div className="bg-agent-card border border-agent-border rounded-lg p-3.5">
          <div className="text-xs uppercase tracking-wider text-agent-text-muted mb-1.5 font-sans">
            Total Invested
          </div>
          <div className="text-lg font-mono font-semibold text-agent-text tabular-nums">
            ${stats.totalInvested.toFixed(2)}
          </div>
        </div>

        {/* Unrealized P&L */}
        <div className="bg-agent-card border border-agent-border rounded-lg p-3.5">
          <div className="text-xs uppercase tracking-wider text-agent-text-muted mb-1.5 font-sans">
            Unrealized P&L
          </div>
          <div
            className={`text-lg font-mono font-semibold tabular-nums ${
              stats.totalUnrealizedPnl >= 0 ? 'text-agent-green' : 'text-agent-red'
            }`}
          >
            {stats.totalUnrealizedPnl >= 0 ? '+' : ''}${stats.totalUnrealizedPnl.toFixed(2)}
          </div>
        </div>

        {/* Open Positions */}
        <div className="bg-agent-card border border-agent-border rounded-lg p-3.5">
          <div className="text-xs uppercase tracking-wider text-agent-text-muted mb-1.5 font-sans">
            Open Positions
          </div>
          <div className="text-lg font-mono font-semibold text-agent-text tabular-nums">
            {positions.length}
          </div>
        </div>

        {/* Avg P&L % */}
        <div className="bg-agent-card border border-agent-border rounded-lg p-3.5">
          <div className="text-xs uppercase tracking-wider text-agent-text-muted mb-1.5 font-sans">
            Avg P&L %
          </div>
          <div
            className={`text-lg font-mono font-semibold tabular-nums ${
              stats.avgPnlPercent >= 0 ? 'text-agent-green' : 'text-agent-red'
            }`}
          >
            {stats.avgPnlPercent >= 0 ? '+' : ''}
            {stats.avgPnlPercent.toFixed(1)}%
          </div>
        </div>

        {/* Best Position */}
        <div className="bg-agent-card border border-agent-border rounded-lg p-3.5">
          <div className="text-xs uppercase tracking-wider text-agent-text-muted mb-1.5 font-sans">
            Best Position
          </div>
          <div
            className={`text-lg font-mono font-semibold tabular-nums ${
              stats.bestPosition >= 0 ? 'text-agent-green' : 'text-agent-red'
            }`}
          >
            {stats.bestPosition >= 0 ? '+' : ''}
            {stats.bestPosition.toFixed(1)}%
          </div>
        </div>

        {/* Worst Position */}
        <div className="bg-agent-card border border-agent-border rounded-lg p-3.5">
          <div className="text-xs uppercase tracking-wider text-agent-text-muted mb-1.5 font-sans">
            Worst Position
          </div>
          <div
            className={`text-lg font-mono font-semibold tabular-nums ${
              stats.worstPosition >= 0 ? 'text-agent-green' : 'text-agent-red'
            }`}
          >
            {stats.worstPosition >= 0 ? '+' : ''}
            {stats.worstPosition.toFixed(1)}%
          </div>
        </div>
      </div>

      {/* 2. Positions Table */}
      <div className="bg-agent-card border border-agent-border rounded-lg flex-1 flex flex-col min-h-0 overflow-hidden">
        {/* Table Header */}
        <div className="grid grid-cols-[80px_100px_100px_90px_90px_100px_80px_80px] gap-2 px-4 py-2.5 border-b border-agent-border bg-agent-elevated/30">
          {/* Symbol — sortable */}
          <button
            onClick={() => handleSort('symbol')}
            className="text-xs uppercase tracking-wider text-agent-text-muted hover:text-agent-text text-left transition-colors font-sans"
          >
            Symbol {sortKey === 'symbol' && (sortDir === 'asc' ? '▲' : '▼')}
          </button>
          {/* Entry — not sortable */}
          <div className="text-xs uppercase tracking-wider text-agent-text-muted text-right font-sans">
            Entry
          </div>
          {/* Current — not sortable */}
          <div className="text-xs uppercase tracking-wider text-agent-text-muted text-right font-sans">
            Current
          </div>
          {/* Quantity — not sortable */}
          <div className="text-xs uppercase tracking-wider text-agent-text-muted text-right font-sans">
            Quantity
          </div>
          {/* Cost — not sortable */}
          <div className="text-xs uppercase tracking-wider text-agent-text-muted text-right font-sans">
            Cost
          </div>
          {/* P&L USD — not sortable */}
          <div className="text-xs uppercase tracking-wider text-agent-text-muted text-right font-sans">
            P&L USD
          </div>
          {/* P&L % — sortable (default sort) */}
          <button
            onClick={() => handleSort('pnlPercent')}
            className="text-xs uppercase tracking-wider text-agent-text-muted hover:text-agent-text text-right transition-colors font-sans"
          >
            P&L % {sortKey === 'pnlPercent' && (sortDir === 'asc' ? '▲' : '▼')}
          </button>
          {/* Hold Time — sortable */}
          <button
            onClick={() => handleSort('entryTime')}
            className="text-xs uppercase tracking-wider text-agent-text-muted hover:text-agent-text text-right transition-colors font-sans"
          >
            Hold {sortKey === 'entryTime' && (sortDir === 'asc' ? '▲' : '▼')}
          </button>
        </div>

        {/* Table Rows — scrollable */}
        <div className="flex-1 overflow-y-auto min-h-0">
          {positions.length === 0 ? (
            /* Empty State */
            <div className="h-full flex flex-col items-center justify-center gap-3 p-8">
              <div className="text-6xl opacity-30">📈</div>
              <div className="text-agent-text font-mono text-sm">No open spot positions</div>
              <div className="text-agent-text-muted text-xs text-center max-w-xs">
                {mrEnabled
                  ? 'Mean Reversion will open positions when Z-score signals trigger'
                  : 'Enable Mean Reversion strategy in Strategy Dropdown'}
              </div>
            </div>
          ) : (
            /* Position Rows */
            sorted.map((pos, index) => {
              const holdTime = Date.now() - pos.entryTime
              return (
                <div
                  key={pos.symbol}
                  className={`grid grid-cols-[80px_100px_100px_90px_90px_100px_80px_80px] gap-2 px-4 py-2 border-b border-agent-border/30 hover:bg-agent-elevated/20 transition-colors ${
                    index % 2 === 1 ? 'bg-agent-elevated/10' : ''
                  }`}
                >
                  {/* Symbol */}
                  <div className="text-agent-cyan font-semibold text-sm font-mono">
                    {pos.symbol}
                  </div>
                  {/* Entry */}
                  <div className="text-agent-text-muted text-sm font-mono tabular-nums text-right">
                    ${pos.entryPrice.toFixed(2)}
                  </div>
                  {/* Current */}
                  <div className="text-agent-text-muted text-sm font-mono tabular-nums text-right">
                    ${pos.currentPrice.toFixed(2)}
                  </div>
                  {/* Quantity */}
                  <div className="text-agent-text text-sm font-mono tabular-nums text-right">
                    {pos.quantity.toFixed(4)}
                  </div>
                  {/* Cost */}
                  <div className="text-agent-text-muted text-sm font-mono tabular-nums text-right">
                    ${pos.costBasis.toFixed(2)}
                  </div>
                  {/* P&L USD */}
                  <div
                    className={`text-sm font-mono font-semibold tabular-nums text-right ${
                      pos.unrealizedPnl >= 0 ? 'text-agent-green' : 'text-agent-red'
                    }`}
                  >
                    {pos.unrealizedPnl >= 0 ? '+' : ''}${pos.unrealizedPnl.toFixed(2)}
                  </div>
                  {/* P&L % */}
                  <div
                    className={`text-sm font-mono font-bold tabular-nums text-right ${
                      pos.unrealizedPnlPercent >= 0 ? 'text-agent-green' : 'text-agent-red'
                    }`}
                  >
                    {pos.unrealizedPnlPercent >= 0 ? '+' : ''}
                    {pos.unrealizedPnlPercent.toFixed(1)}%
                  </div>
                  {/* Hold Time */}
                  <div className="text-agent-text-muted text-sm font-mono text-right">
                    {formatDuration(holdTime)}
                  </div>
                </div>
              )
            })
          )}
        </div>
      </div>
    </div>
  )
}

export default SpotCryptoView
