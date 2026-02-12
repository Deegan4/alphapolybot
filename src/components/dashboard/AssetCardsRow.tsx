import React, { useEffect, useState, useCallback } from 'react'
import { AssetCard } from './AssetCard'
import { useCryptoPrices } from '@/hooks/useCryptoPrices'
import { btcUpDownStrategy } from '@/services/strategies/BtcUpDownStrategy'
import { tradeLogger } from '@/services/trading'
import type { TradeRecord } from '@/services/trading/TradeLogger'

type AssetKey = 'BTC' | 'ETH' | 'SOL'

const ASSET_COLORS: Record<AssetKey, { dot: string; border: string }> = {
  BTC: { dot: '#f7931a', border: '#f7931a' },
  ETH: { dot: '#627eea', border: '#627eea' },
  SOL: { dot: '#9945ff', border: '#9945ff' },
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
  const prices = useCryptoPrices()
  const [stats, setStats] = useState<Record<AssetKey, AssetStats>>({
    BTC: { ...emptyStats },
    ETH: { ...emptyStats },
    SOL: { ...emptyStats },
  })

  // Compute per-asset stats from trade records + strategy signals
  const refresh = useCallback(() => {
    const records = tradeLogger.getRecords(500)
    const result: Record<AssetKey, AssetStats> = {
      BTC: { ...emptyStats },
      ETH: { ...emptyStats },
      SOL: { ...emptyStats },
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

    // Trim recent P&Ls to last 6
    for (const key of ['BTC', 'ETH', 'SOL'] as AssetKey[]) {
      result[key].recentPnls = result[key].recentPnls.slice(-6)
    }

    // Get latest strategy signals
    for (const asset of ['BTC', 'ETH', 'SOL'] as AssetKey[]) {
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
    <div className="grid grid-cols-3 gap-3">
      {(['BTC', 'ETH', 'SOL'] as AssetKey[]).map((asset) => (
        <AssetCard
          key={asset}
          symbol={asset}
          dotColor={ASSET_COLORS[asset].dot}
          borderColor={ASSET_COLORS[asset].border}
          price={prices[asset].price}
          priceChange={prices[asset].priceChange}
          direction={stats[asset].direction}
          sparklineData={prices[asset].sparklineHistory}
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
  return null
}
