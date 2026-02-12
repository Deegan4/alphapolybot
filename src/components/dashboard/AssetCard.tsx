import React from 'react'
import { MatrixGauge } from '@/components/charts/MatrixGauge'
import { MatrixSparkline } from '@/components/charts/MatrixSparkline'

export interface AssetCardProps {
  symbol: 'BTC' | 'ETH' | 'SOL'
  dotColor: string
  borderColor: string
  price: number
  priceChange: number
  direction: 'UP' | 'DOWN' | null
  sparklineData: number[]
  edgeStrength: number // -1 to 1
  wins: number
  losses: number
  pnl: number
  recentTradePnls: number[]
}

const formatPrice = (price: number): string => {
  if (price >= 1000) return `$${price.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
  if (price >= 1) return `$${price.toFixed(2)}`
  return `$${price.toFixed(4)}`
}

export const AssetCard: React.FC<AssetCardProps> = ({
  symbol,
  dotColor,
  borderColor,
  price,
  priceChange,
  direction,
  sparklineData,
  edgeStrength,
  wins,
  losses,
  pnl,
  recentTradePnls,
}) => {
  return (
    <div
      className="bg-agent-card border border-agent-border rounded-sm flex flex-col"
      style={{ borderTopColor: borderColor, borderTopWidth: 2 }}
    >
      {/* Header */}
      <div className="flex items-center justify-between px-3 pt-3 pb-1">
        <div className="flex items-center gap-2">
          <span
            className="w-2.5 h-2.5 rounded-full"
            style={{ backgroundColor: dotColor }}
          />
          <span className="text-sm font-mono font-bold text-agent-text">{symbol}</span>
        </div>
        {direction && (
          <span
            className={`text-[10px] font-mono font-bold px-2 py-0.5 rounded-full ${
              direction === 'UP'
                ? 'bg-agent-green/15 text-agent-green'
                : 'bg-agent-red/15 text-agent-red'
            }`}
          >
            {direction}
          </span>
        )}
      </div>

      {/* Price */}
      <div className="px-3 pb-1">
        <div className="text-lg font-mono font-bold text-agent-text leading-tight">
          {price > 0 ? formatPrice(price) : '--'}
        </div>
        <div
          className={`text-[10px] font-mono ${
            priceChange >= 0 ? 'text-agent-green' : 'text-agent-red'
          }`}
        >
          {priceChange >= 0 ? '+' : ''}
          {priceChange.toFixed(2)}%
        </div>
      </div>

      {/* Gauge + Sparkline row */}
      <div className="flex items-center gap-2 px-3 py-1">
        <MatrixGauge
          value={edgeStrength * 100}
          min={-10}
          max={10}
          size="sm"
          colorByValue
          label="EDGE"
          valueLabel={`${edgeStrength >= 0 ? '+' : ''}${(edgeStrength * 100).toFixed(1)}%`}
          className="shrink-0"
        />
        <div className="flex-1" style={{ minWidth: 40 }}>
          {sparklineData.length > 1 ? (
            <MatrixSparkline
              data={sparklineData}
              height={40}
              color={dotColor}
              colorByTrend={false}
              strokeWidth={1.5}
            />
          ) : (
            <div className="h-[40px] flex items-center justify-center text-agent-text-label text-[9px] font-mono">
              ...
            </div>
          )}
        </div>
      </div>

      {/* W/L + P&L */}
      <div className="flex items-center justify-between px-3 py-1.5 border-t border-agent-border">
        <span className="text-[10px] font-mono text-agent-text-muted">
          W: <span className="text-agent-green">{wins}</span> / L:{' '}
          <span className="text-agent-red">{losses}</span>
        </span>
        <span
          className={`text-xs font-mono font-semibold ${
            pnl >= 0 ? 'text-agent-green' : 'text-agent-red'
          }`}
        >
          {pnl >= 0 ? '+' : ''}${pnl.toFixed(2)}
        </span>
      </div>

      {/* Recent trade pills */}
      {recentTradePnls.length > 0 && (
        <div className="flex flex-wrap gap-1 px-3 pb-2">
          {recentTradePnls.slice(-6).map((p, i) => (
            <span
              key={i}
              className={`text-[9px] font-mono px-1.5 py-0.5 rounded-full ${
                p >= 0
                  ? 'bg-agent-green/10 text-agent-green'
                  : 'bg-agent-red/10 text-agent-red'
              }`}
            >
              {p >= 0 ? '+' : ''}${p.toFixed(2)}
            </span>
          ))}
        </div>
      )}
    </div>
  )
}
