/**
 * VPIN (Volume-Synchronized Probability of Informed Trading) Service.
 *
 * Detects informed flow in Polymarket orderbooks by tracking buy/sell volume
 * imbalance over rolling time windows. When VPIN exceeds a threshold, maker-only
 * strategies (DualSide, Gabagool) should pause quoting to avoid adverse selection.
 *
 * Data source: UserChannel trade events (our fills) with explicit side information.
 * Future expansion: CLOB REST /trades polling for market-wide flow.
 *
 * VPIN = |V_buy - V_sell| / (V_buy + V_sell) over rolling window.
 *
 * Reference: Easley, López de Prado & O'Hara, "Flow Toxicity and Liquidity" (2012)
 */

import { useSettingsStore } from '@/stores/settingsStore'

// ─── Types ───────────────────────────────────────────────────

interface VolumeBucket {
  startMs: number
  buyVolume: number
  sellVolume: number
}

interface TokenVPINState {
  buckets: VolumeBucket[]
  lastVpin: number
  wasToxic: boolean        // Previous toxicity state (for transition detection)
  lastTradePrice: number   // For tick-test fallback in Lee-Ready classification
}

interface BBOState {
  bid: number
  ask: number
}

export type ToxicityCallback = (tokenId: string, vpin: number, isToxic: boolean) => void

// ─── Configuration ───────────────────────────────────────────

const BUCKET_DURATION_MS = 30_000   // 30 seconds per bucket
const NUM_BUCKETS = 50              // 50 × 30s = 25-minute rolling window
const DEFAULT_THRESHOLD = 0.7

// ─── Service ─────────────────────────────────────────────────

export class VPINService {
  private state = new Map<string, TokenVPINState>()
  private bboCache = new Map<string, BBOState>()
  private toxicityCallbacks = new Set<ToxicityCallback>()
  private unsubscribeFns: Array<() => void> = []
  private walletAddresses: Set<string> = new Set()

  // ─── Public API ──────────────────────────────────────────

  /** Get current VPIN value for a token. Returns 0 if no data. */
  getVPIN(tokenId: string): number {
    const tokenState = this.state.get(tokenId)
    if (!tokenState) return 0
    return this.computeVPIN(tokenId)
  }

  /** Check if a token has toxic flow (VPIN exceeds threshold). */
  isToxic(tokenId: string, threshold?: number): boolean {
    const th = threshold ?? useSettingsStore.getState().vpinToxicityThreshold ?? DEFAULT_THRESHOLD
    return this.getVPIN(tokenId) >= th
  }

  /** Register callback for toxicity state transitions. Returns unsubscribe function. */
  onToxicityChange(callback: ToxicityCallback): () => void {
    this.toxicityCallbacks.add(callback)
    return () => { this.toxicityCallbacks.delete(callback) }
  }

  // ─── Trade Recording (public for testing) ────────────────

  /**
   * Record a classified trade for VPIN computation.
   * Called internally from UserChannel subscription, but public for unit tests.
   */
  recordTrade(tokenId: string, side: 'buy' | 'sell', volume: number, timestampMs: number = Date.now()): void {
    if (volume <= 0) return

    let tokenState = this.state.get(tokenId)
    if (!tokenState) {
      tokenState = { buckets: [], lastVpin: 0, wasToxic: false, lastTradePrice: 0 }
      this.state.set(tokenId, tokenState)
    }

    // Find or create the current bucket
    const bucketStart = Math.floor(timestampMs / BUCKET_DURATION_MS) * BUCKET_DURATION_MS
    let bucket = tokenState.buckets.find(b => b.startMs === bucketStart)
    if (!bucket) {
      bucket = { startMs: bucketStart, buyVolume: 0, sellVolume: 0 }
      tokenState.buckets.push(bucket)
    }

    if (side === 'buy') {
      bucket.buyVolume += volume
    } else {
      bucket.sellVolume += volume
    }

    // Prune old buckets and recompute
    this.pruneBuckets(tokenState, timestampMs)
    const vpin = this.computeVPINFromState(tokenState)
    tokenState.lastVpin = vpin

    // Check for toxicity state transition
    const threshold = useSettingsStore.getState().vpinToxicityThreshold ?? DEFAULT_THRESHOLD
    const isNowToxic = vpin >= threshold
    if (isNowToxic !== tokenState.wasToxic) {
      tokenState.wasToxic = isNowToxic
      for (const cb of this.toxicityCallbacks) {
        try { cb(tokenId, vpin, isNowToxic) } catch { /* ignore callback errors */ }
      }
    }
  }

  /** Update BBO cache for a token (used for Lee-Ready classification). */
  updateBBO(tokenId: string, bid: number, ask: number): void {
    this.bboCache.set(tokenId, { bid, ask })
  }

  // ─── Trade Direction Classification ──────────────────────

  /**
   * Classify trade direction using Lee-Ready algorithm.
   *
   * For our own fills: use explicit side from the trade event.
   * For external trades: compare trade price to BBO midpoint.
   *   - price >= ask → buy-initiated
   *   - price <= bid → sell-initiated
   *   - between → tick test (compare to last trade price)
   */
  classifyTradeDirection(params: {
    tradePrice: number
    tradeSide: string         // 'BUY' | 'SELL' from CLOBTradeEvent
    bestBid: number
    bestAsk: number
    isOurTrade: boolean
    lastTradePrice?: number
  }): 'buy' | 'sell' {
    const { tradePrice, tradeSide, bestBid, bestAsk, isOurTrade, lastTradePrice } = params

    // Our trades have explicit side
    if (isOurTrade) {
      return tradeSide === 'BUY' ? 'buy' : 'sell'
    }

    // Lee-Ready: compare to BBO
    if (tradePrice >= bestAsk) return 'buy'
    if (tradePrice <= bestBid) return 'sell'

    // Tick test: compare to last trade price
    if (lastTradePrice !== undefined && lastTradePrice > 0) {
      return tradePrice >= lastTradePrice ? 'buy' : 'sell'
    }

    // Midpoint fallback
    const mid = (bestBid + bestAsk) / 2
    return tradePrice >= mid ? 'buy' : 'sell'
  }

  // ─── Subscription Setup ──────────────────────────────────

  /**
   * Subscribe to UserChannel trade events for fill-based VPIN tracking.
   * Uses dynamic import to avoid circular dependencies.
   */
  subscribeToTrades(): void {
    import('@/services/realtime').then(({ userChannelService }) => {
      import('@/stores/walletStore').then(({ useWalletStore }) => {
        // Cache wallet addresses for "is our trade" checks
        const walletState = useWalletStore.getState()
        if (walletState.address) this.walletAddresses.add(walletState.address.toLowerCase())
        if (walletState.proxyAddress) this.walletAddresses.add(walletState.proxyAddress.toLowerCase())

        const unsub = userChannelService.onTrade((msg) => {
          if (msg.status !== 'CONFIRMED') return

          const tokenId = msg.asset_id
          const price = parseFloat(msg.price ?? '0')
          const size = parseFloat(msg.size ?? '0')
          if (!tokenId || size <= 0 || price <= 0) return

          // Determine if this is our trade
          const makerAddr = (msg.maker_address ?? '').toLowerCase()
          const takerAddr = (msg.taker_address ?? '').toLowerCase()
          const isOurTrade = this.walletAddresses.has(makerAddr) || this.walletAddresses.has(takerAddr)

          // Get cached BBO
          const bbo = this.bboCache.get(tokenId) ?? { bid: 0, ask: 0 }

          // Get last trade price for tick test
          const tokenState = this.state.get(tokenId)
          const lastTradePrice = tokenState?.lastTradePrice ?? 0

          const direction = this.classifyTradeDirection({
            tradePrice: price,
            tradeSide: msg.side ?? 'BUY',
            bestBid: bbo.bid,
            bestAsk: bbo.ask,
            isOurTrade,
            lastTradePrice,
          })

          // Update last trade price for tick test
          if (tokenState) tokenState.lastTradePrice = price

          const dollarVolume = price * size
          this.recordTrade(tokenId, direction, dollarVolume)
        })
        if (unsub) this.unsubscribeFns.push(unsub)
      }).catch(() => {})
    }).catch(() => {})
  }

  /**
   * Subscribe to RealtimeService for BBO updates (Lee-Ready classification context).
   */
  subscribeToBBO(): void {
    import('@/services/realtime').then(({ realtimeService }) => {
      const unsub = realtimeService.onPriceUpdate((_tokenId: string, data: { bid: number; ask: number }) => {
        if (_tokenId && data.bid > 0 && data.ask > 0) {
          this.updateBBO(_tokenId, data.bid, data.ask)
        }
      })
      if (unsub) this.unsubscribeFns.push(unsub)
    }).catch(() => {})
  }

  // ─── Internal ────────────────────────────────────────────

  /** Compute VPIN for a token from current bucket state. */
  private computeVPIN(tokenId: string): number {
    const tokenState = this.state.get(tokenId)
    if (!tokenState) return 0
    this.pruneBuckets(tokenState)
    return this.computeVPINFromState(tokenState)
  }

  /** Compute VPIN from bucket state (no side effects). */
  private computeVPINFromState(tokenState: TokenVPINState): number {
    if (tokenState.buckets.length === 0) return 0

    let totalBuy = 0
    let totalSell = 0
    for (const b of tokenState.buckets) {
      totalBuy += b.buyVolume
      totalSell += b.sellVolume
    }

    const totalVolume = totalBuy + totalSell
    if (totalVolume === 0) return 0

    return Math.abs(totalBuy - totalSell) / totalVolume
  }

  /** Remove buckets older than the rolling window. */
  private pruneBuckets(tokenState: TokenVPINState, nowMs: number = Date.now()): void {
    const cutoff = nowMs - (BUCKET_DURATION_MS * NUM_BUCKETS)
    tokenState.buckets = tokenState.buckets.filter(b => b.startMs >= cutoff)
  }

  // ─── Cleanup ─────────────────────────────────────────────

  /** Unsubscribe from all event sources and clear state. */
  destroy(): void {
    for (const unsub of this.unsubscribeFns) {
      try { unsub() } catch { /* ignore */ }
    }
    this.unsubscribeFns = []
    this.state.clear()
    this.bboCache.clear()
    this.toxicityCallbacks.clear()
    this.walletAddresses.clear()
  }
}

export const vpinService = new VPINService()
