import React, { useEffect, useState } from 'react'
import { positionLifecycleManager } from '@/services/trading'
import { usePolymarketPrices, type PolymarketAssetState } from '@/hooks/usePolymarketPrices'
import { useCryptoPrices } from '@/hooks/useCryptoPrices'
import { MatrixSparkline } from '@/components/charts/MatrixSparkline'
import type { PositionStatus } from '@/services/trading/PositionLifecycleManager'

type AssetKey = 'BTC' | 'ETH' | 'SOL' | 'XRP'

const ASSET_COLORS: Record<AssetKey, string> = {
  BTC: '#f7931a',
  ETH: '#627eea',
  SOL: '#9945ff',
  XRP: '#23292f',
}

/** Detect which crypto asset a position relates to from its question */
function detectAsset(question: string): AssetKey | null {
  const q = question.toUpperCase()
  if (q.includes('BTC') || q.includes('BITCOIN')) return 'BTC'
  if (q.includes('ETH') || q.includes('ETHEREUM')) return 'ETH'
  if (q.includes('SOL') || q.includes('SOLANA')) return 'SOL'
  if (q.includes('XRP') || q.includes('RIPPLE')) return 'XRP'
  return null
}

export const ActivePositionsCard: React.FC = () => {
  const [positions, setPositions] = useState<PositionStatus[]>([])
  const [closingIds, setClosingIds] = useState<Set<string>>(new Set())
  const [abandoningIds, setAbandoningIds] = useState<Set<string>>(new Set())
  const [confirmSell, setConfirmSell] = useState<string | null>(null)
  const [confirmAbandon, setConfirmAbandon] = useState<string | null>(null)
  const polyPrices = usePolymarketPrices()
  const cryptoPrices = useCryptoPrices()

  useEffect(() => {
    let lastSweepTrigger = 0
    const tick = () => {
      const current = positionLifecycleManager.getPositions()
      setPositions(current)

      // If any positions are expired (past maxHoldMs), trigger an immediate
      // resolution sweep so they get cleaned up promptly instead of waiting
      // for the 15s periodic sweep.
      const now = Date.now()
      const hasExpired = current.some(p =>
        p.maxHoldMs && p.maxHoldMs > 0 && (now - p.entryTime) > p.maxHoldMs
      )
      if (hasExpired && now - lastSweepTrigger > 10_000) {
        lastSweepTrigger = now
        positionLifecycleManager.triggerSweep()
      }
    }
    tick()
    const id = setInterval(tick, 2000)
    return () => clearInterval(id)
  }, [])

  const handleSell = async (marketSlug: string) => {
    setConfirmSell(null)
    setClosingIds(prev => new Set(prev).add(marketSlug))
    try {
      await positionLifecycleManager.forceClosePosition(marketSlug)
    } finally {
      setClosingIds(prev => { const next = new Set(prev); next.delete(marketSlug); return next })
    }
  }

  const handleAbandon = async (marketSlug: string) => {
    setConfirmAbandon(null)
    setAbandoningIds(prev => new Set(prev).add(marketSlug))
    try {
      await positionLifecycleManager.abandonPosition(marketSlug)
    } finally {
      setAbandoningIds(prev => { const next = new Set(prev); next.delete(marketSlug); return next })
    }
  }

  return (
    <div className="card-base p-4 flex flex-col min-h-0 h-full">
      {/* Header */}
      <div className="flex items-center gap-2 mb-3">
        <span className="text-xs uppercase tracking-wider text-agent-text-muted font-sans font-medium">
          Positions
        </span>
        {positions.length > 0 && (
          <span className="text-xs font-mono text-agent-green bg-agent-green/10 px-2 py-0.5 rounded-full">
            {positions.length}
          </span>
        )}
      </div>

      {/* Position cards */}
      <div className="flex-1 overflow-y-auto min-h-0 space-y-3">
        {positions.length === 0 ? (
          <div className="h-full flex flex-col items-center justify-center text-center px-4 gap-2">
            <span className="text-2xl opacity-30">&#127919;</span>
            <span className="text-sm font-sans text-agent-text-label">No active positions</span>
            <span className="text-xs font-sans text-agent-text-label/60">Waiting for edge signal...</span>
          </div>
        ) : (
          positions.map((pos, idx) => {
            const asset = detectAsset(pos.question || '')
            const mkt = asset ? polyPrices[asset] : null
            const spot = asset ? cryptoPrices[asset] : null
            const color = asset ? ASSET_COLORS[asset] : '#22c55e'

            return (
              <PositionMarketCard
                key={`${pos.tokenId}-${idx}`}
                position={pos}
                market={mkt}
                spotPrice={spot?.price}
                assetColor={color}
                asset={asset}
                isSelling={closingIds.has(pos.marketSlug)}
                isAbandoning={abandoningIds.has(pos.marketSlug)}
                showConfirm={confirmSell === pos.marketSlug}
                showAbandonConfirm={confirmAbandon === pos.marketSlug}
                onSell={() => setConfirmSell(pos.marketSlug)}
                onConfirmSell={() => handleSell(pos.marketSlug)}
                onCancelSell={() => setConfirmSell(null)}
                onAbandon={() => setConfirmAbandon(pos.marketSlug)}
                onConfirmAbandon={() => handleAbandon(pos.marketSlug)}
                onCancelAbandon={() => setConfirmAbandon(null)}
              />
            )
          })
        )}
      </div>

      {/* Recent history is shown in RecentTradesGrid below */}
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════
// Position Market Card — rich Polymarket-style view per position
// ═══════════════════════════════════════════════════════════════

interface PositionMarketCardProps {
  position: PositionStatus
  market: PolymarketAssetState | null
  spotPrice?: number
  assetColor: string
  asset: AssetKey | null
  isSelling: boolean
  isAbandoning: boolean
  showConfirm: boolean
  showAbandonConfirm: boolean
  onSell: () => void
  onConfirmSell: () => void
  onCancelSell: () => void
  onAbandon: () => void
  onConfirmAbandon: () => void
  onCancelAbandon: () => void
}

function PositionMarketCard({
  position: pos,
  market: mkt,
  spotPrice,
  assetColor,
  asset,
  isSelling,
  isAbandoning,
  showConfirm,
  showAbandonConfirm,
  onSell,
  onConfirmSell,
  onCancelSell,
  onAbandon,
  onConfirmAbandon,
  onCancelAbandon,
}: PositionMarketCardProps) {
  // Countdown timer — use position's own expiry (entryTime + maxHoldMs) rather than
  // the hook's windowEnd, which auto-rotates to the NEXT window and causes expired
  // positions to show a future countdown instead of the Abandon button.
  const [now, setNow] = useState(Date.now())
  const positionExpiry = (pos.entryTime && pos.maxHoldMs && pos.maxHoldMs > 0)
    ? pos.entryTime + pos.maxHoldMs
    : 0
  const windowEnd = positionExpiry > 0 ? positionExpiry : (mkt?.windowEnd ?? 0)
  useEffect(() => {
    if (!windowEnd || windowEnd <= 0) return
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [windowEnd])
  const remaining = windowEnd > 0 ? windowEnd - now : 0

  const isProfit = (pos.pnlUsd ?? 0) >= 0
  const value = (pos.size ?? 0) * (pos.currentPrice ?? 0)
  const outcomeLabel = pos.outcome?.charAt(0).toUpperCase() + pos.outcome?.slice(1)
  const isUp = pos.outcome === 'yes' || (pos.question || '').toLowerCase().includes('up')

  return (
    <div
      className="rounded-lg border border-agent-border/40 bg-agent-elevated/20 overflow-hidden"
      style={{ borderTopColor: assetColor, borderTopWidth: 3 }}
    >
      {/* Market title + timer */}
      <div className="px-3 pt-2.5 pb-1">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0 flex-1">
            <h4 className="text-sm font-mono font-semibold text-agent-text truncate">
              {pos.question || `${asset || '?'} Position`}
            </h4>
            <div className="flex items-center gap-2 mt-0.5">
              <span className="text-[10px] font-mono text-agent-cyan bg-agent-cyan/10 px-1.5 py-0.5 rounded border border-agent-cyan/20">
                {pos.strategy?.toUpperCase()}
              </span>
              {mkt?.windowDuration && (
                <span className="text-[10px] font-mono text-agent-text-muted">
                  {mkt.windowDuration}
                </span>
              )}
              {pos.isStale && (
                <span className="text-[10px] font-mono text-agent-orange bg-agent-orange/10 px-1 rounded">
                  {windowEnd > 0 && remaining <= 0 ? 'RESOLVING' : 'STALE'}
                </span>
              )}
            </div>
          </div>

          {/* Countdown badge */}
          {remaining > 0 && (
            <div className={`flex-shrink-0 rounded-md px-2.5 py-1 border ${
              remaining < 30_000
                ? 'bg-agent-red/15 border-agent-red/40'
                : remaining < 120_000
                  ? 'bg-agent-orange/15 border-agent-orange/40'
                  : 'bg-agent-elevated/40 border-agent-border/40'
            }`}>
              <div className={`text-lg font-mono font-bold tabular-nums leading-tight ${
                remaining < 30_000 ? 'text-agent-red animate-pulse' :
                remaining < 120_000 ? 'text-agent-orange' : 'text-agent-text'
              }`}>
                {formatCountdown(remaining)}
              </div>
            </div>
          )}
          {windowEnd > 0 && remaining <= 0 && (
            <div className="flex-shrink-0 rounded-md px-2.5 py-1 bg-agent-orange/15 border border-agent-orange/40">
              <span className="text-sm font-mono font-bold text-agent-orange animate-pulse">RESOLVING</span>
            </div>
          )}
        </div>

        {/* Time progress bar */}
        {windowEnd > 0 && (
          <PositionTimeBar
            entryTime={pos.entryTime}
            maxHoldMs={pos.maxHoldMs ?? 0}
            windowEnd={windowEnd}
            remaining={remaining}
          />
        )}
      </div>

      {/* Price to beat + Current price */}
      {mkt && mkt.referencePrice > 0 && spotPrice && spotPrice > 0 && (
        <div className="px-3 pb-1.5 flex items-baseline gap-4">
          <div>
            <div className="text-[9px] font-sans text-agent-text-muted uppercase">Price to Beat</div>
            <div className="text-sm font-mono font-bold text-agent-text">{formatRefPrice(mkt.referencePrice)}</div>
          </div>
          <div>
            <div className="text-[9px] font-sans text-agent-text-muted uppercase">Current Price</div>
            <div className={`text-sm font-mono font-bold ${
              spotPrice >= mkt.referencePrice ? 'text-agent-green' : 'text-agent-red'
            }`}>
              {formatRefPrice(spotPrice)}
            </div>
          </div>
        </div>
      )}

      {/* Sparkline chart */}
      {mkt && mkt.sparklineHistory.length > 1 && (
        <div className="px-3 py-1">
          <MatrixSparkline
            data={mkt.sparklineHistory}
            height={40}
            color={assetColor}
            colorByTrend={false}
            strokeWidth={1.5}
          />
        </div>
      )}

      {/* Outcome prices — Up / Down buttons like Polymarket */}
      {mkt && (mkt.upPrice > 0 || mkt.downPrice > 0) && (
        <div className="px-3 py-2 flex gap-2">
          <div className={`flex-1 text-center rounded-md py-1.5 text-sm font-mono font-bold ${
            isUp
              ? 'bg-agent-green/15 text-agent-green border border-agent-green/30'
              : 'bg-agent-elevated/40 text-agent-text-muted border border-agent-border/30'
          }`}>
            Up {formatOutcomePrice(mkt.upPrice)}
          </div>
          <div className={`flex-1 text-center rounded-md py-1.5 text-sm font-mono font-bold ${
            !isUp
              ? 'bg-agent-red/15 text-agent-red border border-agent-red/30'
              : 'bg-agent-elevated/40 text-agent-text-muted border border-agent-border/30'
          }`}>
            Down {formatOutcomePrice(mkt.downPrice)}
          </div>
        </div>
      )}

      {/* Position details row */}
      <div className="px-3 py-2 border-t border-agent-border/30">
        <div className="grid grid-cols-4 gap-2 text-center">
          <div>
            <div className="text-[9px] font-sans text-agent-text-muted uppercase">Outcome</div>
            <div className={`text-sm font-mono font-semibold ${
              pos.outcome === 'yes' ? 'text-agent-green' : 'text-agent-red'
            }`}>
              {outcomeLabel}
            </div>
          </div>
          <div>
            <div className="text-[9px] font-sans text-agent-text-muted uppercase">Qty</div>
            <div className="text-sm font-mono text-agent-text">
              {(pos.size ?? 0) >= 1 ? (pos.size ?? 0).toFixed(0) : (pos.size ?? 0).toFixed(1)}
            </div>
          </div>
          <div>
            <div className="text-[9px] font-sans text-agent-text-muted uppercase">Avg</div>
            <div className="text-sm font-mono text-agent-text">{formatOutcomePrice(pos.entryPrice ?? 0)}</div>
          </div>
          <div>
            <div className="text-[9px] font-sans text-agent-text-muted uppercase">Value</div>
            <div className="text-sm font-mono text-agent-text">${value.toFixed(2)}</div>
          </div>
        </div>
      </div>

      {/* Return + Sell button */}
      <div className="px-3 py-2.5 border-t border-agent-border/30 flex items-center justify-between">
        <div>
          <div className="text-[9px] font-sans text-agent-text-muted uppercase">Return</div>
          <div className="flex items-baseline gap-1">
            <span className={`text-base font-mono font-bold ${isProfit ? 'text-agent-green' : 'text-agent-red'}`}>
              {isProfit ? '+' : ''}${(pos.pnlUsd ?? 0).toFixed(2)}
            </span>
            <span className={`text-xs font-mono ${isProfit ? 'text-agent-green/70' : 'text-agent-red/70'}`}>
              ({isProfit ? '+' : ''}{((pos.pnlPercent ?? 0) * 100).toFixed(1)}%)
            </span>
          </div>
        </div>

        {/* Sell / Abandon button */}
        <div>
          {windowEnd > 0 && remaining <= 0 ? (
            // Market window expired — show Abandon (resolution-hold positions settle automatically)
            showAbandonConfirm ? (
              <div className="flex items-center gap-1.5">
                <span className="text-[10px] font-mono text-agent-orange">Remove?</span>
                <button
                  onClick={onConfirmAbandon}
                  className="text-xs font-mono font-bold text-white bg-agent-orange hover:bg-orange-500 px-3 py-1.5 rounded transition-colors"
                >
                  Yes
                </button>
                <button
                  onClick={onCancelAbandon}
                  className="text-xs font-mono text-agent-text-muted hover:text-agent-text px-2 py-1.5"
                >
                  No
                </button>
              </div>
            ) : isAbandoning ? (
              <span className="text-xs font-mono text-agent-orange animate-pulse px-3 py-1.5">Removing...</span>
            ) : (
              <button
                onClick={onAbandon}
                className="text-sm font-mono font-semibold text-agent-orange border border-agent-orange/40 hover:bg-agent-orange hover:text-white px-4 py-1.5 rounded transition-colors"
              >
                Abandon
              </button>
            )
          ) : showConfirm ? (
            <div className="flex items-center gap-1.5">
              <span className="text-[10px] font-mono text-agent-red">Sell?</span>
              <button
                onClick={onConfirmSell}
                className="text-xs font-mono font-bold text-white bg-agent-red hover:bg-red-500 px-3 py-1.5 rounded transition-colors"
              >
                Yes
              </button>
              <button
                onClick={onCancelSell}
                className="text-xs font-mono text-agent-text-muted hover:text-agent-text px-2 py-1.5"
              >
                No
              </button>
            </div>
          ) : isSelling ? (
            <span className="text-xs font-mono text-agent-orange animate-pulse px-3 py-1.5">Selling...</span>
          ) : (
            <button
              onClick={onSell}
              className="text-sm font-mono font-semibold text-agent-red border border-agent-red/40 hover:bg-agent-red hover:text-white px-4 py-1.5 rounded transition-colors"
            >
              Sell
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════
// Position Time Bar — visual progress indicator per position
// ═══════════════════════════════════════════════════════════════

function PositionTimeBar({ entryTime, maxHoldMs, windowEnd, remaining }: {
  entryTime: number
  maxHoldMs: number
  windowEnd: number
  remaining: number
}) {
  // Calculate progress: how much of the total window has elapsed
  const totalDuration = maxHoldMs > 0 ? maxHoldMs : (windowEnd - entryTime)
  if (totalDuration <= 0) return null

  const elapsed = totalDuration - remaining
  const progress = Math.max(0, Math.min(1, elapsed / totalDuration))
  const pct = progress * 100

  // Color: green → yellow → orange → red as time runs out
  const barColor = remaining <= 0
    ? 'bg-agent-orange'
    : remaining < 30_000
      ? 'bg-agent-red'
      : remaining < 120_000
        ? 'bg-agent-orange'
        : remaining < totalDuration * 0.5
          ? 'bg-yellow-500'
          : 'bg-agent-green'

  return (
    <div className="mt-1.5 mb-0.5">
      <div className="h-1 w-full rounded-full bg-agent-border/30 overflow-hidden">
        <div
          className={`h-full rounded-full transition-all duration-1000 ease-linear ${barColor}`}
          style={{ width: `${pct}%` }}
        />
      </div>
      <div className="flex justify-between mt-0.5">
        <span className="text-[8px] font-mono text-agent-text-muted/60">
          {formatCountdownCompact(elapsed)} elapsed
        </span>
        <span className={`text-[8px] font-mono ${
          remaining < 60_000 ? 'text-agent-red/80' : 'text-agent-text-muted/60'
        }`}>
          {remaining > 0 ? `${formatCountdownCompact(remaining)} left` : 'expired'}
        </span>
      </div>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════

function formatOutcomePrice(price: number): string {
  if (price <= 0) return '--'
  if (price < 1) return `${Math.round(price * 100)}¢`
  return `$${price.toFixed(2)}`
}

function formatRefPrice(price: number): string {
  if (price <= 0) return '--'
  if (price >= 1000) return `$${price.toLocaleString(undefined, { maximumFractionDigits: 2 })}`
  if (price >= 1) return `$${price.toFixed(2)}`
  return `$${price.toFixed(4)}`
}

function formatCountdown(remainingMs: number): string {
  if (remainingMs <= 0) return '0:00'
  const totalSec = Math.ceil(remainingMs / 1000)
  const h = Math.floor(totalSec / 3600)
  const m = Math.floor((totalSec % 3600) / 60)
  const s = totalSec % 60
  if (h > 0) return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`
  return `${m}:${s.toString().padStart(2, '0')}`
}

function formatCountdownCompact(ms: number): string {
  if (ms <= 0) return '0s'
  const totalSec = Math.round(ms / 1000)
  if (totalSec < 60) return `${totalSec}s`
  const m = Math.floor(totalSec / 60)
  const s = totalSec % 60
  if (m < 60) return s > 0 ? `${m}m ${s}s` : `${m}m`
  const h = Math.floor(m / 60)
  const rm = m % 60
  return rm > 0 ? `${h}h ${rm}m` : `${h}h`
}

function _HistoryRow({ entry }: { entry: TradeRecord }) {
  const action = entry.exitTimestamp
    ? (entry.exitReason === 'merge' || entry.exitReason === 'redemption' ? 'Redeemed' : 'Sold')
    : (entry.side === 'BUY' ? 'Bought' : 'Sold')
  const qty = entry.filledSize ?? (entry.actualBetSize ?? 0) / (entry.fillPrice || entry.marketPrice || 1)
  const price = entry.fillPrice ?? entry.marketPrice ?? 0
  const total = (entry.filledSize ?? qty) * price
  const outcome = typeof entry.outcome === 'string' ? entry.outcome : String(entry.outcome || '?')
  const outcomeColor = outcome.toLowerCase() === 'up' || outcome.toLowerCase() === 'yes'
    ? 'text-agent-green' : 'text-agent-red'
  const pnl = entry.pnlUSD
  const isExit = !!entry.exitTimestamp
  const ts = entry.exitTimestamp || entry.timestamp

  return (
    <div className="flex items-center justify-between text-xs font-mono">
      <span className="text-agent-text-muted truncate">
        {action}{' '}
        <span className={outcomeColor}>{(qty ?? 0) >= 1 ? (qty ?? 0).toFixed(0) : (qty ?? 0).toFixed(1)} {outcome}</span>
        {' '}at {formatOutcomePrice(price ?? 0)}
        <span className="text-agent-text-muted/60"> (${(total ?? 0).toFixed(2)})</span>
        {isExit && pnl != null && (
          <span className={`ml-1 font-semibold ${pnl >= 0 ? 'text-agent-green' : 'text-agent-red'}`}>
            {pnl >= 0 ? '+' : ''}${pnl.toFixed(2)}
          </span>
        )}
      </span>
      <span className="text-agent-text-muted/50 text-[10px] ml-2 flex-shrink-0">{timeAgo(ts)}</span>
    </div>
  )
}

function timeAgo(ts: number): string {
  const mins = Math.round((Date.now() - ts) / 60_000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  if (mins < 1440) return `${(mins / 60).toFixed(0)}h ago`
  return `${(mins / 1440).toFixed(0)}d ago`
}
