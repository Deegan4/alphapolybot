import { useEffect, useRef, useState, useCallback } from 'react'
import { rtdsService, type RTDSAssetPrice } from '@/services/realtime/RTDSService'
import { binanceWSService, type BinancePriceUpdate } from '@/services/realtime/BinanceWSService'
import { priceOracleService } from '@/services/api/PriceOracleService'

export interface CryptoAssetState {
  price: number
  priceChange: number // percent from session start
  sparklineHistory: number[] // last ~30 readings for sparkline
}

type AssetKey = 'BTC' | 'ETH' | 'SOL' | 'XRP'
const ASSETS: AssetKey[] = ['BTC', 'ETH', 'SOL', 'XRP']
const MAX_SPARKLINE = 60

/** If neither WS has delivered in this window, fall back to HTTP polling */
const STALE_THRESHOLD_MS = 15_000
const POLL_INTERVAL_MS = 10_000

const emptyState: CryptoAssetState = { price: 0, priceChange: 0, sparklineHistory: [] }

/**
 * Central hook for live crypto prices.
 *
 * Data sources (priority order):
 *   1. Binance WebSocket (miniTicker ~1s for BTC/ETH/SOL) — primary
 *   2. RTDS WebSocket (Polymarket, mainly BTC) — supplements when available
 *   3. HTTP polling via PriceOracleService (Binance REST → CoinGecko) — fallback
 *
 * Both WS sources feed through the same ingestPrice() so sparkline buffers
 * and session % change are computed identically regardless of source.
 */
export function useCryptoPrices(): Record<AssetKey, CryptoAssetState> {
  const [state, setState] = useState<Record<AssetKey, CryptoAssetState>>({
    BTC: { ...emptyState },
    ETH: { ...emptyState },
    SOL: { ...emptyState },
    XRP: { ...emptyState },
  })

  const sessionStartPrices = useRef<Map<AssetKey, number>>(new Map())
  const sparklineBuffers = useRef<Map<AssetKey, number[]>>(new Map())
  const lastUpdateTimes = useRef<Map<AssetKey, number>>(new Map())

  // Shared price ingestion — all sources funnel through here
  const ingestPrice = useCallback((asset: AssetKey, priceUSD: number) => {
    if (priceUSD <= 0) return

    lastUpdateTimes.current.set(asset, Date.now())

    if (!sessionStartPrices.current.has(asset)) {
      sessionStartPrices.current.set(asset, priceUSD)
    }

    const buf = sparklineBuffers.current.get(asset) || []
    buf.push(priceUSD)
    if (buf.length > MAX_SPARKLINE) buf.shift()
    sparklineBuffers.current.set(asset, buf)

    const start = sessionStartPrices.current.get(asset) || priceUSD
    const change = start > 0 ? ((priceUSD - start) / start) * 100 : 0

    const thinned = buf.length <= 30 ? [...buf] : buf.filter((_, i) => i % 2 === 0 || i === buf.length - 1)

    setState(prev => ({
      ...prev,
      [asset]: { price: priceUSD, priceChange: change, sparklineHistory: thinned },
    }))
  }, [])

  // ── Source 1: Binance WebSocket (primary for all 3 assets) ──────────
  useEffect(() => {
    // Connect if not already connected (App.tsx also calls connect, but this is idempotent)
    binanceWSService.connect()

    const unsub = binanceWSService.onPriceUpdate((p: BinancePriceUpdate) => {
      if (!ASSETS.includes(p.symbol)) return
      ingestPrice(p.symbol, p.priceUSD)
    })
    return unsub
  }, [ingestPrice])

  // ── Source 2: RTDS WebSocket (supplements, mainly BTC) ──────────────
  useEffect(() => {
    // Seed from RTDS cache on mount
    for (const asset of ASSETS) {
      const cached = rtdsService.getCachedPrice(asset)
      if (cached) ingestPrice(asset, cached.priceUSD)
    }

    const unsub = rtdsService.onPriceUpdate((p: RTDSAssetPrice) => {
      const asset = p.symbol as AssetKey
      if (!ASSETS.includes(asset)) return
      ingestPrice(asset, p.priceUSD)
    })
    return unsub
  }, [ingestPrice])

  // ── Source 3: HTTP polling fallback (only when both WS are stale) ───
  useEffect(() => {
    // Fetch prices via HTTP, but delay 3s to let RTDS/BinanceWS connect first.
    // If WS has already delivered for an asset (within 2s), skip the HTTP call.
    // Sequential with 500ms stagger to avoid CoinGecko 429 if Binance is down.
    const fetchAll = async () => {
      for (const asset of ASSETS) {
        const lastWs = lastUpdateTimes.current.get(asset) ?? 0
        if (Date.now() - lastWs < 2000) continue  // WS already delivered — skip
        try {
          const p = await priceOracleService.getPrice(asset)
          // Re-check after await — WS may have delivered while we waited
          const lastWs2 = lastUpdateTimes.current.get(asset) ?? 0
          if (Date.now() - lastWs2 > 2000) {
            ingestPrice(asset, p.priceUSD)
          }
        } catch { /* retry next interval */ }
        await new Promise(r => setTimeout(r, 500))
      }
    }
    const initTimeout = setTimeout(fetchAll, 3000)  // Give WS 3s head start

    const id = setInterval(async () => {
      const now = Date.now()
      for (const asset of ASSETS) {
        const lastUpdate = lastUpdateTimes.current.get(asset) ?? 0
        if (now - lastUpdate < STALE_THRESHOLD_MS) continue // WS is delivering — skip
        try {
          const p = await priceOracleService.getPrice(asset)
          ingestPrice(asset, p.priceUSD)
        } catch { /* non-critical */ }
      }
    }, POLL_INTERVAL_MS)

    return () => { clearTimeout(initTimeout); clearInterval(id) }
  }, [ingestPrice])

  return state
}
