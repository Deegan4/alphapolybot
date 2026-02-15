import { useEffect, useRef, useState, useCallback } from 'react'
import { gammaClient } from '@/services/api/GammaClient'
import { realtimeService } from '@/services/realtime/RealtimeService'
import {
  parseReferencePrice,
  ASSET_SLUG_PATTERNS,
  WINDOW_DURATIONS,
  type WindowDuration,
} from '@/services/strategies/BtcUpDownStrategy'
import type { Market, PriceData } from '@/types'

// ==========================================
// TYPES
// ==========================================

export interface PolymarketAssetState {
  upPrice: number
  downPrice: number
  upPriceChange: number        // % change of Up price since first subscription
  marketQuestion: string
  referencePrice: number       // Spot price parsed from market question
  windowEnd: number            // Unix ms when market resolves
  windowDuration: WindowDuration | null
  sparklineHistory: number[]   // Up outcome mid-price buffer
  connected: boolean
  marketFound: boolean
  marketId: string | null
}

type AssetKey = 'BTC' | 'ETH' | 'SOL' | 'XRP'
const ASSETS: AssetKey[] = ['BTC', 'ETH', 'SOL', 'XRP']
const MAX_SPARKLINE = 60
const ROTATION_CHECK_MS = 5_000
const DISCOVERY_CACHE_TTL_MS = 30_000

/** Only discover 15m markets for dashboard price display */
const DURATION_PREFERENCE: WindowDuration[] = ['15m']

const emptyState: PolymarketAssetState = {
  upPrice: 0,
  downPrice: 0,
  upPriceChange: 0,
  marketQuestion: '',
  referencePrice: 0,
  windowEnd: 0,
  windowDuration: null,
  sparklineHistory: [],
  connected: false,
  marketFound: false,
  marketId: null,
}

// ==========================================
// INTERNAL HELPERS
// ==========================================

interface TokenMapping {
  asset: AssetKey
  isUp: boolean
}

interface DiscoveredMarket {
  market: Market
  upTokenId: string
  downTokenId: string
  upIndex: number
  windowEnd: number
  duration: WindowDuration
}

/**
 * Compute the slug for the current (or next) window.
 * Aligns to interval boundaries: floor(now / interval) * interval
 */
function computeSlugs(asset: AssetKey, duration: WindowDuration): string[] {
  const prefix = ASSET_SLUG_PATTERNS[asset]?.[duration]
  if (!prefix) return []

  const intervalSec = duration === '5m' ? 300 : 900
  const nowSec = Math.floor(Date.now() / 1000)
  const currentWindowStart = Math.floor(nowSec / intervalSec) * intervalSec
  const nextWindowStart = currentWindowStart + intervalSec

  return [`${prefix}${currentWindowStart}`, `${prefix}${nextWindowStart}`]
}

/**
 * Parse outcome index for "Up" from a market's outcomes array.
 * Handles both "Up"/"Down" and "Yes"/"No" naming conventions.
 * Returns the index of the "Up"/"Yes" outcome, or 0 if ambiguous.
 */
function findUpIndex(outcomes: string[]): number {
  const upIdx = outcomes.findIndex(
    (o) => o.toLowerCase() === 'up' || o.toLowerCase() === 'yes'
  )
  return upIdx >= 0 ? upIdx : 0
}

// ==========================================
// HOOK
// ==========================================

/**
 * Central hook for live Polymarket prediction market prices.
 *
 * Discovers active BTC/ETH/SOL Up/Down markets via GammaClient slug lookup,
 * subscribes to RealtimeService for real-time bid/ask, and auto-rotates
 * when market windows expire.
 *
 * Does NOT modify or compete with useCryptoPrices — strategies still use
 * that hook for Binance spot prices.
 */
export function usePolymarketPrices(): Record<AssetKey, PolymarketAssetState> {
  const [state, setState] = useState<Record<AssetKey, PolymarketAssetState>>({
    BTC: { ...emptyState },
    ETH: { ...emptyState },
    SOL: { ...emptyState },
    XRP: { ...emptyState },
  })

  // Reverse map: tokenId → { asset, isUp }
  const tokenMap = useRef<Map<string, TokenMapping>>(new Map())
  // Sparkline buffers per asset
  const sparklineBuffers = useRef<Map<AssetKey, number[]>>(new Map())
  // Initial Up price per asset (for % change calculation)
  const initialUpPrices = useRef<Map<AssetKey, number>>(new Map())
  // Discovery cache to avoid hammering GammaClient
  const discoveryCache = useRef<Map<string, { market: DiscoveredMarket; ts: number }>>(new Map())
  // Current window end per asset (for rotation detection)
  const windowEnds = useRef<Map<AssetKey, number>>(new Map())
  // Flag to prevent concurrent discoveries
  const discovering = useRef(false)

  // ── Discover a market for one asset ──────────────────────────────────
  const discoverMarket = useCallback(
    async (asset: AssetKey): Promise<DiscoveredMarket | null> => {
      for (const duration of DURATION_PREFERENCE) {
        const slugs = computeSlugs(asset, duration)

        for (const slug of slugs) {
          // Check cache
          const cached = discoveryCache.current.get(slug)
          if (cached && Date.now() - cached.ts < DISCOVERY_CACHE_TTL_MS) {
            return cached.market
          }

          try {
            const event = await gammaClient.getEventBySlug(slug)
            if (!event || !event.markets?.length) continue

            // Find an active binary market in the event
            const market = event.markets.find(
              (m) =>
                m.active &&
                !m.closed &&
                m.outcomes?.length === 2 &&
                m.clobTokenIds?.length === 2 &&
                m.outcomePrices?.length === 2
            )
            if (!market) continue

            const upIndex = findUpIndex(market.outcomes)
            const downIndex = upIndex === 0 ? 1 : 0

            // Parse window end from endDate
            const windowEnd = market.endDate
              ? new Date(market.endDate).getTime()
              : Date.now() + WINDOW_DURATIONS[duration]

            // Skip if already expired
            if (windowEnd < Date.now()) continue

            const discovered: DiscoveredMarket = {
              market,
              upTokenId: market.clobTokenIds[upIndex],
              downTokenId: market.clobTokenIds[downIndex],
              upIndex,
              windowEnd,
              duration,
            }

            discoveryCache.current.set(slug, { market: discovered, ts: Date.now() })
            return discovered
          } catch {
            // Non-critical — try next slug/duration
          }
        }
      }
      return null
    },
    []
  )

  // ── Discover all assets and subscribe ─────────────────────────────────
  const discoverAll = useCallback(async () => {
    if (discovering.current) return
    discovering.current = true

    try {
      // Ensure RealtimeService is connected (idempotent)
      await realtimeService.connect()

      for (const asset of ASSETS) {
        const discovered = await discoverMarket(asset)

        if (!discovered) {
          setState((prev) => ({
            ...prev,
            [asset]: { ...emptyState, connected: realtimeService.isConnected() },
          }))
          windowEnds.current.delete(asset)
          continue
        }

        const { market, upTokenId, downTokenId, upIndex, windowEnd, duration } = discovered
        const downIndex = upIndex === 0 ? 1 : 0

        // Register token → asset mapping
        tokenMap.current.set(upTokenId, { asset, isUp: true })
        tokenMap.current.set(downTokenId, { asset, isUp: false })

        // Subscribe to both tokens (additive, idempotent)
        realtimeService.subscribeMarket([upTokenId, downTokenId])

        // Store window end for rotation check
        windowEnds.current.set(asset, windowEnd)

        // Seed initial state from Gamma mid-prices
        const upPrice = market.outcomePrices[upIndex] || 0
        const downPrice = market.outcomePrices[downIndex] || 0
        const refPrice = parseReferencePrice(market.question) || 0

        // Set initial price for % change (only first time or on rotation)
        if (!initialUpPrices.current.has(asset)) {
          initialUpPrices.current.set(asset, upPrice)
        }

        // Seed sparkline
        const buf = sparklineBuffers.current.get(asset) || []
        if (buf.length === 0 && upPrice > 0) {
          buf.push(upPrice)
          sparklineBuffers.current.set(asset, buf)
        }

        const initialUp = initialUpPrices.current.get(asset) || upPrice
        const pctChange = initialUp > 0 ? ((upPrice - initialUp) / initialUp) * 100 : 0

        setState((prev) => ({
          ...prev,
          [asset]: {
            upPrice,
            downPrice,
            upPriceChange: pctChange,
            marketQuestion: market.question || '',
            referencePrice: refPrice,
            windowEnd,
            windowDuration: duration,
            sparklineHistory: [...buf],
            connected: realtimeService.isConnected(),
            marketFound: true,
            marketId: market.id || null,
          },
        }))
      }
    } finally {
      discovering.current = false
    }
  }, [discoverMarket])

  // ── Initial discovery on mount ────────────────────────────────────────
  useEffect(() => {
    discoverAll()
  }, [discoverAll])

  // ── Live price subscription ───────────────────────────────────────────
  useEffect(() => {
    const unsub = realtimeService.onPriceUpdate(
      (tokenId: string, priceData: PriceData) => {
        const mapping = tokenMap.current.get(tokenId)
        if (!mapping) return

        const { asset, isUp } = mapping
        const mid = priceData.mid > 0 ? priceData.mid : priceData.last

        if (mid <= 0) return

        if (isUp) {
          // Update sparkline buffer
          const buf = sparklineBuffers.current.get(asset) || []
          buf.push(mid)
          if (buf.length > MAX_SPARKLINE) buf.shift()
          sparklineBuffers.current.set(asset, buf)

          // Compute % change
          if (!initialUpPrices.current.has(asset)) {
            initialUpPrices.current.set(asset, mid)
          }
          const initialUp = initialUpPrices.current.get(asset) || mid
          const pctChange = initialUp > 0 ? ((mid - initialUp) / initialUp) * 100 : 0

          // Thin sparkline for rendering
          const thinned =
            buf.length <= 30
              ? [...buf]
              : buf.filter((_, i) => i % 2 === 0 || i === buf.length - 1)

          setState((prev) => ({
            ...prev,
            [asset]: {
              ...prev[asset],
              upPrice: mid,
              upPriceChange: pctChange,
              sparklineHistory: thinned,
              connected: true,
            },
          }))
        } else {
          // Down outcome — just update the price
          setState((prev) => ({
            ...prev,
            [asset]: {
              ...prev[asset],
              downPrice: mid,
              connected: true,
            },
          }))
        }
      }
    )

    return unsub
  }, [])

  // ── Auto-rotation: check for expired windows ──────────────────────────
  useEffect(() => {
    const id = setInterval(() => {
      const now = Date.now()
      let needsRediscovery = false

      for (const asset of ASSETS) {
        const windowEnd = windowEnds.current.get(asset)
        if (windowEnd && now > windowEnd) {
          // Window expired — clear stale data and reset initial price for new window
          initialUpPrices.current.delete(asset)
          sparklineBuffers.current.set(asset, [])
          needsRediscovery = true
        }
      }

      if (needsRediscovery) {
        discoverAll()
      }
    }, ROTATION_CHECK_MS)

    return () => clearInterval(id)
  }, [discoverAll])

  // ── Connection status tracking ────────────────────────────────────────
  useEffect(() => {
    const unsub = realtimeService.onConnectionChange((status) => {
      const connected = status === 'connected'
      setState((prev) => {
        const next = { ...prev }
        for (const asset of ASSETS) {
          next[asset] = { ...prev[asset], connected }
        }
        return next
      })
    })
    return unsub
  }, [])

  return state
}
