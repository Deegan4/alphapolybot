import React, { Suspense, useEffect, useState, useCallback } from 'react'
import { SniperTopBar } from '@/components/dashboard/SniperTopBar'
import { PortfolioPanel } from '@/components/dashboard/PortfolioPanel'
import { AssetCardsRow } from '@/components/dashboard/AssetCardsRow'
import { ActivePositionsCard } from '@/components/dashboard/ActivePositionsCard'
import { RecentTradesGrid } from '@/components/dashboard/RecentTradesGrid'
import { ActivitySidebar } from '@/components/dashboard/ActivitySidebar'
import { DiagnosticsBanner } from '@/components/dashboard/DiagnosticsBanner'
import { ResizablePanelGroup, ResizablePanel, ResizableHandle } from '@/components/ui/Resizable'
import { useBalanceHistory } from '@/hooks/useBalanceHistory'
import { useSettingsStore } from '@/stores/settingsStore'
import { strategyManager, type StrategyState } from '@/services/strategies/StrategyManager'
import { positionLifecycleManager } from '@/services/trading/PositionLifecycleManager'
import { activityLogger } from '@/services/trading/ActivityLogger'

// Lazy-load tab-specific components — only downloaded when their tab is active.
// Keeps initial bundle smaller by deferring chart-heavy and feature-specific panels.
const HistoryView = React.lazy(() => import('@/components/dashboard/HistoryView').then(m => ({ default: m.HistoryView })))
const PerformancePanel = React.lazy(() => import('@/components/dashboard/PerformancePanel').then(m => ({ default: m.PerformancePanel })))
const BacktestView = React.lazy(() => import('@/components/dashboard/BacktestView').then(m => ({ default: m.BacktestView })))
const AnalyticsView = React.lazy(() => import('@/components/dashboard/AnalyticsView').then(m => ({ default: m.AnalyticsView })))

/** Skeleton loading placeholder — matches card shape for visual continuity */
const SkeletonPanel: React.FC = () => (
  <div className="flex flex-col gap-3 p-4 animate-pulse">
    <div className="h-4 w-24 rounded bg-agent-border/40" />
    <div className="h-32 rounded-lg bg-agent-border/20" />
    <div className="h-4 w-40 rounded bg-agent-border/30" />
    <div className="h-20 rounded-lg bg-agent-border/20" />
  </div>
)

/**
 * DashboardView — Resizable 3-panel trading dashboard with Live/History/Spot Crypto tabs.
 * Desktop: drag-to-resize columns. Mobile: vertical stack.
 */
const SIDEBAR_KEY = 'apb:activity-sidebar'

/** Hook to detect desktop breakpoint (lg = 1024px) */
function useIsDesktop() {
  const [isDesktop, setIsDesktop] = useState(() =>
    typeof window !== 'undefined' ? window.innerWidth >= 1024 : true
  )
  useEffect(() => {
    const mq = window.matchMedia('(min-width: 1024px)')
    const handler = (e: MediaQueryListEvent) => setIsDesktop(e.matches)
    mq.addEventListener('change', handler)
    return () => mq.removeEventListener('change', handler)
  }, [])
  return isDesktop
}

const DashboardView: React.FC = () => {
  const dryRun = useSettingsStore((s) => s.dryRun)
  const [activeTab, setActiveTab] = useState<'live' | 'history' | 'backtest' | 'analytics'>('live')
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => {
    try { return localStorage.getItem(SIDEBAR_KEY) === '1' } catch { return false }
  })
  const isDesktop = useIsDesktop()
  useBalanceHistory() // drives balance snapshot pipeline

  const toggleSidebar = useCallback(() => {
    setSidebarCollapsed(prev => {
      const next = !prev
      try { localStorage.setItem(SIDEBAR_KEY, next ? '1' : '0') } catch {}
      return next
    })
  }, [])

  const [strategies, setStrategies] = useState<StrategyState[]>(strategyManager.getStates())

  useEffect(() => {
    return strategyManager.subscribe(setStrategies)
  }, [])

  // Emergency stop state
  const anyRunning = strategies.some((s) => s.status === 'running')
  const trackedCount = positionLifecycleManager.count
  const showEmergency = anyRunning || trackedCount > 0
  const [confirmStop, setConfirmStop] = useState(false)
  const [stopping, setStopping] = useState(false)

  const handleEmergencyStop = useCallback(async () => {
    setConfirmStop(false)
    setStopping(true)
    try {
      await strategyManager.stopAll()
      const result = await positionLifecycleManager.forceCloseAll()
      activityLogger.logWarning(
        `EMERGENCY STOP: strategies halted, ${result.closed} positions closed`
      )
    } catch (error) {
      console.error('Emergency stop failed:', error)
    } finally {
      setStopping(false)
    }
  }, [])

  const handleAbandonAll = useCallback(async () => {
    setConfirmStop(false)
    const count = await positionLifecycleManager.abandonAll()
    activityLogger.logWarning(`ABANDONED ${count} position(s) — tracking cleared`)
  }, [])

  return (
    <div className="h-screen flex flex-col dashboard-bg">
      {/* Top bar with tab switching */}
      <SniperTopBar activeTab={activeTab} onTabChange={setActiveTab} />

      {/* Mode banner */}
      <div className={`px-4 py-0.5 text-center text-[9px] font-mono font-bold tracking-widest ${
        dryRun
          ? 'bg-agent-cyan/10 text-agent-cyan border-b border-agent-cyan/20'
          : 'bg-red-950/30 text-red-400 border-b border-red-500/20'
      }`}>
        {dryRun ? 'PAPER TRADING — NO REAL ORDERS' : 'LIVE TRADING'}
      </div>

      {activeTab === 'live' ? (
        /* ====== LIVE TRADING — Resizable 3-panel layout (desktop) / stack (mobile) ====== */
        <>
        <DiagnosticsBanner />

        {isDesktop ? (
          /* Desktop: resizable panels */
          <div className="flex-1 min-h-0 p-2">
            <ResizablePanelGroup
              orientation="horizontal"
              id="apb-dashboard"
            >
              {/* Left panel — Portfolio + Performance */}
              <ResizablePanel defaultSize="20%" minSize="14%" maxSize="30%">
                <div className="h-full overflow-y-auto flex flex-col gap-3 pr-1 py-1 pl-2">
                  <PortfolioPanel />
                  <Suspense fallback={<SkeletonPanel />}><PerformancePanel /></Suspense>
                </div>
              </ResizablePanel>

              <ResizableHandle withHandle />

              {/* Center panel — Asset cards + positions (full-width) + recent trades (compact strip) */}
              <ResizablePanel defaultSize="55%" minSize="35%">
                <div className="h-full overflow-y-auto flex flex-col gap-3 px-1 py-1">
                  <AssetCardsRow />
                  <div className="flex-1 min-h-0">
                    <ActivePositionsCard />
                  </div>
                  <div className="flex-shrink-0">
                    <RecentTradesGrid />
                  </div>
                </div>
              </ResizablePanel>

              <ResizableHandle withHandle />

              {/* Right panel — Activity sidebar (collapsible) */}
              <ResizablePanel
                defaultSize="25%"
                minSize={sidebarCollapsed ? '3%' : '15%'}
                maxSize="35%"
                collapsible
              >
                <div className="h-full py-1 pr-2 pl-1">
                  <ActivitySidebar collapsed={sidebarCollapsed} onToggle={toggleSidebar} />
                </div>
              </ResizablePanel>
            </ResizablePanelGroup>
          </div>
        ) : (
          /* Mobile / tablet: vertical stack */
          <div className="flex-1 flex flex-col gap-3 p-4 overflow-y-auto">
            <PortfolioPanel />
            <AssetCardsRow />
            <ActivePositionsCard />
            <RecentTradesGrid />
            <ActivitySidebar collapsed={false} />
            <Suspense fallback={<SkeletonPanel />}><PerformancePanel /></Suspense>
          </div>
        )}
        </>
      ) : activeTab === 'history' ? (
        /* ====== HISTORY TAB ====== */
        <Suspense fallback={<SkeletonPanel />}><HistoryView /></Suspense>
      ) : activeTab === 'backtest' ? (
        /* ====== BACKTEST TAB ====== */
        <Suspense fallback={<SkeletonPanel />}><BacktestView /></Suspense>
      ) : (
        /* ====== ANALYTICS TAB ====== */
        <Suspense fallback={<SkeletonPanel />}><AnalyticsView /></Suspense>
      )}

      {/* Floating emergency stop — fixed bottom-left */}
      {showEmergency && (
        <div className="fixed bottom-6 left-6 z-50">
          {confirmStop ? (
            <div className="flex items-center gap-2 bg-red-950/90 border border-red-500/40 rounded-full px-4 py-2 backdrop-blur-sm">
              <span className="text-red-400 text-xs font-mono">Stop all?</span>
              <button
                onClick={handleEmergencyStop}
                disabled={stopping}
                className="text-xs font-mono font-bold text-white bg-red-600 hover:bg-red-500 rounded-full px-3 py-1 transition-colors disabled:opacity-50"
              >
                {stopping ? '...' : 'Sell & Stop'}
              </button>
              {trackedCount > 0 && (
                <button
                  onClick={handleAbandonAll}
                  className="text-xs font-mono font-bold text-yellow-300 bg-yellow-900/60 hover:bg-yellow-800/60 rounded-full px-3 py-1 transition-colors"
                  title="Remove all positions without selling (write off as loss)"
                >
                  Abandon ({trackedCount})
                </button>
              )}
              <button
                onClick={() => setConfirmStop(false)}
                className="text-xs font-mono text-red-400 hover:text-red-300 px-2 py-1 transition-colors"
              >
                Cancel
              </button>
            </div>
          ) : (
            <button
              onClick={() => setConfirmStop(true)}
              className="flex items-center gap-2 bg-red-950/80 border border-red-500/30 hover:border-red-500/60 rounded-full px-4 py-2 backdrop-blur-sm transition-all group"
            >
              <span className="w-2 h-2 bg-red-500 rounded-full animate-pulse" />
              <span className="text-xs font-mono font-semibold text-red-400 group-hover:text-red-300">
                STOP ALL
              </span>
            </button>
          )}
        </div>
      )}
    </div>
  )
}

export default DashboardView
