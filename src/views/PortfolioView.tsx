import React, { useEffect, useState } from 'react'
import { MatrixCard, MatrixStatsGrid, MatrixBadge, MatrixLoading } from '@/components/ui'
import { useWalletStore } from '@/stores'
import { dataClient } from '@/services/api'
import type { Position, Trade } from '@/types'
import { cn } from '@/utils/cn'

/**
 * PortfolioView - Portfolio overview and position management
 */
export const PortfolioView: React.FC = () => {
  const { isConnected, usdcBalance } = useWalletStore()
  const [positions, setPositions] = useState<Position[]>([])
  const [recentTrades, setRecentTrades] = useState<Trade[]>([])
  const [loading, setLoading] = useState(false)

  // Fetch portfolio data
  useEffect(() => {
    const fetchData = async () => {
      if (!isConnected) return
      
      setLoading(true)
      try {
        const [positionsData, tradesData] = await Promise.all([
          dataClient.getPositions(),
          dataClient.getTradeHistory({ limit: 10 }),
        ])
        setPositions(positionsData)
        setRecentTrades(tradesData)
      } catch (error) {
        console.error('Failed to fetch portfolio:', error)
      } finally {
        setLoading(false)
      }
    }

    fetchData()
    const interval = setInterval(fetchData, 30000) // Refresh every 30s
    return () => clearInterval(interval)
  }, [isConnected])

  const positionsValue = positions.reduce((sum, p) => sum + (p.currentPrice * p.size), 0)
  const totalValue = usdcBalance + positionsValue
  const unrealizedPnL = positions.reduce((sum, p) => sum + (p.pnl?.dollar || 0), 0)

  const stats: { label: string; value: string; variant?: 'profit' | 'loss' | 'default' }[] = [
    { label: 'Total Value', value: `$${totalValue.toFixed(2)}` },
    { label: 'USDC Balance', value: `$${usdcBalance.toFixed(2)}` },
    { label: 'Positions Value', value: `$${positionsValue.toFixed(2)}` },
    { label: 'Unrealized P&L', value: `$${unrealizedPnL.toFixed(2)}`, variant: unrealizedPnL >= 0 ? 'profit' : 'loss' },
  ]

  if (!isConnected) {
    return (
      <div className="h-full flex items-center justify-center">
        <div className="text-center">
          <div className="text-6xl text-matrix-primary/20 mb-4">◇</div>
          <h2 className="text-matrix-primary text-xl font-mono mb-2">Wallet Not Connected</h2>
          <p className="text-matrix-text-secondary">Connect your wallet in Settings to view portfolio</p>
        </div>
      </div>
    )
  }

  return (
    <div className="h-full flex flex-col gap-4">
      {/* Stats */}
      <MatrixStatsGrid stats={stats} />

      {/* Main content */}
      <div className="flex-1 grid grid-cols-2 gap-4 min-h-0">
        {/* Positions */}
        <MatrixCard title="OPEN POSITIONS" subtitle={`${positions.length} positions`} className="flex flex-col min-h-0">
          <div className="flex-1 overflow-auto">
            {loading ? (
              <div className="flex justify-center py-8">
                <MatrixLoading text="Loading positions..." />
              </div>
            ) : positions.length === 0 ? (
              <div className="text-center py-8 text-matrix-text-secondary">
                <p>No open positions</p>
                <p className="text-xs mt-1">Start trading to see positions here</p>
              </div>
            ) : (
              <div className="space-y-2">
                {positions.map((position) => (
                  <PositionCard key={position.tokenId} position={position} />
                ))}
              </div>
            )}
          </div>
        </MatrixCard>

        {/* Recent Trades */}
        <MatrixCard title="RECENT TRADES" subtitle="Last 10 trades" className="flex flex-col min-h-0">
          <div className="flex-1 overflow-auto">
            {loading ? (
              <div className="flex justify-center py-8">
                <MatrixLoading text="Loading trades..." />
              </div>
            ) : recentTrades.length === 0 ? (
              <div className="text-center py-8 text-matrix-text-secondary">
                <p>No recent trades</p>
                <p className="text-xs mt-1">Your trade history will appear here</p>
              </div>
            ) : (
              <div className="space-y-2">
                {recentTrades.map((trade) => (
                  <TradeCard key={trade.id} trade={trade} />
                ))}
              </div>
            )}
          </div>
        </MatrixCard>
      </div>
    </div>
  )
}

/**
 * Position Card Component
 */
const PositionCard: React.FC<{ position: Position }> = ({ position }) => {
  const pnlPercent = position.pnl?.percent || 0
  const isProfit = pnlPercent >= 0
  const currentValue = position.currentPrice * position.size

  return (
    <div className="bg-matrix-bg border border-matrix-border rounded-lg p-3">
      <div className="flex items-start justify-between mb-2">
        <div className="flex-1 min-w-0">
          <p className="text-matrix-text-primary text-sm font-mono truncate">
            {position.marketQuestion}
          </p>
          <div className="flex items-center gap-2 mt-1">
            <MatrixBadge variant={position.outcome.toLowerCase() === 'yes' ? 'success' : 'danger'} size="sm">
              {position.outcome.toUpperCase()}
            </MatrixBadge>
            <span className="text-matrix-text-secondary text-xs">
              {position.size.toFixed(0)} shares
            </span>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-3 gap-2 text-xs font-mono">
        <div>
          <span className="text-matrix-text-secondary">Entry:</span>
          <span className="text-matrix-primary ml-1">{(position.entryPrice * 100).toFixed(1)}¢</span>
        </div>
        <div>
          <span className="text-matrix-text-secondary">Value:</span>
          <span className="text-matrix-primary ml-1">${currentValue.toFixed(2)}</span>
        </div>
        <div>
          <span className="text-matrix-text-secondary">P&L:</span>
          <span className={cn('ml-1', isProfit ? 'text-matrix-primary' : 'text-red-400')}>
            {isProfit ? '+' : ''}{pnlPercent.toFixed(1)}%
          </span>
        </div>
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
    <div className="bg-matrix-bg border border-matrix-border/50 rounded-lg p-3">
      <div className="flex items-center justify-between mb-1">
        <MatrixBadge variant={isBuy ? 'success' : 'warning'} size="sm">
          {trade.side}
        </MatrixBadge>
        <span className="text-matrix-text-secondary text-xs">
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
