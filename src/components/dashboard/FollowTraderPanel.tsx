import React, { useEffect, useState, useCallback, useRef, useMemo } from 'react'
import { useSettingsStore } from '@/stores'
import { DataClient } from '@/services/api/DataClient'
import { strategyManager, type StrategyState } from '@/services/strategies'
import type { Position, PortfolioSummary, Trade } from '@/types'

/**
 * FollowTraderPanel — View-only copy-trading panel.
 *
 * Paste any public Polymarket wallet address to see their open positions,
 * win rate, P&L, and recent trades. Uses a separate DataClient instance
 * so the user's own wallet address is unaffected.
 *
 * Replaces the old ReadinessPanel in the left sidebar (290px column).
 */

const POLL_INTERVAL_MS = 60_000 // Refresh followed trader data every 60s
const RECENT_TRADES_COUNT = 5

function isValidAddress(addr: string): boolean {
  return /^0x[a-fA-F0-9]{40}$/.test(addr.trim())
}

function truncateAddress(addr: string): string {
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`
}

function timeAgo(date: Date | string): string {
  const now = Date.now()
  const then = new Date(date).getTime()
  const diffMs = now - then
  const diffMin = Math.floor(diffMs / 60_000)
  if (diffMin < 1) return 'just now'
  if (diffMin < 60) return `${diffMin}m ago`
  const diffHr = Math.floor(diffMin / 60)
  if (diffHr < 24) return `${diffHr}h ago`
  const diffDays = Math.floor(diffHr / 24)
  return `${diffDays}d ago`
}

function formatUsd(value: number): string {
  const abs = Math.abs(value)
  if (abs >= 1000) return `$${(value / 1000).toFixed(1)}k`
  return `$${value.toFixed(2)}`
}

export const FollowTraderPanel: React.FC = () => {
  const followedAddress = useSettingsStore((s) => s.followedAddress)
  const setFollowedAddress = useSettingsStore((s) => s.setFollowedAddress)

  // Input state (separate from persisted address — only saves on submit)
  const [inputValue, setInputValue] = useState(followedAddress || '')
  const [inputError, setInputError] = useState('')

  // Data state
  const [positions, setPositions] = useState<Position[]>([])
  const [summary, setSummary] = useState<PortfolioSummary | null>(null)
  const [recentTrades, setRecentTrades] = useState<Trade[]>([])
  const [loading, setLoading] = useState(false)
  const [fetchError, setFetchError] = useState('')

  // Copy-trading state
  const [strategies, setStrategies] = useState<StrategyState[]>(strategyManager.getStates())
  const copyState = strategies.find(s => s.id === 'copy-trading')
  const isCopying = copyState?.enabled ?? false
  const [copyToggling, setCopyToggling] = useState(false)

  useEffect(() => {
    return strategyManager.subscribe(setStrategies)
  }, [])

  const handleCopyToggle = useCallback(async () => {
    setCopyToggling(true)
    try {
      await strategyManager.toggleStrategy('copy-trading')
    } catch (err) {
      console.error('[FollowTrader] Failed to toggle copy trading:', err)
    } finally {
      setCopyToggling(false)
    }
  }, [])

  // Separate DataClient instance — never touches the singleton
  const clientRef = useRef<DataClient | null>(null)

  // Create/update client when followed address changes
  const activeClient = useMemo(() => {
    if (!followedAddress) return null
    const client = new DataClient()
    client.setWalletAddress(followedAddress)
    clientRef.current = client
    return client
  }, [followedAddress])

  // Fetch data from the followed address
  const fetchData = useCallback(async () => {
    if (!activeClient) return
    setFetchError('')
    try {
      const [pos, summ, trades] = await Promise.all([
        activeClient.getPositions(),
        activeClient.getPortfolioSummary(),
        activeClient.getTradeHistory({ limit: RECENT_TRADES_COUNT }),
      ])
      setPositions(pos)
      setSummary(summ)
      setRecentTrades(trades)
    } catch (err) {
      console.error('[FollowTrader] Fetch failed:', err)
      setFetchError('Failed to load trader data')
    }
  }, [activeClient])

  // Initial fetch + polling
  useEffect(() => {
    if (!activeClient) return
    setLoading(true)
    fetchData().finally(() => setLoading(false))
    const id = setInterval(fetchData, POLL_INTERVAL_MS)
    return () => clearInterval(id)
  }, [activeClient, fetchData])

  // Sync input when persisted address changes externally
  useEffect(() => {
    setInputValue(followedAddress || '')
  }, [followedAddress])

  const handleFollow = useCallback(() => {
    const addr = inputValue.trim()
    if (!addr) {
      setFollowedAddress('')
      return
    }
    if (!isValidAddress(addr)) {
      setInputError('Invalid Ethereum address')
      return
    }
    setInputError('')
    setFollowedAddress(addr)
  }, [inputValue, setFollowedAddress])

  const handleClear = useCallback(() => {
    setFollowedAddress('')
    setInputValue('')
    setInputError('')
    setPositions([])
    setSummary(null)
    setRecentTrades([])
    setFetchError('')
  }, [setFollowedAddress])

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter') handleFollow()
    },
    [handleFollow]
  )

  // ── No address set: show input prompt ──
  if (!followedAddress) {
    return (
      <div className="bg-agent-card border border-matrix-border rounded-lg p-3">
        <div className="text-xs font-mono font-semibold text-matrix-green mb-2">
          FOLLOW TRADER
        </div>
        <p className="text-[10px] font-mono text-matrix-green/70 mb-2">
          Paste a Polymarket trader's wallet address to view their positions & stats
        </p>
        <div className="flex gap-1.5">
          <input
            type="text"
            value={inputValue}
            onChange={(e) => {
              setInputValue(e.target.value)
              setInputError('')
            }}
            onKeyDown={handleKeyDown}
            placeholder="0x..."
            className={`flex-1 bg-agent-bg border ${
              inputError ? 'border-red-500/60' : 'border-matrix-border'
            } rounded px-2 py-1 text-[10px] font-mono text-matrix-green placeholder:text-matrix-green/40 focus:outline-none focus:border-matrix-green/50`}
          />
          <button
            onClick={handleFollow}
            className="px-2 py-1 text-[10px] font-mono font-semibold bg-matrix-green/10 text-matrix-green border border-matrix-green/30 rounded hover:bg-matrix-green/20 transition-colors"
          >
            Follow
          </button>
        </div>
        {inputError && (
          <p className="text-[9px] font-mono text-red-400 mt-1">{inputError}</p>
        )}
      </div>
    )
  }

  // ── Address set: show trader data ──
  return (
    <div className="bg-agent-card border border-matrix-border rounded-lg p-3 flex flex-col min-h-0 max-h-full overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-1.5">
          <span className="text-[10px] font-mono font-semibold text-matrix-green">
            FOLLOWING
          </span>
          <a
            href={`https://polygonscan.com/address/${followedAddress}`}
            target="_blank"
            rel="noopener noreferrer"
            className="text-[10px] font-mono text-cyan-400 hover:text-cyan-300 transition-colors"
            title={followedAddress}
          >
            {truncateAddress(followedAddress)}
          </a>
        </div>
        <button
          onClick={handleClear}
          className="text-[9px] font-mono text-matrix-green/60 hover:text-red-400 transition-colors"
          title="Stop following"
        >
          ✕
        </button>
      </div>

      {/* Copy Trading toggle */}
      <div className="flex items-center justify-between mb-2 px-0.5">
        <div className="flex items-center gap-1.5">
          {isCopying && (
            <span className="w-1.5 h-1.5 rounded-full bg-agent-green animate-pulse" />
          )}
          <span className="text-[9px] font-mono text-matrix-green/70">
            {isCopying ? 'Copying trades' : 'Copy trading off'}
          </span>
        </div>
        <button
          onClick={handleCopyToggle}
          disabled={copyToggling}
          className={`relative w-8 h-4 rounded-full transition-colors shrink-0 cursor-pointer disabled:opacity-50 ${
            isCopying ? 'bg-agent-green/30' : 'bg-agent-elevated'
          }`}
          title={isCopying ? 'Disable copy trading' : 'Enable copy trading'}
        >
          <span
            className={`absolute top-0.5 w-3 h-3 rounded-full transition-all ${
              isCopying ? 'left-[18px] bg-agent-green' : 'left-0.5 bg-agent-text-label'
            }`}
          />
        </button>
      </div>

      {/* Loading state */}
      {loading && (
        <div className="text-[10px] font-mono text-matrix-green/60 text-center py-4">
          Loading trader data...
        </div>
      )}

      {/* Error state */}
      {fetchError && !loading && (
        <div className="text-center py-3">
          <p className="text-[10px] font-mono text-red-400 mb-1">{fetchError}</p>
          <button
            onClick={() => {
              setLoading(true)
              fetchData().finally(() => setLoading(false))
            }}
            className="text-[9px] font-mono text-matrix-green/60 hover:text-matrix-green transition-colors"
          >
            Retry
          </button>
        </div>
      )}

      {/* Stats row */}
      {summary && !loading && !fetchError && (
        <>
          <div className="grid grid-cols-3 gap-1.5 mb-2">
            <div className="bg-agent-bg rounded px-1.5 py-1 text-center">
              <div className="text-[9px] font-mono text-matrix-green/60">Positions</div>
              <div className="text-xs font-mono font-semibold text-matrix-green">
                {summary.positionCount}
              </div>
            </div>
            <div className="bg-agent-bg rounded px-1.5 py-1 text-center">
              <div className="text-[9px] font-mono text-matrix-green/60">Win Rate</div>
              <div className="text-xs font-mono font-semibold text-matrix-green">
                {summary.winRate !== undefined ? `${summary.winRate.toFixed(0)}%` : '—'}
              </div>
            </div>
            <div className="bg-agent-bg rounded px-1.5 py-1 text-center">
              <div className="text-[9px] font-mono text-matrix-green/60">P&L</div>
              <div
                className={`text-xs font-mono font-semibold ${
                  summary.totalPnl >= 0 ? 'text-green-400' : 'text-red-400'
                }`}
              >
                {summary.totalPnl >= 0 ? '+' : ''}
                {formatUsd(summary.totalPnl)}
              </div>
            </div>
          </div>

          {/* Open positions */}
          <div className="text-[9px] font-mono text-matrix-green/60 mb-1">
            OPEN POSITIONS ({positions.length})
          </div>
          {positions.length === 0 ? (
            <div className="text-[10px] font-mono text-matrix-green/70 text-center py-2 mb-2">
              No open positions
            </div>
          ) : (
            <div className="flex-1 overflow-y-auto min-h-0 mb-2 space-y-1 scrollbar-thin scrollbar-track-transparent scrollbar-thumb-matrix-green/20">
              {positions.map((pos) => (
                <div
                  key={pos.tokenId}
                  className="bg-agent-bg rounded px-2 py-1.5 border border-matrix-border/30"
                >
                  <div className="flex items-start justify-between gap-1">
                    <div className="text-[9px] font-mono text-matrix-green/70 leading-tight line-clamp-2 flex-1">
                      {pos.marketQuestion}
                    </div>
                    <span
                      className={`text-[9px] font-mono font-semibold shrink-0 ${
                        pos.outcome === 'Yes' ? 'text-green-400' : 'text-red-400'
                      }`}
                    >
                      {pos.outcome}
                    </span>
                  </div>
                  <div className="flex items-center justify-between mt-1">
                    <span className="text-[9px] font-mono text-matrix-green/60">
                      {pos.size.toFixed(1)} @ {pos.entryPrice.toFixed(2)} → {pos.currentPrice.toFixed(2)}
                    </span>
                    <span
                      className={`text-[9px] font-mono font-semibold ${
                        pos.pnl.percent >= 0 ? 'text-green-400' : 'text-red-400'
                      }`}
                    >
                      {pos.pnl.percent >= 0 ? '+' : ''}
                      {pos.pnl.percent.toFixed(1)}%
                    </span>
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Recent trades */}
          {recentTrades.length > 0 && (
            <>
              <div className="text-[9px] font-mono text-matrix-green/60 mb-1">
                RECENT TRADES
              </div>
              <div className="space-y-0.5">
                {recentTrades.slice(0, RECENT_TRADES_COUNT).map((trade, i) => (
                  <div
                    key={`${trade.marketId}-${trade.timestamp}-${i}`}
                    className="flex items-center justify-between text-[9px] font-mono"
                  >
                    <div className="flex items-center gap-1 flex-1 min-w-0">
                      <span
                        className={`font-semibold shrink-0 ${
                          trade.side === 'BUY' ? 'text-green-400' : 'text-red-400'
                        }`}
                      >
                        {trade.side === 'BUY' ? 'B' : 'S'}
                      </span>
                      <span className="text-matrix-green/70 truncate">
                        {trade.size.toFixed(1)} @ {trade.price.toFixed(2)}
                      </span>
                    </div>
                    <span className="text-matrix-green/70 shrink-0 ml-1">
                      {timeAgo(trade.timestamp)}
                    </span>
                  </div>
                ))}
              </div>
            </>
          )}
        </>
      )}
    </div>
  )
}
