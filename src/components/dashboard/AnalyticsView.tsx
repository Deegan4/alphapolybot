import React from 'react'
import { useTradeAnalytics } from '@/hooks/useTradeAnalytics'
import { MatrixAreaChart } from '@/components/charts/MatrixAreaChart'
import { MatrixLineChart } from '@/components/charts/MatrixLineChart'
import { MatrixBarChart } from '@/components/charts/MatrixBarChart'

/**
 * AnalyticsView — Multi-chart analytics dashboard tab.
 * Shows equity curve, strategy comparison, win rate trend,
 * P&L by hour, and trade frequency by day.
 */
export const AnalyticsView: React.FC = () => {
  const analytics = useTradeAnalytics()

  if (analytics.totalTrades === 0) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-3 p-8">
        <span className="text-4xl opacity-20">&#128202;</span>
        <span className="text-sm font-sans text-agent-text-label">
          No closed trades yet. Analytics will appear after your first completed trade.
        </span>
      </div>
    )
  }

  // Detect which strategy keys are present for the line chart
  const stratKeys = new Set<string>()
  for (const point of analytics.strategyComparison) {
    for (const key of Object.keys(point)) {
      if (key !== 'date') stratKeys.add(key)
    }
  }
  const stratLines = Array.from(stratKeys).map((key, i) => ({
    dataKey: key,
    name: key,
    color: ['#00ff41', '#00e5ff', '#f7931a', '#627eea', '#9945ff', '#ff6b6b', '#ffd700'][i % 7],
  }))

  return (
    <div className="flex-1 flex flex-col gap-4 p-4 sm:p-5 min-h-0 overflow-y-auto">
      {/* Top row — Equity curve + Strategy comparison */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div className="card-base p-4">
          <h3 className="text-xs font-sans font-semibold text-agent-text-muted uppercase tracking-wider mb-3">
            Equity Curve
          </h3>
          <MatrixAreaChart
            data={analytics.equityCurve}
            areas={[{ dataKey: 'equity', name: 'Cumulative P&L', color: '#00ff41', fillOpacity: 0.15 }]}
            xAxisKey="date"
            height={220}
            showGrid
          />
        </div>

        <div className="card-base p-4">
          <h3 className="text-xs font-sans font-semibold text-agent-text-muted uppercase tracking-wider mb-3">
            Strategy Comparison
          </h3>
          {stratLines.length > 0 ? (
            <MatrixLineChart
              data={analytics.strategyComparison}
              lines={stratLines}
              xAxisKey="date"
              height={220}
              showGrid
              showLegend
              />
          ) : (
            <div className="h-[220px] flex items-center justify-center text-agent-text-label text-xs font-mono">
              Waiting for multi-strategy data...
            </div>
          )}
        </div>
      </div>

      {/* Middle row — Win Rate Trend + P&L by Hour */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div className="card-base p-4">
          <h3 className="text-xs font-sans font-semibold text-agent-text-muted uppercase tracking-wider mb-3">
            Win Rate Trend (20-trade window)
          </h3>
          {analytics.winRateTrend.length > 0 ? (
            <MatrixLineChart
              data={analytics.winRateTrend}
              lines={[{ dataKey: 'winRate', name: 'Win %', color: '#00e5ff' }]}
              xAxisKey="trade"
              height={200}
              showGrid

            />
          ) : (
            <div className="h-[200px] flex items-center justify-center text-agent-text-label text-xs font-mono">
              Need 20+ trades for trend
            </div>
          )}
        </div>

        <div className="card-base p-4">
          <h3 className="text-xs font-sans font-semibold text-agent-text-muted uppercase tracking-wider mb-3">
            P&L by Hour of Day
          </h3>
          <MatrixBarChart
            data={analytics.pnlByHour}
            bars={[{ dataKey: 'pnl', name: 'P&L', color: '#00ff41' }]}
            xAxisKey="hour"
            height={200}
            showGrid
            colorByValue
          />
        </div>
      </div>

      {/* Bottom row — Trade Frequency */}
      <div className="card-base p-4">
        <h3 className="text-xs font-sans font-semibold text-agent-text-muted uppercase tracking-wider mb-3">
          Trade Frequency by Day
        </h3>
        <MatrixBarChart
          data={analytics.tradesByDay}
          bars={[{ dataKey: 'count', name: 'Trades', color: '#00e5ff' }]}
          xAxisKey="day"
          height={180}
          showGrid
        />
      </div>
    </div>
  )
}
