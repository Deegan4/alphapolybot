/**
 * OrderFlowImbalanceService — Aggregates Binance aggTrade stream into
 * buy/sell pressure metrics for microstructure analysis.
 *
 * Subscribes to BinanceWSService.onTradeUpdate() and maintains rolling
 * windows of trade flow data per asset. Provides:
 *
 * 1. Order Flow Imbalance (OFI) — net buy vs sell aggression over a window
 * 2. Volume-Weighted OFI — larger trades weighted more heavily
 * 3. Trade Intensity — trades per second (activity level)
 * 4. Aggressor Ratio — fraction of volume from buy vs sell aggressors
 * 5. VWAP Delta — volume-weighted average price vs current price divergence
 *
 * Pure computation on top of BinanceWS trade stream. No API calls.
 * Singleton pattern, consistent with other trading services.
 */

import type { BinanceTradeUpdate } from '@/services/realtime/BinanceWSService'

type CryptoAsset = 'BTC' | 'ETH' | 'SOL' | 'XRP'

interface TradeEntry {
  price: number
  quoteQty: number      // USD value of trade
  isBuyAggressor: boolean
  timestamp: number
}

export interface OrderFlowSnapshot {
  asset: CryptoAsset
  /** Net OFI in [-1, 1]: positive = buy pressure, negative = sell pressure */
  ofi: number
  /** Volume-weighted OFI: larger trades get more weight */
  volumeWeightedOfi: number
  /** Total buy aggressor volume (USD) in window */
  buyVolume: number
  /** Total sell aggressor volume (USD) in window */
  sellVolume: number
  /** Buy aggressor fraction (0-1) */
  buyRatio: number
  /** Trades per second in window */
  tradeIntensity: number
  /** VWAP of buys minus VWAP of sells (positive = buyers paying higher) */
  vwapDelta: number
  /** Number of trades in window */
  tradeCount: number
  /** Window duration used (ms) */
  windowMs: number
  /** Timestamp of computation */
  timestamp: number
}

export interface FlowImbalanceSignal {
  /** Normalized signal in [-1, 1] combining OFI + intensity */
  signal: number
  /** Confidence based on trade count (more trades = more reliable) */
  confidence: number
  /** Is there a significant imbalance? */
  isSignificant: boolean
  /** Direction: 'buy' | 'sell' | 'neutral' */
  direction: 'buy' | 'sell' | 'neutral'
}

type FlowCallback = (asset: CryptoAsset, snapshot: OrderFlowSnapshot) => void

/** Default rolling window: 60 seconds */
const DEFAULT_WINDOW_MS = 60_000
/** Max trades to retain per asset (memory cap) */
const MAX_TRADES_PER_ASSET = 5000
/** Min trades needed for a meaningful signal */
const MIN_TRADES_FOR_SIGNAL = 10
/** OFI threshold for "significant" imbalance */
const SIGNIFICANCE_THRESHOLD = 0.25
/** Emit snapshot every N trades (avoid excessive callbacks) */
const EMIT_INTERVAL_TRADES = 20

export class OrderFlowImbalanceService {
  private trades = new Map<CryptoAsset, TradeEntry[]>()
  private tradeCountSinceEmit = new Map<CryptoAsset, number>()
  private callbacks = new Set<FlowCallback>()
  private unsubscribeBinance: (() => void) | null = null
  private windowMs: number

  constructor(windowMs = DEFAULT_WINDOW_MS) {
    this.windowMs = windowMs
  }

  // ─── Lifecycle ────────────────────────────────────────────

  /** Start consuming trades from BinanceWS */
  async start(): Promise<void> {
    if (this.unsubscribeBinance) return // already running

    const { binanceWSService } = await import('@/services/realtime/BinanceWSService')
    this.unsubscribeBinance = binanceWSService.onTradeUpdate((trade) => {
      this.ingestTrade(trade)
    })
    console.log('[OrderFlowImbalance] Started — consuming aggTrade stream')
  }

  /** Stop consuming trades */
  stop(): void {
    if (this.unsubscribeBinance) {
      this.unsubscribeBinance()
      this.unsubscribeBinance = null
    }
    this.trades.clear()
    this.tradeCountSinceEmit.clear()
    console.log('[OrderFlowImbalance] Stopped')
  }

  /** Subscribe to periodic flow snapshots */
  onFlowUpdate(callback: FlowCallback): () => void {
    this.callbacks.add(callback)
    return () => this.callbacks.delete(callback)
  }

  // ─── Trade Ingestion ──────────────────────────────────────

  /** Ingest a single trade (called by BinanceWS callback) */
  ingestTrade(trade: BinanceTradeUpdate): void {
    const asset = trade.symbol
    let buffer = this.trades.get(asset)
    if (!buffer) {
      buffer = []
      this.trades.set(asset, buffer)
    }

    buffer.push({
      price: trade.price,
      quoteQty: trade.quoteQuantity,
      isBuyAggressor: !trade.isBuyerMaker, // m=false means buyer was taker = buy aggressor
      timestamp: trade.timestamp,
    })

    // Trim old entries
    if (buffer.length > MAX_TRADES_PER_ASSET) {
      buffer.splice(0, buffer.length - MAX_TRADES_PER_ASSET)
    }

    // Emit periodically
    const count = (this.tradeCountSinceEmit.get(asset) ?? 0) + 1
    this.tradeCountSinceEmit.set(asset, count)
    if (count >= EMIT_INTERVAL_TRADES) {
      this.tradeCountSinceEmit.set(asset, 0)
      const snapshot = this.getSnapshot(asset)
      if (snapshot) {
        for (const cb of this.callbacks) {
          try { cb(asset, snapshot) } catch (e) { console.error('[OrderFlowImbalance] Callback error:', e) }
        }
      }
    }
  }

  // ─── Read API ─────────────────────────────────────────────

  /** Get current order flow snapshot for an asset */
  getSnapshot(asset: CryptoAsset, windowMs?: number): OrderFlowSnapshot | null {
    const window = windowMs ?? this.windowMs
    const buffer = this.trades.get(asset)
    if (!buffer || buffer.length === 0) return null

    const cutoff = Date.now() - window
    const windowTrades = buffer.filter(t => t.timestamp >= cutoff)
    if (windowTrades.length === 0) return null

    let buyVolume = 0
    let sellVolume = 0
    let buyCount = 0
    let sellCount = 0
    let buyVwapNum = 0   // numerator for buy VWAP (Σ price×qty)
    let sellVwapNum = 0

    for (const t of windowTrades) {
      if (t.isBuyAggressor) {
        buyVolume += t.quoteQty
        buyCount++
        buyVwapNum += t.price * t.quoteQty
      } else {
        sellVolume += t.quoteQty
        sellCount++
        sellVwapNum += t.price * t.quoteQty
      }
    }

    const totalVolume = buyVolume + sellVolume
    const totalCount = buyCount + sellCount

    // OFI: (buyCount - sellCount) / totalCount
    const ofi = totalCount > 0 ? (buyCount - sellCount) / totalCount : 0

    // Volume-weighted OFI: (buyVol - sellVol) / totalVol
    const volumeWeightedOfi = totalVolume > 0 ? (buyVolume - sellVolume) / totalVolume : 0

    // Buy ratio
    const buyRatio = totalVolume > 0 ? buyVolume / totalVolume : 0.5

    // Trade intensity (trades per second)
    const windowDurationActual = windowTrades.length > 1
      ? windowTrades[windowTrades.length - 1].timestamp - windowTrades[0].timestamp
      : window
    const tradeIntensity = windowDurationActual > 0 ? (totalCount / windowDurationActual) * 1000 : 0

    // VWAP delta: buy VWAP - sell VWAP
    const buyVwap = buyVolume > 0 ? buyVwapNum / buyVolume : 0
    const sellVwap = sellVolume > 0 ? sellVwapNum / sellVolume : 0
    const vwapDelta = (buyVwap > 0 && sellVwap > 0) ? buyVwap - sellVwap : 0

    return {
      asset,
      ofi,
      volumeWeightedOfi,
      buyVolume,
      sellVolume,
      buyRatio,
      tradeIntensity,
      vwapDelta,
      tradeCount: totalCount,
      windowMs: window,
      timestamp: Date.now(),
    }
  }

  /**
   * Get a normalized signal combining OFI and intensity.
   * Higher intensity makes the signal more confident.
   */
  getSignal(asset: CryptoAsset, windowMs?: number): FlowImbalanceSignal {
    const snapshot = this.getSnapshot(asset, windowMs)
    if (!snapshot || snapshot.tradeCount < MIN_TRADES_FOR_SIGNAL) {
      return { signal: 0, confidence: 0, isSignificant: false, direction: 'neutral' }
    }

    // Blend count-based and volume-based OFI (volume gets 70% weight — size matters)
    const blendedOfi = 0.3 * snapshot.ofi + 0.7 * snapshot.volumeWeightedOfi

    // Confidence scales with trade count (asymptotic to 1.0)
    // 10 trades → 0.33, 50 → 0.71, 100 → 0.83, 200 → 0.91
    const confidence = Math.min(1, 1 - 1 / (1 + snapshot.tradeCount / 50))

    const signal = blendedOfi
    const isSignificant = Math.abs(signal) >= SIGNIFICANCE_THRESHOLD && confidence >= 0.3

    let direction: 'buy' | 'sell' | 'neutral' = 'neutral'
    if (isSignificant) {
      direction = signal > 0 ? 'buy' : 'sell'
    }

    return { signal, confidence, isSignificant, direction }
  }

  /** Get trade count in current window for an asset */
  getTradeCount(asset: CryptoAsset, windowMs?: number): number {
    const window = windowMs ?? this.windowMs
    const buffer = this.trades.get(asset)
    if (!buffer) return 0
    const cutoff = Date.now() - window
    return buffer.filter(t => t.timestamp >= cutoff).length
  }

  /** Check if service is running */
  get isRunning(): boolean {
    return this.unsubscribeBinance !== null
  }

  /** Get all tracked assets with data */
  get trackedAssets(): CryptoAsset[] {
    return Array.from(this.trades.keys())
  }
}

// Singleton export
export const orderFlowImbalanceService = new OrderFlowImbalanceService()
