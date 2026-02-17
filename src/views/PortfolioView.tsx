import React, { useEffect, useState, useCallback } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { MatrixCard, MatrixStatsGrid, MatrixBadge, MatrixLoading, MatrixButton, AnimatedCounter } from '@/components/ui'
import { useWalletStore } from '@/stores'
import { dataClient } from '@/services/api/DataClient'
import { positionLifecycleManager, type PositionStatus } from '@/services/trading'
import type { Position, Trade } from '@/types'
import { cn } from '@/utils/cn'

const containerVariants = {
  hidden: {},
  show: { transition: { staggerChildren: 0.06 } },
}

const itemVariants = {
  hidden: { opacity: 0, y: 12 },
  show: { opacity: 1, y: 0, transition: { type: 'spring', stiffness: 300, damping: 25 } },
}

/**
 * PortfolioView - Portfolio overview and position management
 */
export const PortfolioView: React.FC = () => {
  const { isConnected, balance: usdcBalance } = useWalletStore()
  const [activeView, setActiveView] = useState<'markets' | 'spot' | 'closed'>('markets')
  const [positions, setPositions] = useState<Position[]>([])
  const [trackedPositions, setTrackedPositions] = useState<PositionStatus[]>([])
  const [recentTrades, setRecentTrades] = useState<Trade[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [closedPositions, setClosedPositions] = useState<Position[]>([])
  const [closedLoading, setClosedLoading] = useState(false)
  const [closedFetched, setClosedFetched] = useState(false)
  const [closingPositions, setClosingPositions] = useState<Set<string>>(new Set())
  const [confirmClose, setConfirmClose] = useState<string | null>(null)
  const [confirmCloseAll, setConfirmCloseAll] = useState(false)

  // Fetch portfolio data from API
  useEffect(() => {
    const fetchData = async () => {
      if (!isConnected) return

      setLoading(true)
      setError(null)
      try {
        const [positionsData, tradesData] = await Promise.all([
          dataClient.getPositions(),
          dataClient.getTradeHistory({ limit: 10 }),
        ])
        setPositions(positionsData)
        setRecentTrades(tradesData)
      } catch (err) {
        console.error('Failed to fetch portfolio:', err)
        setError(err instanceof Error ? err.message : 'Failed to fetch portfolio data')
      } finally {
        setLoading(false)
      }
    }

    fetchData()
    const interval = setInterval(fetchData, 30000)
    return () => clearInterval(interval)
  }, [isConnected])

  // Fetch closed positions on-demand when tab is selected
  useEffect(() => {
    if (activeView !== 'closed' || !isConnected || closedFetched) return

    const fetchClosed = async () => {
      setClosedLoading(true)
      try {
        const data = await dataClient.getClosedPositions({ limit: 50 })
        setClosedPositions(data)
        setClosedFetched(true)
      } catch (err) {
        console.error('Failed to fetch closed positions:', err)
      } finally {
        setClosedLoading(false)
      }
    }
    fetchClosed()
  }, [activeView, isConnected, closedFetched])

  // Subscribe to locally tracked positions (PLM)
  useEffect(() => {
    // Initial load
    setTrackedPositions(positionLifecycleManager.getPositions())

    // Subscribe to changes
    return positionLifecycleManager.onChange(() => {
      setTrackedPositions(positionLifecycleManager.getPositions())
    })
  }, [])

  // Refresh PLM positions periodically (for P&L updates)
  useEffect(() => {
    const interval = setInterval(() => {
      setTrackedPositions(positionLifecycleManager.getPositions())
    }, 5000)
    return () => clearInterval(interval)
  }, [])

  const handleClosePosition = useCallback(async (tokenId: string) => {
    setClosingPositions(prev => new Set(prev).add(tokenId))
    setConfirmClose(null)

    try {
      await positionLifecycleManager.forceClosePosition(tokenId)
    } catch (error) {
      console.error('Failed to close position:', error)
    } finally {
      setClosingPositions(prev => {
        const next = new Set(prev)
        next.delete(tokenId)
        return next
      })
    }
  }, [])

  const handleCloseAll = useCallback(async () => {
    setConfirmCloseAll(false)
    const positions = positionLifecycleManager.getPositions()
    const tokenIds = positions.map(p => p.tokenId)
    setClosingPositions(new Set(tokenIds))

    try {
      await positionLifecycleManager.forceCloseAll()
    } catch (error) {
      console.error('Failed to close all positions:', error)
    } finally {
      setClosingPositions(new Set())
    }
  }, [])

  const positionsValue = positions.reduce((sum, p) => sum + (p.currentPrice * p.size), 0)
  const trackedValue = trackedPositions.reduce((sum, p) => sum + p.currentPrice * p.size, 0)
  const totalValue = usdcBalance + positionsValue + trackedValue
  const unrealizedPnL = positions.reduce((sum, p) => sum + (p.pnl?.dollar || 0), 0)
    + trackedPositions.reduce((sum, p) => sum + p.pnlUsd, 0)

  const totalPositionCount = positions.length + trackedPositions.length
  const stats: { label: string; value: string; variant?: 'profit' | 'loss' | 'default' }[] = [
    { label: 'Total Value', value: `$${totalValue.toFixed(2)}` },
    { label: 'USDC Balance', value: `$${usdcBalance.toFixed(2)}` },
    { label: 'Positions', value: `${totalPositionCount} (${trackedPositions.length} tracked)` },
    { label: 'Unrealized P&L', value: `$${unrealizedPnL.toFixed(2)}`, variant: unrealizedPnL >= 0 ? 'profit' : 'loss' },
  ]

  if (!isConnected) {
    return (
      <div className="h-full flex items-center justify-center">
        <motion.div
          className="text-center"
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4 }}
        >
          <div className="text-6xl text-matrix-primary/20 mb-4">◇</div>
          <h2 className="text-matrix-primary text-xl font-mono mb-2">Wallet Not Connected</h2>
          <p className="text-matrix-text-secondary font-sans">Connect your wallet in Settings to view portfolio</p>
        </motion.div>
      </div>
    )
  }

  return (
    <div className="h-full flex flex-col gap-4">
      {/* View Toggle */}
      <div className="flex items-center gap-2">
        <button
          onClick={() => setActiveView('markets')}
          className={`px-4 py-2 rounded-md text-sm font-sans font-semibold transition-colors ${
            activeView === 'markets'
              ? 'bg-matrix-primary/15 text-matrix-primary border border-matrix-primary/30'
              : 'text-matrix-text-secondary hover:text-matrix-text'
          }`}
        >
          <span className={activeView === 'markets' ? 'mr-1.5 inline-block w-1.5 h-1.5 rounded-full bg-matrix-primary' : 'mr-1.5 inline-block w-1.5 h-1.5 rounded-full bg-matrix-text-secondary'} />
          Prediction Markets
        </button>
        <button
          onClick={() => setActiveView('spot')}
          className={`px-4 py-2 rounded-md text-sm font-sans font-semibold transition-colors ${
            activeView === 'spot'
              ? 'bg-matrix-primary/15 text-matrix-primary border border-matrix-primary/30'
              : 'text-matrix-text-secondary hover:text-matrix-text'
          }`}
        >
          <span className={activeView === 'spot' ? 'mr-1.5 inline-block w-1.5 h-1.5 rounded-full bg-matrix-primary' : 'mr-1.5 inline-block w-1.5 h-1.5 rounded-full bg-matrix-text-secondary'} />
          Spot Crypto
        </button>
        <button
          onClick={() => setActiveView('closed')}
          className={`px-4 py-2 rounded-md text-sm font-sans font-semibold transition-colors ${
            activeView === 'closed'
              ? 'bg-matrix-primary/15 text-matrix-primary border border-matrix-primary/30'
              : 'text-matrix-text-secondary hover:text-matrix-text'
          }`}
        >
          <span className={activeView === 'closed' ? 'mr-1.5 inline-block w-1.5 h-1.5 rounded-full bg-matrix-primary' : 'mr-1.5 inline-block w-1.5 h-1.5 rounded-full bg-matrix-text-secondary'} />
          Closed
        </button>
      </div>

      {/* Stats */}
      <MatrixStatsGrid stats={stats} />

      {/* Error banner */}
      {error && (
        <div className="flex items-center gap-2 bg-red-900/10 border border-red-500/20 rounded-lg px-4 py-2 text-red-400 text-sm font-mono">
          <span>✕</span>
          <span>{error}</span>
        </div>
      )}

      {/* Main content */}
      {activeView === 'markets' ? (
      <div className="flex-1 grid grid-cols-1 md:grid-cols-2 gap-4 min-h-0">
        {/* Positions — gradient variant */}
        <MatrixCard title="OPEN POSITIONS" subtitle={`${totalPositionCount} positions`} variant="gradient" className="flex flex-col min-h-0">
          {/* Force Close All button — only visible when tracked positions exist */}
          <AnimatePresence>
            {trackedPositions.length > 0 && (
              <motion.div
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: 'auto', opacity: 1 }}
                exit={{ height: 0, opacity: 0 }}
                className="mb-3 flex justify-end overflow-hidden"
              >
                {confirmCloseAll ? (
                  <div className="flex items-center gap-2">
                    <span className="text-red-400 text-xs font-mono">Close all {trackedPositions.length} tracked positions?</span>
                    <MatrixButton variant="danger" size="sm" onClick={handleCloseAll}>
                      Confirm
                    </MatrixButton>
                    <MatrixButton variant="ghost" size="sm" onClick={() => setConfirmCloseAll(false)}>
                      Cancel
                    </MatrixButton>
                  </div>
                ) : (
                  <MatrixButton
                    variant="danger"
                    size="sm"
                    onClick={() => setConfirmCloseAll(true)}
                  >
                    Force Close All
                  </MatrixButton>
                )}
              </motion.div>
            )}
          </AnimatePresence>

          <div className="flex-1 overflow-auto">
            {loading && positions.length === 0 && trackedPositions.length === 0 ? (
              <div className="flex justify-center py-8">
                <MatrixLoading text="Loading positions..." />
              </div>
            ) : positions.length === 0 && trackedPositions.length === 0 ? (
              <div className="text-center py-8 text-matrix-text-secondary">
                <p className="font-sans">No open positions</p>
                <p className="text-xs mt-1 font-sans">Start trading to see positions here</p>
              </div>
            ) : (
              <motion.div
                className="space-y-2"
                variants={containerVariants}
                initial="hidden"
                animate="show"
              >
                {/* Locally tracked positions (PLM) — with close buttons */}
                {trackedPositions.map((pos) => (
                  <motion.div key={pos.tokenId} variants={itemVariants}>
                    <TrackedPositionCard
                      position={pos}
                      isClosing={closingPositions.has(pos.tokenId)}
                      showConfirm={confirmClose === pos.tokenId}
                      onRequestClose={() => setConfirmClose(pos.tokenId)}
                      onConfirmClose={() => handleClosePosition(pos.tokenId)}
                      onCancelClose={() => setConfirmClose(null)}
                    />
                  </motion.div>
                ))}

                {/* API positions (from Polymarket data API) */}
                {positions.map((position) => (
                  <motion.div key={position.tokenId} variants={itemVariants}>
                    <PositionCard position={position} />
                  </motion.div>
                ))}
              </motion.div>
            )}
          </div>
        </MatrixCard>

        {/* Recent Trades — glass variant */}
        <MatrixCard title="RECENT TRADES" subtitle="Last 10 trades" variant="glass" className="flex flex-col min-h-0">
          <div className="flex-1 overflow-auto">
            {loading ? (
              <div className="flex justify-center py-8">
                <MatrixLoading text="Loading trades..." />
              </div>
            ) : recentTrades.length === 0 ? (
              <div className="text-center py-8 text-matrix-text-secondary">
                <p className="font-sans">No recent trades</p>
                <p className="text-xs mt-1 font-sans">Your trade history will appear here</p>
              </div>
            ) : (
              <motion.div
                className="space-y-2"
                variants={containerVariants}
                initial="hidden"
                animate="show"
              >
                {recentTrades.map((trade) => (
                  <motion.div key={trade.id} variants={itemVariants}>
                    <TradeCard trade={trade} />
                  </motion.div>
                ))}
              </motion.div>
            )}
          </div>
        </MatrixCard>
      </div>
      ) : activeView === 'spot' ? (
        <SpotPortfolioView />
      ) : (
        /* Closed Positions View */
        <div className="flex-1 min-h-0">
          <MatrixCard title="CLOSED POSITIONS" subtitle={`${closedPositions.length} resolved`} variant="gradient" className="h-full flex flex-col min-h-0">
            <div className="flex-1 overflow-auto">
              {closedLoading ? (
                <div className="flex justify-center py-8">
                  <MatrixLoading text="Loading closed positions..." />
                </div>
              ) : closedPositions.length === 0 ? (
                <div className="text-center py-8 text-matrix-text-secondary">
                  <p className="font-sans">No closed positions</p>
                  <p className="text-xs mt-1 font-sans">Resolved positions will appear here</p>
                </div>
              ) : (
                <motion.div
                  className="space-y-2"
                  variants={containerVariants}
                  initial="hidden"
                  animate="show"
                >
                  {closedPositions.map((position) => (
                    <motion.div key={position.tokenId} variants={itemVariants}>
                      <PositionCard position={position} />
                    </motion.div>
                  ))}
                </motion.div>
              )}
            </div>
          </MatrixCard>
        </div>
      )}
    </div>
  )
}

/**
 * Spot Portfolio View - Coinbase spot crypto positions
 */
const SpotPortfolioView: React.FC = () => {
  const [spotPositions, setSpotPositions] = useState<any[]>([])

  useEffect(() => {
    const updatePositions = async () => {
      try {
        // Import MeanReversionStrategy dynamically to avoid circular deps
        const { meanReversionStrategy } = await import('@/services/strategies/MeanReversionStrategy')
        const positions = meanReversionStrategy.getOpenPositions()
        setSpotPositions(positions)
      } catch (error) {
        console.error('Failed to fetch spot positions:', error)
      }
    }

    updatePositions()
    const interval = setInterval(updatePositions, 5000)
    return () => clearInterval(interval)
  }, [])

  return (
    <div className="flex-1 grid grid-cols-1 md:grid-cols-2 gap-4 min-h-0">
      {/* Spot Positions */}
      <MatrixCard title="OPEN SPOT POSITIONS" subtitle={`${spotPositions.length} positions`} variant="gradient" className="flex flex-col min-h-0">
        <div className="flex-1 overflow-auto">
          {spotPositions.length === 0 ? (
            <div className="text-center py-8 text-matrix-text-secondary">
              <p className="font-sans">No open spot positions</p>
              <p className="text-xs mt-1 font-sans">Enable assets in Settings → Mean Reversion Strategy</p>
            </div>
          ) : (
            <motion.div
              className="space-y-2"
              variants={containerVariants}
              initial="hidden"
              animate="show"
            >
              {spotPositions.map((position) => (
                <motion.div key={position.symbol} variants={itemVariants}>
                  <SpotPositionCard position={position} />
                </motion.div>
              ))}
            </motion.div>
          )}
        </div>
      </MatrixCard>

      {/* Placeholder for future features */}
      <MatrixCard title="SPOT HISTORY" subtitle="Coming soon" variant="glass" className="flex flex-col min-h-0">
        <div className="flex-1 flex items-center justify-center text-matrix-text-secondary">
          <div className="text-center">
            <p className="font-sans">Spot trade history</p>
            <p className="text-xs mt-1 font-sans">Will show completed spot trades</p>
          </div>
        </div>
      </MatrixCard>
    </div>
  )
}

/**
 * Spot Position Card Component
 */
const SpotPositionCard: React.FC<{ position: any }> = ({ position }) => {
  const pnlUsd = position.currentPrice * position.quantity - position.costBasis
  const pnlPercent = (pnlUsd / position.costBasis) * 100
  const isProfit = pnlUsd >= 0
  const holdTimeMs = Date.now() - position.entryTimestamp
  const holdTimeStr = formatHoldTime(holdTimeMs)

  return (
    <div className={cn(
      'bg-matrix-bg/60 border rounded-lg p-3 relative overflow-hidden',
      'border-matrix-border'
    )}>
      {/* P&L accent bar */}
      <div className={cn(
        'absolute left-0 top-0 bottom-0 w-0.5',
        isProfit ? 'bg-matrix-primary' : 'bg-red-400'
      )} />

      <div className="flex items-start justify-between mb-2 pl-2">
        <div className="flex-1 min-w-0">
          <p className="text-matrix-text-primary text-sm font-mono truncate">
            {position.symbol}
          </p>
          <div className="flex items-center gap-2 mt-1">
            <MatrixBadge variant="success" size="sm">
              LONG
            </MatrixBadge>
            <span className="text-matrix-text-secondary text-xs font-sans">
              {position.quantity.toFixed(6)} @ ${position.entryPrice.toFixed(2)}
            </span>
          </div>
        </div>
        <div className="text-right">
          <p className={cn(
            'text-sm font-mono font-semibold',
            isProfit ? 'text-matrix-primary' : 'text-red-400'
          )}>
            {isProfit ? '+' : ''}${pnlUsd.toFixed(2)}
          </p>
          <p className={cn(
            'text-xs font-mono',
            isProfit ? 'text-matrix-primary' : 'text-red-400'
          )}>
            {isProfit ? '+' : ''}{pnlPercent.toFixed(2)}%
          </p>
        </div>
      </div>

      <div className="grid grid-cols-3 gap-2 text-xs pl-2">
        <div>
          <p className="text-matrix-text-secondary font-sans">Current</p>
          <p className="text-matrix-text font-mono">${position.currentPrice.toFixed(2)}</p>
        </div>
        <div>
          <p className="text-matrix-text-secondary font-sans">Value</p>
          <p className="text-matrix-text font-mono">${(position.currentPrice * position.quantity).toFixed(2)}</p>
        </div>
        <div>
          <p className="text-matrix-text-secondary font-sans">Hold Time</p>
          <p className="text-matrix-text font-mono">{holdTimeStr}</p>
        </div>
      </div>
    </div>
  )
}

function formatHoldTime(ms: number): string {
  const seconds = Math.floor(ms / 1000)
  const minutes = Math.floor(seconds / 60)
  const hours = Math.floor(minutes / 60)

  if (hours > 0) {
    return `${hours}h ${minutes % 60}m`
  } else if (minutes > 0) {
    return `${minutes}m ${seconds % 60}s`
  } else {
    return `${seconds}s`
  }
}

/**
 * Position Card Component
 */
const PositionCard: React.FC<{ position: Position }> = ({ position }) => {
  const pnlPercent = position.pnl?.percent || 0
  const isProfit = pnlPercent >= 0
  const currentValue = position.currentPrice * position.size

  return (
    <div className={cn(
      'bg-matrix-bg/60 border rounded-lg p-3 relative overflow-hidden',
      'border-matrix-border'
    )}>
      {/* P&L accent bar */}
      <div className={cn(
        'absolute left-0 top-0 bottom-0 w-0.5',
        isProfit ? 'bg-matrix-primary' : 'bg-red-400'
      )} />

      <div className="flex items-start justify-between mb-2 pl-2">
        <div className="flex-1 min-w-0">
          <p className="text-matrix-text-primary text-sm font-mono truncate">
            {position.marketQuestion}
          </p>
          <div className="flex items-center gap-2 mt-1">
            <MatrixBadge variant={position.outcome.toLowerCase() === 'yes' ? 'success' : 'danger'} size="sm">
              {position.outcome.toUpperCase()}
            </MatrixBadge>
            <span className="text-matrix-text-secondary text-xs font-sans">
              {position.size.toFixed(0)} shares
            </span>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-3 gap-2 text-xs font-mono pl-2">
        <div>
          <span className="text-matrix-text-secondary font-sans">Entry:</span>
          <span className="text-matrix-primary ml-1">{(position.entryPrice * 100).toFixed(1)}¢</span>
        </div>
        <div>
          <span className="text-matrix-text-secondary font-sans">Value:</span>
          <span className="text-matrix-primary ml-1">${currentValue.toFixed(2)}</span>
        </div>
        <div>
          <span className="text-matrix-text-secondary font-sans">P&L:</span>
          <span className={cn('ml-1', isProfit ? 'text-matrix-primary' : 'text-red-400')}>
            {isProfit ? '+' : ''}{pnlPercent.toFixed(1)}%
          </span>
        </div>
      </div>
    </div>
  )
}

/**
 * Tracked Position Card — positions managed by PositionLifecycleManager
 * Shows stop-loss/take-profit levels and a close button
 */
const TrackedPositionCard: React.FC<{
  position: PositionStatus
  isClosing: boolean
  showConfirm: boolean
  onRequestClose: () => void
  onConfirmClose: () => void
  onCancelClose: () => void
}> = ({ position, isClosing, showConfirm, onRequestClose, onConfirmClose, onCancelClose }) => {
  const isProfit = position.pnlPercent >= 0
  const currentValue = position.currentPrice * position.size

  return (
    <div className={cn(
      'bg-matrix-bg/60 border rounded-lg p-3 relative overflow-hidden',
      position.isStale ? 'border-yellow-500/30' : 'border-matrix-primary/30'
    )}>
      {/* P&L accent bar */}
      <motion.div
        className={cn(
          'absolute left-0 top-0 bottom-0 w-0.5',
          isProfit ? 'bg-matrix-primary' : 'bg-red-400'
        )}
        animate={isProfit ? {
          boxShadow: ['0 0 4px #00ff00', '0 0 8px #00ff00', '0 0 4px #00ff00']
        } : {
          boxShadow: ['0 0 4px #f87171', '0 0 8px #f87171', '0 0 4px #f87171']
        }}
        transition={{ duration: 2, repeat: Infinity }}
      />

      <div className="flex items-start justify-between mb-2 pl-2">
        <div className="flex-1 min-w-0">
          <p className="text-matrix-text-primary text-sm font-mono truncate">
            {position.question}
          </p>
          <div className="flex items-center gap-2 mt-1">
            <MatrixBadge variant={position.outcome === 'yes' ? 'success' : 'danger'} size="sm">
              {position.outcome.toUpperCase()}
            </MatrixBadge>
            <MatrixBadge variant="default" size="sm">
              {position.strategy.toUpperCase()}
            </MatrixBadge>
            {position.isStale && (
              <span className="text-yellow-400 text-[10px] font-mono">STALE</span>
            )}
          </div>
        </div>

        {/* Close button */}
        <div className="ml-2 flex-shrink-0">
          {showConfirm ? (
            <div className="flex items-center gap-1">
              <MatrixButton variant="danger" size="sm" onClick={onConfirmClose} disabled={isClosing}>
                {isClosing ? '...' : 'Yes'}
              </MatrixButton>
              <MatrixButton variant="ghost" size="sm" onClick={onCancelClose}>
                No
              </MatrixButton>
            </div>
          ) : (
            <MatrixButton
              variant="danger"
              size="sm"
              onClick={onRequestClose}
              disabled={isClosing}
              loading={isClosing}
            >
              Close
            </MatrixButton>
          )}
        </div>
      </div>

      <div className="grid grid-cols-4 gap-2 text-xs font-mono pl-2">
        <div>
          <span className="text-matrix-text-secondary font-sans">Entry:</span>
          <span className="text-matrix-primary ml-1">{(position.entryPrice * 100).toFixed(1)}¢</span>
        </div>
        <div>
          <span className="text-matrix-text-secondary font-sans">Now:</span>
          <span className="text-matrix-primary ml-1">{(position.currentPrice * 100).toFixed(1)}¢</span>
        </div>
        <div>
          <span className="text-matrix-text-secondary font-sans">Value:</span>
          <span className="text-matrix-primary ml-1">${currentValue.toFixed(2)}</span>
        </div>
        <div>
          <span className="text-matrix-text-secondary font-sans">P&L:</span>
          <span className={cn('ml-1', isProfit ? 'text-matrix-primary' : 'text-red-400')}>
            {isProfit ? '+' : ''}{(position.pnlPercent * 100).toFixed(1)}%
          </span>
        </div>
      </div>

      {/* SL/TP indicators */}
      <div className="flex items-center gap-4 mt-2 text-[10px] font-mono text-matrix-text-secondary pl-2">
        <span>SL: -{(position.stopLossPercent * 100).toFixed(0)}%</span>
        <span>TP: +{(position.takeProfitPercent * 100).toFixed(0)}%</span>
        <span>Cost: ${position.costBasis.toFixed(2)}</span>
      </div>
    </div>
  )
}

/**
 * Trade Card Component
 */
const TradeCard: React.FC<{ trade: Trade }> = ({ trade }) => {
  const isBuy = trade.side === 'BUY'
  const total = trade.price * trade.size

  return (
    <div className="bg-matrix-bg/60 border border-matrix-border/50 rounded-lg p-3">
      <div className="flex items-center justify-between mb-1">
        <MatrixBadge variant={isBuy ? 'success' : 'warning'} size="sm">
          {trade.side}
        </MatrixBadge>
        <span className="text-matrix-text-secondary text-xs font-sans">
          {new Date(trade.timestamp).toLocaleString()}
        </span>
      </div>
      <p className="text-matrix-text-primary text-sm font-mono truncate mb-2">
        {trade.marketId}
      </p>
      <div className="flex items-center justify-between text-xs font-mono">
        <span className="text-matrix-text-secondary">
          {trade.size.toFixed(0)} @ {(trade.price * 100).toFixed(1)}¢
        </span>
        <span className="text-matrix-primary">
          ${total.toFixed(2)}
        </span>
      </div>
    </div>
  )
}

export default PortfolioView
