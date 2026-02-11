/**
 * Order Book Microstructure Analyzer
 *
 * Tracks order book snapshots over time to compute signals:
 * - Bid/Ask imbalance (weighted by price × size)
 * - Spread dynamics (widening = uncertainty, narrowing = consensus)
 * - Volume-weighted order flow (net aggressive buying/selling)
 *
 * These signals predict short-term price movement better than LLM analysis
 * and are used as confirmation signals for the LLM Prediction Strategy.
 */

export interface MicrostructureSignal {
  tokenId: string
  timestamp: number

  /** Bid volume / Ask volume ratio. >1 = bullish (more bids than asks) */
  bidAskRatio: number

  /** Normalized imbalance: (bidVol - askVol) / (bidVol + askVol). Range [-1, 1] */
  imbalance: number

  /** Current spread as fraction of mid price */
  spreadFraction: number

  /** Whether spread is widening compared to 30s EMA */
  spreadWidening: boolean

  /** Aggregate signal: -1 (strong sell) to +1 (strong buy) */
  compositeSignal: number

  /** Confidence in the signal (0-1, based on data freshness and consistency) */
  signalConfidence: number
}

interface SnapshotEntry {
  timestamp: number
  bidVolume: number
  askVolume: number
  spread: number
  midPrice: number
}

// Exponential moving average span in snapshots
const EMA_SPAN = 10

export class MicrostructureAnalyzer {
  /** Per-token snapshot history (capped at 100 snapshots each) */
  private snapshots = new Map<string, SnapshotEntry[]>()
  private maxSnapshotsPerToken = 100

  /**
   * Record a new order book snapshot.
   * Called whenever RealtimeService receives a price update with bid/ask.
   */
  recordSnapshot(
    tokenId: string,
    bidPrice: number,
    bidSize: number,
    askPrice: number,
    askSize: number,
  ): void {
    if (!this.snapshots.has(tokenId)) {
      this.snapshots.set(tokenId, [])
    }

    const history = this.snapshots.get(tokenId)!
    history.push({
      timestamp: Date.now(),
      bidVolume: bidPrice * bidSize,
      askVolume: askPrice * askSize,
      spread: askPrice - bidPrice,
      midPrice: (bidPrice + askPrice) / 2,
    })

    // Trim old snapshots
    if (history.length > this.maxSnapshotsPerToken) {
      history.splice(0, history.length - this.maxSnapshotsPerToken)
    }
  }

  /**
   * Get the current microstructure signal for a token.
   * Returns null if insufficient data (< 3 snapshots).
   */
  getSignal(tokenId: string): MicrostructureSignal | null {
    const history = this.snapshots.get(tokenId)
    if (!history || history.length < 3) return null

    const latest = history[history.length - 1]
    const totalBidVol = latest.bidVolume
    const totalAskVol = latest.askVolume
    const totalVol = totalBidVol + totalAskVol

    // Bid/Ask ratio and imbalance
    const bidAskRatio = totalAskVol > 0 ? totalBidVol / totalAskVol : 1
    const imbalance = totalVol > 0 ? (totalBidVol - totalAskVol) / totalVol : 0

    // Spread analysis
    const midPrice = latest.midPrice || 1
    const spreadFraction = midPrice > 0 ? latest.spread / midPrice : 0

    // Spread EMA (detect widening)
    const recentSpreads = history.slice(-EMA_SPAN)
    const ema = this.computeEMA(recentSpreads.map(s => s.spread))
    const spreadWidening = latest.spread > ema * 1.1 // 10% above EMA = widening

    // Composite signal: weighted combination
    // - Imbalance is the strongest signal (40%)
    // - Spread narrowing is bullish confirmation (20%)
    // - Trend of imbalance over last 5 snapshots (40%)
    const recentImbalances = history.slice(-5).map(s => {
      const tv = s.bidVolume + s.askVolume
      return tv > 0 ? (s.bidVolume - s.askVolume) / tv : 0
    })
    const imbalanceTrend = this.computeTrend(recentImbalances)

    let compositeSignal = 0
    compositeSignal += imbalance * 0.4
    compositeSignal += (spreadWidening ? -0.1 : 0.1) * 0.2
    compositeSignal += imbalanceTrend * 0.4

    // Clamp to [-1, 1]
    compositeSignal = Math.max(-1, Math.min(1, compositeSignal))

    // Confidence based on data freshness and volume
    const ageSec = (Date.now() - latest.timestamp) / 1000
    const freshnessConf = Math.max(0, 1 - ageSec / 60) // Decays over 60s
    const volumeConf = Math.min(1, totalVol / 100) // More volume = more confidence
    const historyConf = Math.min(1, history.length / 20) // More history = more confidence
    const signalConfidence = freshnessConf * 0.4 + volumeConf * 0.3 + historyConf * 0.3

    return {
      tokenId,
      timestamp: Date.now(),
      bidAskRatio: Math.round(bidAskRatio * 1000) / 1000,
      imbalance: Math.round(imbalance * 1000) / 1000,
      spreadFraction: Math.round(spreadFraction * 10000) / 10000,
      spreadWidening,
      compositeSignal: Math.round(compositeSignal * 1000) / 1000,
      signalConfidence: Math.round(signalConfidence * 100) / 100,
    }
  }

  /**
   * Check if microstructure confirms a bullish thesis.
   * Used as a confirmation gate: LLM says buy, but microstructure disagrees → skip.
   */
  confirmsBullish(tokenId: string, threshold = 0.1): boolean {
    const signal = this.getSignal(tokenId)
    if (!signal) return true // No data = don't block
    if (signal.signalConfidence < 0.3) return true // Low confidence = don't block
    // Only block if order book ACTIVELY disagrees (signal below -threshold).
    // Neutral signals (within dead zone) don't override the LLM.
    return signal.compositeSignal >= -threshold
  }

  /**
   * Check if microstructure confirms a bearish thesis.
   */
  confirmsBearish(tokenId: string, threshold = 0.1): boolean {
    const signal = this.getSignal(tokenId)
    if (!signal) return true
    if (signal.signalConfidence < 0.3) return true
    // Only block if order book ACTIVELY disagrees (signal above +threshold).
    return signal.compositeSignal <= threshold
  }

  /**
   * Clear all data for a token (when unsubscribing).
   */
  clearToken(tokenId: string): void {
    this.snapshots.delete(tokenId)
  }

  /**
   * Get snapshot count for a token (for diagnostics).
   */
  getSnapshotCount(tokenId: string): number {
    return this.snapshots.get(tokenId)?.length ?? 0
  }

  private computeEMA(values: number[]): number {
    if (values.length === 0) return 0
    const alpha = 2 / (values.length + 1)
    let ema = values[0]
    for (let i = 1; i < values.length; i++) {
      ema = alpha * values[i] + (1 - alpha) * ema
    }
    return ema
  }

  private computeTrend(values: number[]): number {
    if (values.length < 2) return 0
    // Simple: last value minus first value
    return values[values.length - 1] - values[0]
  }
}

// Export singleton
export const microstructureAnalyzer = new MicrostructureAnalyzer()
