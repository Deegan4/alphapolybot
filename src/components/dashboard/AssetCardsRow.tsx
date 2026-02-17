import React, { useEffect, useState, useCallback } from 'react'
import { AssetCard } from './AssetCard'
import { usePolymarketPrices } from '@/hooks/usePolymarketPrices'
import { useCryptoPrices } from '@/hooks/useCryptoPrices'
import { btcUpDownStrategy } from '@/services/strategies/BtcUpDownStrategy'
import { tradeLogger, positionLifecycleManager } from '@/services/trading'
import type { TradeRecord } from '@/services/trading/TradeLogger'

type AssetKey = 'BTC' | 'ETH' | 'SOL' | 'XRP'

const ASSET_COLORS: Record<AssetKey, { dot: string; border: string }> = {
  BTC: { dot: '#f7931a', border: '#f7931a' },
  ETH: { dot: '#627eea', border: '#627eea' },
  SOL: { dot: '#9945ff', border: '#9945ff' },
  XRP: { dot: '#23292f', border: '#23292f' },
}

interface AssetStats {
  wins: number
  losses: number
  pnl: number
  direction: 'UP' | 'DOWN' | null
  edgeStrength: number
  recentPnls: number[]
}

const emptyStats: AssetStats = {
  wins: 0, losses: 0, pnl: 0, direction: null, edgeStrength: 0, recentPnls: [],
}

export const AssetCardsRow: React.FC = () => {
  const polyPrices = usePolymarketPrices()
  const cryptoPrices = useCryptoPrices()
  const [stats, setStats] = useState<Record<AssetKey, AssetStats>>({
    BTC: { ...emptyStats },
    ETH: { ...emptyStats },
    SOL: { ...emptyStats },
    XRP: { ...emptyStats },
  })

  // Compute per-asset stats from trade records + strategy signals
  const refresh = useCallback(() => {
    const records = tradeLogger.getRecords(500)
    const result: Record<AssetKey, AssetStats> = {
      BTC: { ...emptyStats },
      ETH: { ...emptyStats },
      SOL: { ...emptyStats },
      XRP: { ...emptyStats },
    }

    // Group closed BTC-strategy trades by asset
    const closed = records.filter((r) => r.exitTimestamp != null && r.pnlUSD != null)
    for (const r of closed) {
      const asset = detectAsset(r)
      if (!asset) continue
      const pnl = r.pnlUSD ?? 0
      if (pnl > 0) result[asset].wins++
      else result[asset].losses++
      result[asset].pnl += pnl
      result[asset].recentPnls.push(pnl)
    }

    // Add unrealized PnL from open positions
    const openPositions = positionLifecycleManager.getPositions()
    for (const pos of openPositions) {
      const q = (pos.question ?? '').toUpperCase()
      let asset: AssetKey | null = null
      if (q.includes('BTC') || q.includes('BITCOIN')) asset = 'BTC'
      else if (q.includes('ETH') || q.includes('ETHEREUM')) asset = 'ETH'
      else if (q.includes('SOL') || q.includes('SOLANA')) asset = 'SOL'
      else if (q.includes('XRP') || q.includes('RIPPLE')) asset = 'XRP'
      if (asset) {
        result[asset].pnl += pos.pnlUsd
      }
    }

    // Trim recent P&Ls to last 6
    for (const key of ['BTC', 'ETH', 'SOL', 'XRP'] as AssetKey[]) {
      result[key].recentPnls = result[key].recentPnls.slice(-6)
    }

    // Get latest strategy signals
    for (const asset of ['BTC', 'ETH', 'SOL', 'XRP'] as AssetKey[]) {
      const sig = btcUpDownStrategy.getLastSignal(asset)
      if (sig) {
        result[asset].direction = sig.signal.direction === 'up' ? 'UP' : 'DOWN'
        result[asset].edgeStrength = sig.signal.confidence ?? 0
      }
    }

    setStats(result)
  }, [])

  // Initial + periodic refresh
  useEffect(() => {
    refresh()
    const id = setInterval(refresh, 5000)
    return () => clearInterval(id)
  }, [refresh])

  // Also refresh on signal events
  useEffect(() => {
    const off = btcUpDownStrategy.on('signalComputed', refresh)
    return off
  }, [refresh])

  return (
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
      {(['BTC', 'ETH', 'SOL', 'XRP'] as AssetKey[]).map((asset) => (
        <AssetCard
          key={asset}
          symbol={asset}
          dotColor={ASSET_COLORS[asset].dot}
          borderColor={ASSET_COLORS[asset].border}
          upPrice={polyPrices[asset].upPrice}
          downPrice={polyPrices[asset].downPrice}
          upPriceChange={polyPrices[asset].upPriceChange}
          referencePrice={polyPrices[asset].referencePrice}
          windowEnd={polyPrices[asset].windowEnd}
          windowDuration={polyPrices[asset].windowDuration}
          marketFound={polyPrices[asset].marketFound}
          direction={stats[asset].direction}
          spotPrice={cryptoPrices[asset].price}
          spotPriceChange={cryptoPrices[asset].priceChange}
          spotSparkline={cryptoPrices[asset].sparklineHistory}
          sparklineData={polyPrices[asset].sparklineHistory}
          edgeStrength={stats[asset].edgeStrength}
          wins={stats[asset].wins}
          losses={stats[asset].losses}
          pnl={stats[asset].pnl}
          recentTradePnls={stats[asset].recentPnls}
        />
      ))}
    </div>
  )
}

/** Detect which crypto asset a trade record relates to */
function detectAsset(r: TradeRecord): AssetKey | null {
  const q = (r.question ?? '').toUpperCase()
  if (q.includes('BTC') || q.includes('BITCOIN')) return 'BTC'
  if (q.includes('ETH') || q.includes('ETHEREUM')) return 'ETH'
  if (q.includes('SOL') || q.includes('SOLANA')) return 'SOL'
  if (q.includes('XRP') || q.includes('RIPPLE')) return 'XRP'
  return null
}
