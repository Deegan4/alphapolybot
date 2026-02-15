import React, { useEffect, useState, useCallback } from 'react'
import { SniperTopBar } from '@/components/dashboard/SniperTopBar'
import { PortfolioPanel } from '@/components/dashboard/PortfolioPanel'
import { AssetCardsRow } from '@/components/dashboard/AssetCardsRow'
import { ActivePositionsCard } from '@/components/dashboard/ActivePositionsCard'
import { RecentTradesGrid } from '@/components/dashboard/RecentTradesGrid'
import { ActivitySidebar } from '@/components/dashboard/ActivitySidebar'
import { HistoryView } from '@/components/dashboard/HistoryView'
import { SpotCryptoView } from '@/components/dashboard/SpotCryptoView'
import { DiagnosticsBanner } from '@/components/dashboard/DiagnosticsBanner'
import { FollowTraderPanel } from '@/components/dashboard/FollowTraderPanel'
import { PerformancePanel } from '@/components/dashboard/PerformancePanel'
import { useBalanceHistory } from '@/hooks/useBalanceHistory'
import { strategyManager, type StrategyState } from '@/services/strategies'
import { positionLifecycleManager, activityLogger } from '@/services/trading'

/**
 * DashboardView — 3-column trading dashboard with Live/History/Spot Crypto tabs.
 */
const DashboardView: React.FC = () => {
  const [activeTab, setActiveTab] = useState<'live' | 'history' | 'spotcrypto'>('live')
  useBalanceHistory() // drives balance snapshot pipeline

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

  const handleAbandonAll = useCallback(() => {
    setConfirmStop(false)
    const count = positionLifecycleManager.abandonAll()
    activityLogger.logWarning(`ABANDONED ${count} position(s) — tracking cleared`)
  }, [])

  return (
    <div className="h-screen flex flex-col bg-agent-bg">
      {/* Top bar with tab switching */}
      <SniperTopBar activeTab={activeTab} onTabChange={setActiveTab} />

      {activeTab === 'live' ? (
        /* ====== LIVE TRADING — 3 column layout ====== */
        <>
        <DiagnosticsBanner />
        <div className="flex-1 flex gap-4 p-5 min-h-0">
          {/* Left column — Readiness + Portfolio + Performance */}
          <div className="w-[290px] shrink-0 flex flex-col gap-3 min-h-0 overflow-y-auto">
            <FollowTraderPanel />
            <PortfolioPanel />
            <PerformancePanel />
          </div>

          {/* Center column — Asset cards + positions/trades */}
          <div className="flex-1 flex flex-col gap-4 min-h-0">
            <AssetCardsRow />
            <div className="flex-1 grid grid-cols-2 gap-4 min-h-0">
              <ActivePositionsCard />
              <RecentTradesGrid />
            </div>
          </div>

          {/* Right column — Activity */}
          <div className="w-[350px] shrink-0 flex flex-col min-h-0">
            <ActivitySidebar />
          </div>
        </div>
        </>
      ) : activeTab === 'history' ? (
        /* ====== HISTORY TAB ====== */
        <HistoryView />
      ) : (
        /* ====== SPOT CRYPTO TAB ====== */
        <SpotCryptoView />
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
