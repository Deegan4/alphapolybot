import React, { useEffect, useState } from 'react'
import { MatrixSparkline } from '@/components/charts/MatrixSparkline'

export interface AssetCardProps {
  symbol: 'BTC' | 'ETH' | 'SOL' | 'XRP'
  dotColor: string
  borderColor: string
  // Polymarket outcome prices (0-1 scale)
  upPrice: number
  downPrice: number
  upPriceChange: number        // % change of Up outcome since subscription
  referencePrice: number       // Spot price from market question (e.g., 97432)
  windowEnd: number            // Unix ms when market resolves
  windowDuration: '5m' | '15m' | 'hourly' | 'daily' | null
  marketFound: boolean
  // Binance spot price fallback (shown when Polymarket unavailable)
  spotPrice?: number           // Live Binance/RTDS spot price
  spotPriceChange?: number     // % change since session start
  spotSparkline?: number[]     // Sparkline from Binance WS
  // Strategy & trade data (unchanged)
  direction: 'UP' | 'DOWN' | null
  sparklineData: number[]
  edgeStrength: number         // -1 to 1
  wins: number
  losses: number
  pnl: number
  recentTradePnls: number[]
}

/** Format outcome price: 55¢ for values < $1, $1.00 for >= $1 */
const formatOutcomePrice = (price: number): string => {
  if (price <= 0) return '--'
  if (price < 1) return `${Math.round(price * 100)}¢`
  return `$${price.toFixed(2)}`
}

/** Format reference spot price with commas */
const formatRefPrice = (price: number): string => {
  if (price <= 0) return '--'
  if (price >= 1000) return `$${price.toLocaleString(undefined, { maximumFractionDigits: 0 })}`
  if (price >= 1) return `$${price.toFixed(2)}`
  return `$${price.toFixed(4)}`
}

/** Format countdown: "2:34" or "14:59" */
const formatCountdown = (remainingMs: number): string => {
  if (remainingMs <= 0) return '0:00'
  const totalSec = Math.ceil(remainingMs / 1000)
  const m = Math.floor(totalSec / 60)
  const s = totalSec % 60
  return `${m}:${s.toString().padStart(2, '0')}`
}

export const AssetCard: React.FC<AssetCardProps> = ({
  symbol,
  dotColor,
  borderColor,
  upPrice,
  downPrice,
  upPriceChange,
  referencePrice,
  windowEnd,
  windowDuration,
  marketFound,
  direction,
  spotPrice,
  spotPriceChange,
  spotSparkline,
  sparklineData,
  edgeStrength,
  wins,
  losses,
  pnl,
  recentTradePnls: _recentTradePnls,
}) => {
  // 1-second tick for countdown
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    if (!windowEnd || windowEnd <= 0) return
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [windowEnd])

  const remaining = windowEnd > 0 ? windowEnd - now : 0

  return (
    <div
      className="card-base flex flex-col overflow-hidden"
      style={{ borderTopColor: borderColor, borderTopWidth: 3 }}
    >
      {/* Header */}
      <div className="flex items-center justify-between px-3 pt-2.5 pb-1">
        <div className="flex items-center gap-2">
          <span
            className="w-2.5 h-2.5 rounded-full"
            style={{ backgroundColor: dotColor }}
          />
          <span className="text-base font-sans font-bold text-agent-text">{symbol}</span>
        </div>
        <div className="flex items-center gap-1.5">
          {windowDuration && (
            <span className="text-[10px] font-mono font-semibold px-1.5 py-0.5 rounded bg-agent-cyan/10 text-agent-cyan border border-agent-cyan/20">
              {windowDuration}
            </span>
          )}
          {direction && (
            <span
              className={`text-xs font-mono font-bold px-2 py-0.5 rounded-full ${
                direction === 'UP'
                  ? 'bg-agent-green/15 text-agent-green'
                  : 'bg-agent-red/15 text-agent-red'
              }`}
            >
              {direction}
            </span>
          )}
        </div>
      </div>

      {/* Polymarket Outcome Prices */}
      <div className="px-3 pb-0.5">
        {marketFound && (upPrice > 0 || downPrice > 0) ? (
          <>
            {/* Up / Down prices side by side */}
            <div className="flex items-baseline gap-3">
              <div className="flex items-baseline gap-1">
                <span className="text-[10px] font-mono font-semibold text-agent-green/70 uppercase">Up</span>
                <span className="text-xl font-mono font-bold text-agent-green leading-tight">
                  {formatOutcomePrice(upPrice)}
                </span>
              </div>
              <div className="flex items-baseline gap-1">
                <span className="text-[10px] font-mono font-semibold text-agent-red/70 uppercase">Dn</span>
                <span className="text-xl font-mono font-bold text-agent-red leading-tight">
                  {formatOutcomePrice(downPrice)}
                </span>
              </div>
            </div>

            {/* % change + reference price + countdown */}
            <div className="flex items-center gap-2 mt-0.5">
              <span
                className={`text-xs font-mono ${
                  (upPriceChange ?? 0) >= 0 ? 'text-agent-green' : 'text-agent-red'
                }`}
              >
                {(upPriceChange ?? 0) >= 0 ? '+' : ''}
                {(upPriceChange ?? 0).toFixed(1)}%
              </span>
              {(referencePrice > 0 || (spotPrice && spotPrice > 0)) && (
                <>
                  <span className="text-agent-text-label text-[10px]">·</span>
                  <span className="text-[10px] font-mono text-agent-text-muted">
                    ref {formatRefPrice(referencePrice > 0 ? referencePrice : (spotPrice ?? 0))}
                  </span>
                </>
              )}
              {windowEnd > 0 && remaining > 0 && (
                <>
                  <span className="text-agent-text-label text-[10px]">·</span>
                  <span className={`text-[10px] font-mono tabular-nums ${
                    remaining < 60_000 ? 'text-agent-orange' : 'text-agent-text-muted'
                  }`}>
                    {formatCountdown(remaining)}
                  </span>
                </>
              )}
              {windowEnd > 0 && remaining <= 0 && (
                <>
                  <span className="text-agent-text-label text-[10px]">·</span>
                  <span className="text-[10px] font-mono text-agent-orange">resolving…</span>
                </>
              )}
            </div>
          </>
        ) : spotPrice && spotPrice > 0 ? (
          /* Spot price fallback when Polymarket market not found */
          <>
            <div className="flex items-baseline gap-2">
              <span className="text-xl font-mono font-bold text-agent-text leading-tight">
                {formatRefPrice(spotPrice)}
              </span>
              <span className="text-[9px] font-mono font-semibold px-1 py-0.5 rounded bg-agent-cyan/10 text-agent-cyan border border-agent-cyan/20">
                SPOT
              </span>
            </div>
            <div className="flex items-center gap-2 mt-0.5">
              {spotPriceChange != null && (
                <span
                  className={`text-xs font-mono ${
                    spotPriceChange >= 0 ? 'text-agent-green' : 'text-agent-red'
                  }`}
                >
                  {spotPriceChange >= 0 ? '+' : ''}
                  {spotPriceChange.toFixed(2)}%
                </span>
              )}
              <span className="text-[10px] font-mono text-agent-text-label">
                no PM market
              </span>
            </div>
          </>
        ) : (
          <div className="py-2">
            <span className="text-sm font-mono text-agent-text-label">No active market</span>
          </div>
        )}
      </div>

      {/* Sparkline + Edge — compact row */}
      <div className="flex items-center gap-2 px-3 py-1.5">
        <div className="flex-1" style={{ minWidth: 40 }}>
          {(sparklineData.length > 1 || (spotSparkline && spotSparkline.length > 1)) ? (
            <MatrixSparkline
              data={sparklineData.length > 1 ? sparklineData : spotSparkline!}
              height={32}
              color={dotColor}
              colorByTrend={false}
              strokeWidth={1.5}
            />
          ) : (
            <div className="h-[32px] flex items-center justify-center text-agent-text-label text-[10px] font-mono">
              ...
            </div>
          )}
        </div>
        <div className="text-right shrink-0">
          <div className="text-[9px] font-sans text-agent-text-muted uppercase">Edge</div>
          <div className={`text-[11px] font-mono font-bold tabular-nums ${
            edgeStrength > 0 ? 'text-agent-green' : edgeStrength < 0 ? 'text-agent-red' : 'text-agent-text-muted'
          }`}>
            {edgeStrength !== 0 ? `${edgeStrength >= 0 ? '+' : ''}${(edgeStrength * 100).toFixed(1)}%` : '--'}
          </div>
        </div>
      </div>

      {/* W/L + P&L — tight footer */}
      <div className="flex items-center justify-between px-3 py-1.5 border-t border-agent-border/40">
        <span className="text-[10px] font-sans text-agent-text-muted">
          W:<span className="text-agent-green">{wins}</span> L:<span className="text-agent-red">{losses}</span>
        </span>
        <span
          className={`text-xs font-mono font-semibold ${
            pnl >= 0 ? 'text-agent-green' : 'text-agent-red'
          }`}
        >
          {(pnl ?? 0) >= 0 ? '+' : ''}${(pnl ?? 0).toFixed(2)}
        </span>
      </div>
    </div>
  )
}
