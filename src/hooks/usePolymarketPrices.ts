import { useEffect, useRef, useState, useCallback, useMemo } from 'react'
import { polymarketClient } from '@/services/api'
import { realtimeService } from '@/services/realtime/RealtimeService'
import {
  parseReferencePrice,
  ASSET_SLUG_PATTERNS,
  WINDOW_DURATIONS,
  type WindowDuration,
} from '@/services/strategies/BtcUpDownStrategy'
import { useSettingsStore } from '@/stores/settingsStore'
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

interface TokenIdMapping {
  asset: AssetKey
  isUp: boolean
}

interface DiscoveredMarket {
  market: Market
  upTokenId: string   // CLOB token ID for Up outcome
  downTokenId: string // CLOB token ID for Down outcome
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
 * Discovers active BTC/ETH/SOL Up/Down markets via Gamma API slug lookup,
 * subscribes to RealtimeService for real-time bid/ask, and auto-rotates
 * when market windows expire.
 *
 * Does NOT modify or compete with useCryptoPrices — strategies still use
 * that hook for Binance spot prices.
 */
export function usePolymarketPrices(): Record<AssetKey, PolymarketAssetState> {
  // Read per-asset enable toggles from settings
  const enableBtc = useSettingsStore((s) => s.btcEnableBtc)
  const enableEth = useSettingsStore((s) => s.btcEnableEth)
  const enableSol = useSettingsStore((s) => s.btcEnableSol)
  const enableXrp = useSettingsStore((s) => s.btcEnableXrp)
  const enabledAssets = useMemo<AssetKey[]>(() => {
    const a: AssetKey[] = []
    if (enableBtc) a.push('BTC')
    if (enableEth) a.push('ETH')
    if (enableSol) a.push('SOL')
    if (enableXrp) a.push('XRP')
    return a
  }, [enableBtc, enableEth, enableSol, enableXrp])

  // Read enabled durations from settings — shortest first so sparklines
  // track the most active/relevant market window
  const enable5m = useSettingsStore((s) => s.btcEnable5m)
  const enable15m = useSettingsStore((s) => s.btcEnable15m)
  const durationPreference = useMemo<WindowDuration[]>(() => {
    const prefs: WindowDuration[] = []
    if (enable5m) prefs.push('5m')
    if (enable15m) prefs.push('15m')
    // Fallback: if nothing enabled, still show 15m so cards aren't empty
    if (prefs.length === 0) prefs.push('15m')
    return prefs
  }, [enable5m, enable15m])

  const [state, setState] = useState<Record<AssetKey, PolymarketAssetState>>({
    BTC: { ...emptyState },
    ETH: { ...emptyState },
    SOL: { ...emptyState },
    XRP: { ...emptyState },
  })

  // Reverse map: slug → { asset, isUp }
  const tokenIdMap = useRef<Map<string, TokenIdMapping>>(new Map())
  // Sparkline buffers per asset
  const sparklineBuffers = useRef<Map<AssetKey, number[]>>(new Map())
  // Initial Up price per asset (for % change calculation)
  const initialUpPrices = useRef<Map<AssetKey, number>>(new Map())
  // Discovery cache to avoid hammering API
  const discoveryCache = useRef<Map<string, { market: DiscoveredMarket; ts: number }>>(new Map())
  // Current window end per asset (for rotation detection)
  const windowEnds = useRef<Map<AssetKey, number>>(new Map())
  // Flag to prevent concurrent discoveries
  const discovering = useRef(false)

  // ── Discover a market for one asset ──────────────────────────────────
  const discoverMarket = useCallback(
    async (asset: AssetKey): Promise<DiscoveredMarket | null> => {
      for (const duration of durationPreference) {
        const eventSlugs = computeSlugs(asset, duration)

        for (const eventSlug of eventSlugs) {
          // Check cache
          const cached = discoveryCache.current.get(eventSlug)
          if (cached && Date.now() - cached.ts < DISCOVERY_CACHE_TTL_MS) {
            return cached.market
          }

          try {
            const event = await polymarketClient.getEventBySlug(eventSlug)
            if (!event || !event.markets?.length) continue

            // Gamma API: each market in the event has outcomes.
            // Need at least 2 markets (Up + Down) for binary events.
            const activeMarkets = event.markets.filter(m => m.active && !m.closed)
            if (activeMarkets.length < 2) continue

            // Build outcome names from individual markets
            const outcomeNames = activeMarkets.map(m => m.outcome || m.title)
            const upIndex = findUpIndex(outcomeNames)
            const downIndex = upIndex === 0 ? 1 : 0

            // Each outcome market has its own CLOB token ID
            const upTokenId = activeMarkets[upIndex].clobTokenIds?.[0] ?? activeMarkets[upIndex].slug
            const downTokenId = activeMarkets[downIndex].clobTokenIds?.[0] ?? activeMarkets[downIndex].slug

            // Parse window end from endDate
            const windowEnd = event.endTime
              ? new Date(event.endTime).getTime()
              : Date.now() + WINDOW_DURATIONS[duration]

            // Skip if already expired
            if (windowEnd < Date.now()) continue

            // Build unified Market for display
            const market: Market = {
              id: String(event.id),
              slug: event.slug,
              question: event.title,
              description: event.description,
              outcomes: outcomeNames,
              active: event.active,
              closed: event.closed,
              endDate: event.endTime || '',
              createdAt: event.startTime || '',
              volume: event.volume || 0,
              liquidity: event.liquidity || 0,
              outcomePrices: activeMarkets.map(() => 0), // prices come from WS
              eventSlug: event.slug,
            }

            const discovered: DiscoveredMarket = {
              market,
              upTokenId,
              downTokenId,
              upIndex,
              windowEnd,
              duration,
            }

            discoveryCache.current.set(eventSlug, { market: discovered, ts: Date.now() })
            return discovered
          } catch {
            // Non-critical — try next slug/duration
          }
        }
      }
      return null
    },
    [durationPreference]
  )

  // ── Discover all assets and subscribe ─────────────────────────────────
  const discoverAll = useCallback(async () => {
    if (discovering.current) return
    discovering.current = true

    try {
      // Ensure RealtimeService is connected (idempotent)
      await realtimeService.connect()

      // Reset disabled assets to empty state
      for (const asset of ASSETS) {
        if (!enabledAssets.includes(asset)) {
          setState((prev) => ({
            ...prev,
            [asset]: { ...emptyState },
          }))
          windowEnds.current.delete(asset)
        }
      }

      for (const asset of enabledAssets) {
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
        const _downIndex = upIndex === 0 ? 1 : 0

        // Register tokenId → asset mapping
        tokenIdMap.current.set(upTokenId, { asset, isUp: true })
        tokenIdMap.current.set(downTokenId, { asset, isUp: false })

        // Subscribe to both outcome token IDs (additive, idempotent)
        realtimeService.subscribeMarket([upTokenId, downTokenId])

        // Store window end for rotation check
        windowEnds.current.set(asset, windowEnd)

        // Seed initial state — prices start at 0, will come from WS
        const upPrice = 0
        const downPrice = 0
        const refPrice = parseReferencePrice(market.question) || 0

        // Seed sparkline
        const buf = sparklineBuffers.current.get(asset) || []
        sparklineBuffers.current.set(asset, buf)

        setState((prev) => ({
          ...prev,
          [asset]: {
            upPrice,
            downPrice,
            upPriceChange: 0,
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
  }, [discoverMarket, enabledAssets])

  // ── Clear stale data when duration preference changes ────────────────
  useEffect(() => {
    // Reset buffers so sparklines start fresh for the new window duration
    tokenIdMap.current.clear()
    sparklineBuffers.current.clear()
    initialUpPrices.current.clear()
    discoveryCache.current.clear()
    windowEnds.current.clear()
    discoverAll()
  }, [durationPreference, enabledAssets]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Initial discovery on mount ────────────────────────────────────────
  useEffect(() => {
    discoverAll()
  }, [discoverAll])

  // ── Live price subscription (batched at 1 Hz to reduce GC pressure) ──
  // WS ticks arrive 8+/sec. Instead of calling setState per tick (creating
  // new objects + triggering React reconciliation each time), we accumulate
  // updates in a mutable ref and flush once per second.
  const pendingUpdates = useRef<Map<AssetKey, { upPrice?: number; downPrice?: number; pctChange?: number }>>(new Map())
  const flushScheduled = useRef(false)

  useEffect(() => {
    const flush = () => {
      flushScheduled.current = false
      const updates = pendingUpdates.current
      if (updates.size === 0) return

      setState((prev) => {
        const next = { ...prev }
        for (const [asset, upd] of updates) {
          const buf = sparklineBuffers.current.get(asset) || []
          const thinned =
            buf.length <= 30
              ? [...buf]
              : buf.filter((_, i) => i % 2 === 0 || i === buf.length - 1)

          next[asset] = {
            ...prev[asset],
            ...(upd.upPrice != null && { upPrice: upd.upPrice }),
            ...(upd.downPrice != null && { downPrice: upd.downPrice }),
            ...(upd.pctChange != null && { upPriceChange: upd.pctChange }),
            sparklineHistory: thinned,
            connected: true,
          }
        }
        return next
      })

      updates.clear()
    }

    const scheduleFlush = () => {
      if (!flushScheduled.current) {
        flushScheduled.current = true
        setTimeout(flush, 1000)
      }
    }

    const unsub = realtimeService.onPriceUpdate(
      (tokenId: string, priceData: PriceData) => {
        const mapping = tokenIdMap.current.get(tokenId)
        if (!mapping) return

        const { asset, isUp } = mapping
        const mid = priceData.mid > 0 ? priceData.mid : priceData.last
        if (mid <= 0) return

        const pending = pendingUpdates.current.get(asset) || {}

        if (isUp) {
          // Update sparkline buffer (mutate in place — ref, not state)
          const buf = sparklineBuffers.current.get(asset) || []
          buf.push(mid)
          if (buf.length > MAX_SPARKLINE) buf.shift()
          sparklineBuffers.current.set(asset, buf)

          if (!initialUpPrices.current.has(asset)) {
            initialUpPrices.current.set(asset, mid)
          }
          const initialUp = initialUpPrices.current.get(asset) || mid
          pending.upPrice = mid
          pending.pctChange = initialUp > 0 ? ((mid - initialUp) / initialUp) * 100 : 0
        } else {
          pending.downPrice = mid
        }

        pendingUpdates.current.set(asset, pending)
        scheduleFlush()
      }
    )

    return unsub
  }, [])

  // ── Auto-rotation: check for expired windows ──────────────────────────
  useEffect(() => {
    const id = setInterval(() => {
      const now = Date.now()
      let needsRediscovery = false

      for (const asset of enabledAssets) {
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
  }, [discoverAll, enabledAssets])

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
