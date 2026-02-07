import React, { useEffect, useState } from 'react'
import { MatrixCard, MatrixToggle, MatrixBadge, MatrixStatsGrid } from '@/components/ui'
import { strategyManager, type StrategyState } from '@/services/strategies'
import { activityLogger } from '@/services/trading/ActivityLogger'
import type { ActivityItem } from '@/types'
import { useWalletStore } from '@/stores'
import { cn } from '@/utils/cn'

/**
 * TradingTerminal - Main 3-column trading interface
 * Per spec: "Three-column layout: Market Discovery | Analysis | Activity Feed"
 */
export const TradingTerminal: React.FC = () => {
  const { isConnected, usdcBalance } = useWalletStore()
  const [strategies, setStrategies] = useState<StrategyState[]>(strategyManager.getStates())
  const [activities, setActivities] = useState<ActivityItem[]>([])

  // Subscribe to strategy updates
  useEffect(() => {
    return strategyManager.subscribe(setStrategies)
  }, [])

  // Subscribe to activity updates
  useEffect(() => {
    // Get initial activities
    setActivities(activityLogger.getActivities({ limit: 50 }))
    
    // Subscribe to new activities
    return activityLogger.subscribe(() => {
      setActivities(activityLogger.getActivities({ limit: 50 }))
    })
  }, [])

  // Initialize strategies on mount
  useEffect(() => {
    if (isConnected && !strategyManager.isInitialized()) {
      strategyManager.initialize()
    }
  }, [isConnected])

  const handleToggleStrategy = async (id: string) => {
    try {
      await strategyManager.toggleStrategy(id)
    } catch (error) {
      console.error('Failed to toggle strategy:', error)
    }
  }

  const combinedStats = strategyManager.getCombinedStats()

  const stats: { label: string; value: string | number; variant?: 'profit' | 'loss' | 'default' }[] = [
    { label: 'Portfolio Value', value: `$${usdcBalance.toLocaleString(undefined, { minimumFractionDigits: 2 })}` },
    { label: 'Total Trades', value: combinedStats.totalTrades },
    { label: 'Win Rate', value: `${(combinedStats.winRate * 100).toFixed(1)}%` },
    { label: 'P&L', value: `$${combinedStats.totalPnl.toFixed(2)}`, variant: combinedStats.totalPnl >= 0 ? 'profit' : 'loss' },
  ]

  return (
    <div className="h-full flex flex-col gap-4">
      {/* Stats Row */}
      <MatrixStatsGrid stats={stats} />

      {/* Main 3-column layout */}
      <div className="flex-1 grid grid-cols-3 gap-4 min-h-0">
        {/* Column 1: Strategy Controls */}
        <MatrixCard title="STRATEGIES" variant="terminal" className="flex flex-col min-h-0">
          <div className="flex-1 overflow-auto space-y-4">
            {strategies.map((strategy, index) => (
              <StrategyPanel
                key={strategy.name}
                strategy={strategy}
                id={index === 0 ? 'llm-prediction' : 'dip-arb'}
                onToggle={handleToggleStrategy}
              />
            ))}

            {!isConnected && (
              <div className="text-center py-8 text-matrix-text-secondary">
                <p className="text-sm">Connect wallet to enable strategies</p>
                <p className="text-xs mt-2">Go to Settings → Wallet</p>
              </div>
            )}
          </div>
        </MatrixCard>

        {/* Column 2: Market Analysis */}
        <MatrixCard title="MARKET ANALYSIS" variant="terminal" className="flex flex-col min-h-0">
          <div className="flex-1 overflow-auto">
            <MarketAnalysisPanel isActive={strategies.some(s => s.enabled)} />
          </div>
        </MatrixCard>

        {/* Column 3: Activity Feed */}
        <MatrixCard title="ACTIVITY FEED" variant="terminal" className="flex flex-col min-h-0">
          <div className="flex-1 overflow-auto">
            <ActivityFeed entries={activities} />
          </div>
        </MatrixCard>
      </div>
    </div>
  )
}

/**
 * Strategy Control Panel
 */
const StrategyPanel: React.FC<{
  strategy: StrategyState
  id: string
  onToggle: (id: string) => void
}> = ({ strategy, id, onToggle }) => {
  const getStatusColor = () => {
    switch (strategy.status) {
      case 'running': return 'success'
      case 'error': return 'danger'
      case 'paused': return 'warning'
      default: return 'default'
    }
  }

  return (
    <div className="bg-matrix-bg border border-matrix-border rounded-lg p-4">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <span className="text-matrix-primary font-mono font-bold">{strategy.name}</span>
          <MatrixBadge variant={getStatusColor()} size="sm" pulse={strategy.status === 'running'}>
            {strategy.status.toUpperCase()}
          </MatrixBadge>
        </div>
        <MatrixToggle
          enabled={strategy.enabled}
          onChange={() => onToggle(id)}
          size="sm"
        />
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 gap-2 text-xs font-mono">
        <div className="bg-matrix-card rounded px-2 py-1">
          <span className="text-matrix-text-secondary">Trades:</span>
          <span className="text-matrix-primary ml-1">{strategy.stats.totalTrades}</span>
        </div>
        <div className="bg-matrix-card rounded px-2 py-1">
          <span className="text-matrix-text-secondary">Win:</span>
          <span className="text-matrix-primary ml-1">{(strategy.stats.winRate * 100).toFixed(0)}%</span>
        </div>
        <div className="bg-matrix-card rounded px-2 py-1 col-span-2">
          <span className="text-matrix-text-secondary">P&L:</span>
          <span className={cn('ml-1', strategy.stats.totalPnl >= 0 ? 'text-matrix-primary' : 'text-red-400')}>
            ${strategy.stats.totalPnl.toFixed(2)}
          </span>
        </div>
      </div>
    </div>
  )
}

/**
 * Market Analysis Display
 */
const MarketAnalysisPanel: React.FC<{ isActive: boolean }> = ({ isActive }) => {
  if (!isActive) {
    return (
      <div className="h-full flex items-center justify-center text-matrix-text-secondary">
        <div className="text-center">
          <div className="text-4xl mb-4 opacity-30">◇</div>
          <p className="text-sm">Enable a strategy to begin analysis</p>
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <span className="w-2 h-2 bg-matrix-primary rounded-full animate-pulse" />
        <span className="text-matrix-primary text-sm font-mono">Scanning markets...</span>
      </div>

      {/* Placeholder market cards */}
      {[1, 2, 3].map((i) => (
        <div
          key={i}
          className="bg-matrix-bg border border-matrix-border/50 rounded p-3 animate-pulse"
        >
          <div className="h-4 bg-matrix-border/30 rounded w-3/4 mb-2" />
          <div className="h-3 bg-matrix-border/30 rounded w-1/2" />
        </div>
      ))}

      <p className="text-matrix-text-secondary text-xs text-center py-4">
        Market data will appear here when strategies are running
      </p>
    </div>
  )
}

/**
 * Activity Feed Component
 */
const ActivityFeed: React.FC<{ entries: ActivityItem[] }> = ({ entries }) => {
  const getTypeStyles = (type: ActivityItem['type']) => {
    switch (type) {
      case 'trade': return 'text-matrix-primary border-matrix-primary/30'
      case 'analysis': return 'text-blue-400 border-blue-500/30'
      case 'scan': return 'text-matrix-secondary border-matrix-secondary/30'
      case 'error': return 'text-red-400 border-red-500/30'
      case 'system': return 'text-matrix-text-secondary border-matrix-border'
      default: return 'text-matrix-text-secondary border-matrix-border'
    }
  }

  const getTypeIcon = (type: ActivityItem['type']) => {
    switch (type) {
      case 'trade': return '◆'
      case 'analysis': return '◈'
      case 'scan': return '○'
      case 'error': return '✗'
      case 'system': return '◇'
      default: return '◇'
    }
  }

  if (entries.length === 0) {
    return (
      <div className="h-full flex items-center justify-center text-matrix-text-secondary">
        <div className="text-center">
          <div className="text-4xl mb-4 opacity-30">◇</div>
          <p className="text-sm">No activity yet</p>
          <p className="text-xs mt-1">Activity will appear here as strategies run</p>
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-2">
      {entries.map((entry) => (
        <div
          key={entry.id}
          className={cn(
            'bg-matrix-bg border-l-2 rounded-r px-3 py-2',
            getTypeStyles(entry.type)
          )}
        >
          <div className="flex items-start gap-2">
            <span className="text-xs opacity-50">{getTypeIcon(entry.type)}</span>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-mono truncate">{entry.message}</p>
              <p className="text-xs text-matrix-text-secondary">
                {new Date(entry.timestamp).toLocaleTimeString()}
              </p>
            </div>
          </div>
        </div>
      ))}
    </div>
  )
}

export default TradingTerminal
