/**
 * L2OrderBookTracker — Real-time L2 orderbook depth tracking with queue position estimation.
 *
 * Consumes 'book' events from the CLOB Market WebSocket (previously ignored by RealtimeService)
 * to maintain live depth snapshots for subscribed tokens. Provides:
 *
 * 1. Full L2 depth (all price levels, not just BBO)
 * 2. Queue position tracking — estimates where our resting order sits at a given price level
 * 3. Depth imbalance — bid/ask size ratio at configurable depth
 * 4. Liquidity heatmap — size concentration across price levels
 *
 * The CLOB WS pushes incremental book updates: { event_type: 'book', ... }
 * We maintain a local copy per token and apply deltas.
 *
 * Singleton pattern, consistent with other trading services.
 */

export interface L2Level {
  price: number
  size: number
}

export interface L2Snapshot {
  tokenId: string
  bids: L2Level[]       // sorted descending by price (best bid first)
  asks: L2Level[]       // sorted ascending by price (best ask first)
  lastUpdate: number    // Date.now()
  sequenceId?: number   // CLOB sequence for ordering
}

export interface QueuePosition {
  /** Estimated shares ahead of our order at the given price level */
  sharesAhead: number
  /** Total size at this price level */
  totalAtLevel: number
  /** Our estimated position as fraction (0 = front, 1 = back) */
  queueFraction: number
  /** Whether our price level still exists in the book */
  levelExists: boolean
}

export interface DepthImbalance {
  /** Bid/ask imbalance in [-1, 1]: positive = more bids (bullish) */
  imbalance: number
  /** Total bid size within depth */
  bidSize: number
  /** Total ask size within depth */
  askSize: number
  /** Number of bid levels */
  bidLevels: number
  /** Number of ask levels */
  askLevels: number
  /** Weighted imbalance (size × proximity to mid) */
  weightedImbalance: number
}

export interface LiquidityWall {
  price: number
  size: number
  side: 'bid' | 'ask'
  /** Multiple of average level size (e.g., 3x = large wall) */
  sizeMultiple: number
}

type DepthCallback = (tokenId: string, snapshot: L2Snapshot) => void

export class L2OrderBookTracker {
  /** Live L2 snapshots per token */
  private books = new Map<string, L2Snapshot>()
  /** Token IDs we're actively tracking */
  private tracking = new Set<string>()
  /** Callbacks for depth updates */
  private callbacks = new Set<DepthCallback>()
  /** Our resting order sizes for queue tracking: tokenId:price → ourSize */
  private restingOrders = new Map<string, number>()
  /** Previous sizes at our resting levels for queue delta tracking */
  private prevLevelSizes = new Map<string, number>()

  // ─── Subscription Management ──────────────────────────────

  /** Start tracking L2 depth for a token */
  track(tokenId: string): void {
    this.tracking.add(tokenId)
  }

  /** Stop tracking a token */
  untrack(tokenId: string): void {
    this.tracking.delete(tokenId)
    this.books.delete(tokenId)
    // Clean up resting order entries for this token
    for (const key of this.restingOrders.keys()) {
      if (key.startsWith(tokenId + ':')) {
        this.restingOrders.delete(key)
        this.prevLevelSizes.delete(key)
      }
    }
  }

  /** Check if a token is being tracked */
  isTracking(tokenId: string): boolean {
    return this.tracking.has(tokenId)
  }

  /** Subscribe to depth updates */
  onDepthUpdate(callback: DepthCallback): () => void {
    this.callbacks.add(callback)
    return () => this.callbacks.delete(callback)
  }

  // ─── Book Updates (called by RealtimeService) ─────────────

  /**
   * Handle a full book snapshot from REST or initial WS message.
   * Replaces the entire local book for a token.
   */
  applySnapshot(tokenId: string, bids: L2Level[], asks: L2Level[]): void {
    if (!this.tracking.has(tokenId)) return

    const snapshot: L2Snapshot = {
      tokenId,
      bids: [...bids].sort((a, b) => b.price - a.price),
      asks: [...asks].sort((a, b) => a.price - b.price),
      lastUpdate: Date.now(),
    }
    this.books.set(tokenId, snapshot)
    this.notifyCallbacks(tokenId, snapshot)
  }

  /**
   * Handle incremental book update from CLOB WS 'book' event.
   * Updates individual price levels (size=0 means remove level).
   */
  applyDelta(tokenId: string, changes: Array<{ price: number; side: 'bid' | 'ask'; size: number }>): void {
    if (!this.tracking.has(tokenId)) return

    let snapshot = this.books.get(tokenId)
    if (!snapshot) {
      // No snapshot yet — create empty and apply
      snapshot = { tokenId, bids: [], asks: [], lastUpdate: Date.now() }
      this.books.set(tokenId, snapshot)
    }

    for (const change of changes) {
      const levels = change.side === 'bid' ? snapshot.bids : snapshot.asks
      const idx = levels.findIndex(l => l.price === change.price)

      if (change.size === 0) {
        // Remove level
        if (idx !== -1) levels.splice(idx, 1)
      } else if (idx !== -1) {
        // Update existing level
        levels[idx].size = change.size
      } else {
        // Insert new level
        levels.push({ price: change.price, size: change.size })
      }
    }

    // Re-sort after mutations
    snapshot.bids.sort((a, b) => b.price - a.price)
    snapshot.asks.sort((a, b) => a.price - b.price)
    snapshot.lastUpdate = Date.now()

    this.notifyCallbacks(tokenId, snapshot)
  }

  // ─── Read API ─────────────────────────────────────────────

  /** Get the current L2 snapshot for a token */
  getSnapshot(tokenId: string): L2Snapshot | null {
    return this.books.get(tokenId) ?? null
  }

  /** Get best bid/ask from L2 data */
  getBBO(tokenId: string): { bid: number; ask: number; spread: number } | null {
    const snap = this.books.get(tokenId)
    if (!snap || snap.bids.length === 0 || snap.asks.length === 0) return null
    const bid = snap.bids[0].price
    const ask = snap.asks[0].price
    return { bid, ask, spread: ask - bid }
  }

  /**
   * Compute depth imbalance at configurable depth.
   * Returns value in [-1, 1]: positive = more bids (bullish pressure).
   */
  getDepthImbalance(tokenId: string, topN = 5): DepthImbalance {
    const snap = this.books.get(tokenId)
    if (!snap) {
      return { imbalance: 0, bidSize: 0, askSize: 0, bidLevels: 0, askLevels: 0, weightedImbalance: 0 }
    }

    const topBids = snap.bids.slice(0, topN)
    const topAsks = snap.asks.slice(0, topN)

    const bidSize = topBids.reduce((s, l) => s + l.size, 0)
    const askSize = topAsks.reduce((s, l) => s + l.size, 0)
    const total = bidSize + askSize
    const imbalance = total > 0 ? (bidSize - askSize) / total : 0

    // Weighted imbalance: levels closer to mid get more weight
    const mid = topBids.length > 0 && topAsks.length > 0
      ? (topBids[0].price + topAsks[0].price) / 2
      : 0

    let weightedBid = 0
    let weightedAsk = 0
    if (mid > 0) {
      for (const l of topBids) {
        const proximity = 1 / (1 + Math.abs(l.price - mid) / mid * 100)
        weightedBid += l.size * proximity
      }
      for (const l of topAsks) {
        const proximity = 1 / (1 + Math.abs(l.price - mid) / mid * 100)
        weightedAsk += l.size * proximity
      }
    }
    const weightedTotal = weightedBid + weightedAsk
    const weightedImbalance = weightedTotal > 0 ? (weightedBid - weightedAsk) / weightedTotal : 0

    return {
      imbalance,
      bidSize,
      askSize,
      bidLevels: topBids.length,
      askLevels: topAsks.length,
      weightedImbalance,
    }
  }

  /**
   * Find liquidity walls — price levels with outsized resting liquidity.
   * A "wall" is defined as a level with size > threshold × average level size.
   */
  findLiquidityWalls(tokenId: string, threshold = 3.0, maxLevels = 20): LiquidityWall[] {
    const snap = this.books.get(tokenId)
    if (!snap) return []

    const allLevels = [
      ...snap.bids.slice(0, maxLevels).map(l => ({ ...l, side: 'bid' as const })),
      ...snap.asks.slice(0, maxLevels).map(l => ({ ...l, side: 'ask' as const })),
    ]

    if (allLevels.length === 0) return []

    const avgSize = allLevels.reduce((s, l) => s + l.size, 0) / allLevels.length

    return allLevels
      .filter(l => l.size > avgSize * threshold)
      .map(l => ({
        price: l.price,
        size: l.size,
        side: l.side,
        sizeMultiple: avgSize > 0 ? l.size / avgSize : 0,
      }))
      .sort((a, b) => b.sizeMultiple - a.sizeMultiple)
  }

  // ─── Queue Position Tracking ──────────────────────────────

  /**
   * Register a resting order for queue tracking.
   * Call this when a GTC/GTD order is placed.
   */
  registerRestingOrder(tokenId: string, price: number, size: number): void {
    const key = `${tokenId}:${price}`
    this.restingOrders.set(key, size)

    // Snapshot current level size for delta tracking
    const snap = this.books.get(tokenId)
    if (snap) {
      const level = snap.bids.find(l => l.price === price) || snap.asks.find(l => l.price === price)
      this.prevLevelSizes.set(key, level?.size ?? 0)
    }
  }

  /** Unregister a resting order (filled, cancelled, or expired) */
  unregisterRestingOrder(tokenId: string, price: number): void {
    const key = `${tokenId}:${price}`
    this.restingOrders.delete(key)
    this.prevLevelSizes.delete(key)
  }

  /**
   * Estimate queue position for a resting order.
   *
   * Approximation: when we placed, all existing size was "ahead" of us.
   * As size at our level decreases (fills happen from the front), our queue
   * position improves. New size added after us goes behind.
   */
  getQueuePosition(tokenId: string, price: number): QueuePosition {
    const key = `${tokenId}:${price}`
    const ourSize = this.restingOrders.get(key)
    if (ourSize === undefined) {
      return { sharesAhead: 0, totalAtLevel: 0, queueFraction: 0, levelExists: false }
    }

    const snap = this.books.get(tokenId)
    if (!snap) {
      return { sharesAhead: 0, totalAtLevel: 0, queueFraction: 0, levelExists: false }
    }

    const level = snap.bids.find(l => l.price === price) || snap.asks.find(l => l.price === price)
    if (!level) {
      return { sharesAhead: 0, totalAtLevel: 0, queueFraction: 0, levelExists: false }
    }

    const prevSize = this.prevLevelSizes.get(key) ?? level.size
    // Size that was consumed (filled from front of queue)
    const consumed = Math.max(0, prevSize - level.size)
    // Our estimated position: original position minus consumed
    const initialAhead = Math.max(0, prevSize - ourSize)
    const sharesAhead = Math.max(0, initialAhead - consumed)

    // Update prev for next delta
    this.prevLevelSizes.set(key, level.size)

    return {
      sharesAhead,
      totalAtLevel: level.size,
      queueFraction: level.size > 0 ? sharesAhead / level.size : 0,
      levelExists: true,
    }
  }

  // ─── Aggregate Metrics ────────────────────────────────────

  /** Total bid liquidity within N levels (in shares) */
  getBidDepth(tokenId: string, levels = 10): number {
    const snap = this.books.get(tokenId)
    if (!snap) return 0
    return snap.bids.slice(0, levels).reduce((s, l) => s + l.size, 0)
  }

  /** Total ask liquidity within N levels (in shares) */
  getAskDepth(tokenId: string, levels = 10): number {
    const snap = this.books.get(tokenId)
    if (!snap) return 0
    return snap.asks.slice(0, levels).reduce((s, l) => s + l.size, 0)
  }

  /** Estimated slippage to fill a given size on the ask side */
  estimateBuySlippage(tokenId: string, sizeUSD: number): number {
    const snap = this.books.get(tokenId)
    if (!snap || snap.asks.length === 0) return 1

    const bestAsk = snap.asks[0].price
    let remaining = sizeUSD
    let totalCost = 0
    let totalShares = 0

    for (const level of snap.asks) {
      if (remaining <= 0) break
      const levelValueUSD = level.price * level.size
      const fill = Math.min(levelValueUSD, remaining)
      const shares = fill / level.price
      totalCost += fill
      totalShares += shares
      remaining -= fill
    }

    if (totalShares === 0) return 1
    const avgPrice = totalCost / totalShares
    return bestAsk > 0 ? (avgPrice - bestAsk) / bestAsk : 1
  }

  /** Get number of tracked tokens */
  get trackedCount(): number {
    return this.tracking.size
  }

  /** Clear all state */
  clear(): void {
    this.books.clear()
    this.tracking.clear()
    this.restingOrders.clear()
    this.prevLevelSizes.clear()
  }

  // ─── Internal ─────────────────────────────────────────────

  private notifyCallbacks(tokenId: string, snapshot: L2Snapshot): void {
    for (const cb of this.callbacks) {
      try { cb(tokenId, snapshot) } catch (e) { console.error('[L2Tracker] Callback error:', e) }
    }
  }
}

// Singleton export
export const l2OrderBookTracker = new L2OrderBookTracker()
