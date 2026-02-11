import React, { useEffect, useState, useCallback } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { MatrixCard, MatrixToggle, MatrixBadge, MatrixStatsGrid, MatrixButton, AnimatedCounter } from '@/components/ui'
import { strategyManager, type StrategyState } from '@/services/strategies'
import { activityLogger } from '@/services/trading/ActivityLogger'
import { positionLifecycleManager } from '@/services/trading'
import type { ActivityItem } from '@/types'
import { useWalletStore } from '@/stores'
import { cn } from '@/utils/cn'

const containerVariants = {
  hidden: {},
  show: { transition: { staggerChildren: 0.08 } },
}

const itemVariants = {
  hidden: { opacity: 0, y: 16 },
  show: { opacity: 1, y: 0, transition: { type: 'spring', stiffness: 300, damping: 25 } },
}

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

  const [emergencyStop, setEmergencyStop] = useState(false)
  const [confirmEmergency, setConfirmEmergency] = useState(false)

  const handleToggleStrategy = async (id: string) => {
    try {
      await strategyManager.toggleStrategy(id)
    } catch (error) {
      console.error('Failed to toggle strategy:', error)
    }
  }

  const handleEmergencyStop = useCallback(async () => {
    setConfirmEmergency(false)
    setEmergencyStop(true)

    try {
      // Stop all strategies
      await strategyManager.stopAll()

      // Force-close all tracked positions
      const result = await positionLifecycleManager.forceCloseAll()
      console.log(`[Emergency] Closed ${result.closed}, failed ${result.failed}`)

      activityLogger.logWarning(`EMERGENCY STOP: strategies halted, ${result.closed} positions closed`)
    } catch (error) {
      console.error('Emergency stop failed:', error)
    } finally {
      setEmergencyStop(false)
    }
  }, [])

  const combinedStats = strategyManager.getCombinedStats()

  const stats: { label: string; value: string | number; variant?: 'profit' | 'loss' | 'default' }[] = [
    { label: 'Portfolio Value', value: `$${usdcBalance.toLocaleString(undefined, { minimumFractionDigits: 2 })}` },
    { label: 'Total Trades', value: combinedStats.totalTrades },
    { label: 'Win Rate', value: `${(combinedStats.winRate * 100).toFixed(1)}%` },
    { label: 'P&L', value: `$${combinedStats.totalPnl.toFixed(2)}`, variant: combinedStats.totalPnl >= 0 ? 'profit' : 'loss' },
  ]

  const anyRunning = strategies.some(s => s.enabled)
  const trackedCount = positionLifecycleManager.count

  return (
    <div className="h-full flex flex-col gap-4">
      {/* Emergency Stop — visible when strategies are running or positions are tracked */}
      <AnimatePresence>
        {(anyRunning || trackedCount > 0) && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ type: 'spring', stiffness: 300, damping: 25 }}
            className="overflow-hidden"
          >
            <div className="flex items-center justify-between bg-red-900/10 border border-red-500/20 rounded-lg px-4 py-2 shadow-[0_0_15px_rgba(239,68,68,0.1)]">
              <div className="flex items-center gap-2">
                <motion.span
                  className="w-2 h-2 bg-red-500 rounded-full"
                  animate={{ opacity: [1, 0.3, 1] }}
                  transition={{ duration: 1.5, repeat: Infinity }}
                />
                <span className="text-matrix-text-secondary text-xs font-mono">
                  {anyRunning ? 'Strategies active' : ''}{anyRunning && trackedCount > 0 ? ' · ' : ''}{trackedCount > 0 ? `${trackedCount} tracked positions` : ''}
                </span>
              </div>
              {confirmEmergency ? (
                <div className="flex items-center gap-2">
                  <span className="text-red-400 text-xs font-mono">Stop all strategies & close positions?</span>
                  <MatrixButton variant="danger" size="sm" onClick={handleEmergencyStop} loading={emergencyStop}>
                    Confirm
                  </MatrixButton>
                  <MatrixButton variant="ghost" size="sm" onClick={() => setConfirmEmergency(false)}>
                    Cancel
                  </MatrixButton>
                </div>
              ) : (
                <MatrixButton
                  variant="danger"
                  size="sm"
                  onClick={() => setConfirmEmergency(true)}
                  disabled={emergencyStop}
                >
                  STOP ALL
                </MatrixButton>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Stats Row */}
      <MatrixStatsGrid stats={stats} />

      {/* Main 3-column layout */}
      <div className="flex-1 grid grid-cols-3 gap-4 min-h-0">
        {/* Column 1: Strategy Controls — gradient variant */}
        <MatrixCard title="STRATEGIES" variant="gradient" className="flex flex-col min-h-0">
          <motion.div
            className="flex-1 overflow-auto space-y-4"
            variants={containerVariants}
            initial="hidden"
            animate="show"
          >
            {strategies.map((strategy) => (
              <motion.div key={strategy.id} variants={itemVariants}>
                <StrategyPanel
                  strategy={strategy}
                  id={strategy.id}
                  onToggle={handleToggleStrategy}
                />
              </motion.div>
            ))}

            {!isConnected && (
              <motion.div variants={itemVariants} className="text-center py-8 text-matrix-text-secondary">
                <p className="text-sm font-sans">Connect wallet to enable strategies</p>
                <p className="text-xs font-sans mt-2">Go to Settings → Wallet</p>
              </motion.div>
            )}
          </motion.div>
        </MatrixCard>

        {/* Column 2: Market Analysis — glass variant */}
        <MatrixCard title="MARKET ANALYSIS" variant="glass" className="flex flex-col min-h-0">
          <div className="flex-1 overflow-auto">
            <MarketAnalysisPanel
              isActive={strategies.some(s => s.enabled)}
              entries={activities.filter(a => a.type === 'scan' || a.type === 'analysis')}
            />
          </div>
        </MatrixCard>

        {/* Column 3: Activity Feed — terminal variant (subdued) */}
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

  const isRunning = strategy.status === 'running'

  return (
    <motion.div
      className={cn(
        'relative bg-matrix-bg/80 backdrop-blur-sm border rounded-lg p-4 overflow-hidden',
        isRunning ? 'border-matrix-primary/30' : 'border-matrix-border'
      )}
      whileHover={{ scale: 1.01, y: -1 }}
      transition={{ type: 'spring', stiffness: 400, damping: 25 }}
    >
      {/* Running accent glow bar */}
      {isRunning && (
        <motion.div
          className="absolute left-0 top-0 bottom-0 w-0.5 bg-matrix-primary"
          animate={{ boxShadow: ['0 0 4px #00ff00', '0 0 12px #00ff00', '0 0 4px #00ff00'] }}
          transition={{ duration: 2, repeat: Infinity }}
        />
      )}

      <div
        className="flex items-center justify-between mb-3 cursor-pointer"
        onClick={() => onToggle(id)}
      >
        <div className="flex items-center gap-2">
          <span className="text-matrix-primary font-mono font-bold">{strategy.name}</span>
          <MatrixBadge variant={getStatusColor()} size="sm" pulse={isRunning}>
            {strategy.status.toUpperCase()}
          </MatrixBadge>
        </div>
        <div onClick={e => e.stopPropagation()}>
          <MatrixToggle
            enabled={strategy.enabled}
            onChange={() => onToggle(id)}
            size="sm"
          />
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 gap-2 text-xs font-mono">
        <div className="bg-matrix-card/60 rounded px-2 py-1">
          <span className="text-matrix-text-secondary font-sans">Trades:</span>
          <span className="text-matrix-primary ml-1">{strategy.stats.totalTrades}</span>
        </div>
        <div className="bg-matrix-card/60 rounded px-2 py-1">
          <span className="text-matrix-text-secondary font-sans">Win:</span>
          <span className="text-matrix-primary ml-1">{(strategy.stats.winRate * 100).toFixed(0)}%</span>
        </div>
        <div className="bg-matrix-card/60 rounded px-2 py-1 col-span-2">
          <span className="text-matrix-text-secondary font-sans">P&L:</span>
          <span className={cn('ml-1', strategy.stats.totalPnl >= 0 ? 'text-matrix-primary' : 'text-red-400')}>
            <AnimatedCounter value={strategy.stats.totalPnl} prefix="$" precision={2} colorBySign />
          </span>
        </div>
      </div>
    </motion.div>
  )
}

/**
 * Market Analysis Display — shows scan & analysis activity from strategies
 */
const MarketAnalysisPanel: React.FC<{ isActive: boolean; entries: ActivityItem[] }> = ({ isActive, entries }) => {
  if (!isActive) {
    return (
      <div className="h-full flex items-center justify-center text-matrix-text-secondary">
        <div className="text-center">
          <div className="text-4xl mb-4 opacity-30">◇</div>
          <p className="text-sm font-sans">Enable a strategy to begin analysis</p>
        </div>
      </div>
    )
  }

  if (entries.length === 0) {
    return (
      <div className="space-y-3">
        <div className="flex items-center gap-2">
          <motion.span
            className="w-2 h-2 bg-matrix-primary rounded-full"
            animate={{ opacity: [1, 0.3, 1] }}
            transition={{ duration: 1.5, repeat: Infinity }}
          />
          <span className="text-matrix-primary text-sm font-mono">Waiting for scan cycle...</span>
        </div>
        <p className="text-matrix-text-secondary text-xs text-center py-4 font-sans">
          First scan runs within 60 seconds of enabling a strategy
        </p>
      </div>
    )
  }

  return (
    <motion.div
      className="space-y-2"
      variants={containerVariants}
      initial="hidden"
      animate="show"
    >
      <div className="flex items-center gap-2 mb-1">
        <motion.span
          className="w-2 h-2 bg-matrix-primary rounded-full"
          animate={{ opacity: [1, 0.3, 1] }}
          transition={{ duration: 1.5, repeat: Infinity }}
        />
        <span className="text-matrix-primary text-xs font-mono">{entries.length} events</span>
      </div>

      {entries.map((entry) => (
        <motion.div
          key={entry.id}
          variants={itemVariants}
          className={cn(
            'bg-matrix-bg/60 border rounded p-3',
            entry.type === 'analysis' ? 'border-matrix-cyan/30' : 'border-matrix-secondary/30'
          )}
        >
          <div className="flex items-start justify-between gap-2">
            <p className={cn(
              'text-sm font-mono leading-tight',
              entry.type === 'analysis' ? 'text-matrix-cyan' : 'text-matrix-secondary'
            )}>
              {entry.message}
            </p>
            <span className="text-[10px] text-matrix-text-secondary whitespace-nowrap font-sans">
              {new Date(entry.timestamp).toLocaleTimeString()}
            </span>
          </div>

          {/* Show analysis data: confidence, reasoning */}
          {entry.data && entry.type === 'analysis' && (
            <div className="mt-2 space-y-1">
              {entry.data.confidence != null && (
                <div className="flex items-center gap-2">
                  <div className="flex-1 h-1.5 bg-matrix-border rounded-full overflow-hidden">
                    <motion.div
                      className={cn(
                        'h-full rounded-full',
                        (entry.data.confidence as number) >= 0.7 ? 'bg-matrix-primary' :
                        (entry.data.confidence as number) >= 0.5 ? 'bg-matrix-secondary' : 'bg-red-400'
                      )}
                      initial={{ width: 0 }}
                      animate={{ width: `${(entry.data.confidence as number) * 100}%` }}
                      transition={{ duration: 0.6, ease: 'easeOut' }}
                    />
                  </div>
                  <span className="text-xs font-mono text-matrix-text-secondary">
                    {((entry.data.confidence as number) * 100).toFixed(0)}%
                  </span>
                </div>
              )}
              {entry.data.reasoning && (
                <p className="text-xs text-matrix-text-secondary line-clamp-2 font-sans">
                  {String(entry.data.reasoning)}
                </p>
              )}
            </div>
          )}

          {/* Show scan data: market counts + rejection breakdown */}
          {entry.data && entry.type === 'scan' && entry.data.eligible != null && (
            <div className="mt-1 space-y-0.5">
              <div className="flex items-center gap-3 text-xs font-mono text-matrix-text-secondary">
                <span>Scanned: {String(entry.data.total ?? 0)}</span>
                <span className="text-matrix-primary">Eligible: {String(entry.data.eligible)}</span>
              </div>
              {entry.data.rejections && (
                <div className="text-[10px] font-mono text-matrix-text-secondary/70">
                  {Object.entries(entry.data.rejections as Record<string, number>)
                    .filter(([, v]) => v > 0)
                    .map(([k, v]) => `${k}: ${v}`)
                    .join(' · ')}
                </div>
              )}
            </div>
          )}
        </motion.div>
      ))}
    </motion.div>
  )
}

/**
 * Activity Feed Component
 */
const ActivityFeed: React.FC<{ entries: ActivityItem[] }> = ({ entries }) => {
  const getTypeStyles = (type: ActivityItem['type']) => {
    switch (type) {
      case 'trade': return 'text-matrix-primary border-matrix-primary/30'
      case 'analysis': return 'text-matrix-cyan border-matrix-cyan/30'
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
          <p className="text-sm font-sans">No activity yet</p>
          <p className="text-xs mt-1 font-sans">Activity will appear here as strategies run</p>
        </div>
      </div>
    )
  }

  return (
    <motion.div
      className="space-y-2"
      variants={containerVariants}
      initial="hidden"
      animate="show"
    >
      {entries.map((entry) => (
        <motion.div
          key={entry.id}
          variants={itemVariants}
          className={cn(
            'bg-matrix-bg/60 border-l-2 rounded-r px-3 py-2',
            getTypeStyles(entry.type)
          )}
        >
          <div className="flex items-start gap-2">
            <span className="text-xs opacity-50">{getTypeIcon(entry.type)}</span>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-mono truncate">{entry.message}</p>
              <p className="text-xs text-matrix-text-secondary font-sans">
                {new Date(entry.timestamp).toLocaleTimeString()}
              </p>
            </div>
          </div>
        </motion.div>
      ))}
    </motion.div>
  )
}

export default TradingTerminal
