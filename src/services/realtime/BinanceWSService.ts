/**
 * BinanceWSService — Real-time crypto price streaming via Binance WebSocket
 *
 * Uses the combined stream endpoint to multiplex BTC/ETH/SOL mini tickers
 * over a single WebSocket connection. Mini tickers push ~1s updates with
 * price, volume, and 24h change — much richer than polling.
 *
 * Free, no API key required, generous rate limits.
 *
 * This fills the gap where Polymarket's RTDS only reliably streams BTC.
 * ETH and SOL get real-time data from Binance instead.
 */

export interface BinancePriceUpdate {
  symbol: 'BTC' | 'ETH' | 'SOL' | 'XRP'
  priceUSD: number
  priceChange24hPct: number
  volume24hUSD: number
  high24h: number
  low24h: number
  timestamp: number
  source: 'binance-ws'
}

/** Binance aggTrade — individual trade with buyer/seller maker flag */
export interface BinanceTradeUpdate {
  symbol: 'BTC' | 'ETH' | 'SOL' | 'XRP'
  price: number
  quantity: number
  quoteQuantity: number   // price × quantity (USD value)
  isBuyerMaker: boolean   // true = sell aggressor (buyer was maker), false = buy aggressor
  timestamp: number
}

type PriceCallback = (price: BinancePriceUpdate) => void
type TradeCallback = (trade: BinanceTradeUpdate) => void
type ConnectionCallback = (status: 'connected' | 'disconnected' | 'error') => void

/** Binance mini ticker payload (24hr rolling window) */
interface MiniTickerEvent {
  e: '24hrMiniTicker'
  s: string   // Symbol, e.g. "ETHUSDT"
  c: string   // Close price (current price)
  o: string   // Open price (24h ago)
  h: string   // High
  l: string   // Low
  v: string   // Base asset volume
  q: string   // Quote asset volume (USD volume)
  E: number   // Event time
}

const STREAMS = [
  'btcusdt@miniTicker', 'ethusdt@miniTicker', 'solusdt@miniTicker', 'xrpusdt@miniTicker',
  'btcusdt@aggTrade', 'ethusdt@aggTrade', 'solusdt@aggTrade', 'xrpusdt@aggTrade',
]
const STREAM_PATH = `/stream?streams=${STREAMS.join('/')}`

// In dev, route through Vite's WebSocket proxy to avoid browser Origin-header rejections.
// In production (Netlify etc.), connect directly to Binance.
const BINANCE_WS_BASE = import.meta.env.VITE_BINANCE_WS_URL
  || (import.meta.env.DEV
    ? `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws/binance`
    : 'wss://stream.binance.com:9443')
const WS_URL = `${BINANCE_WS_BASE}${STREAM_PATH}`

const PAIR_TO_SYMBOL: Record<string, 'BTC' | 'ETH' | 'SOL' | 'XRP'> = {
  BTCUSDT: 'BTC',
  ETHUSDT: 'ETH',
  SOLUSDT: 'SOL',
  XRPUSDT: 'XRP',
}

export class BinanceWSService {
  private ws: WebSocket | null = null
  private reconnectAttempts = 0
  private maxReconnectAttempts = 10
  private reconnectDelay = 1000
  private reconnectTimeout: number | null = null
  private stableResetTimeout: number | null = null
  private stalenessInterval: number | null = null
  private lastConnectTime = 0
  private lastMessageTime = 0

  private prices = new Map<string, BinancePriceUpdate>()
  private priceCallbacks = new Set<PriceCallback>()
  private tradeCallbacks = new Set<TradeCallback>()
  private connectionCallbacks = new Set<ConnectionCallback>()

  /**
   * Connect to Binance combined stream.
   * Idempotent — safe to call multiple times.
   */
  async connect(): Promise<boolean> {
    if (this.ws?.readyState === WebSocket.OPEN) return true

    if (this.ws?.readyState === WebSocket.CONNECTING) {
      return new Promise((resolve) => {
        const check = setInterval(() => {
          if (this.ws?.readyState === WebSocket.OPEN) {
            clearInterval(check)
            resolve(true)
          } else if (!this.ws || this.ws.readyState >= WebSocket.CLOSING) {
            clearInterval(check)
            resolve(false)
          }
        }, 100)
        setTimeout(() => { clearInterval(check); resolve(false) }, 10_000)
      })
    }

    return new Promise((resolve) => {
      try {
        this.ws = new WebSocket(WS_URL)

        this.ws.onopen = () => {
          console.log('[BinanceWS] Connected — streaming BTC/ETH/SOL mini tickers')
          this.lastConnectTime = Date.now()
          this.lastMessageTime = Date.now()
          // Only reset attempts after connection stays up for 5s
          // This prevents rapid connect/disconnect loops from resetting the backoff
          if (this.stableResetTimeout) clearTimeout(this.stableResetTimeout)
          this.stableResetTimeout = window.setTimeout(() => {
            this.reconnectAttempts = 0
          }, 5_000)
          this.startStalenessCheck()
          this.notifyConnection('connected')
          resolve(true)
        }

        this.ws.onmessage = (event) => {
          this.handleMessage(event.data)
        }

        this.ws.onclose = () => {
          // Cancel stable-reset if connection dropped before 5s
          if (this.stableResetTimeout) {
            clearTimeout(this.stableResetTimeout)
            this.stableResetTimeout = null
          }
          const uptime = Date.now() - this.lastConnectTime
          if (uptime < 3_000) {
            console.log(`[BinanceWS] Disconnected after ${uptime}ms (unstable)`)
          } else {
            console.log('[BinanceWS] Disconnected')
          }
          this.notifyConnection('disconnected')
          this.attemptReconnect()
        }

        this.ws.onerror = (error) => {
          console.error('[BinanceWS] WebSocket error:', error)
          this.notifyConnection('error')
          resolve(false)
        }
      } catch (error) {
        console.error('[BinanceWS] Failed to connect:', error)
        resolve(false)
      }
    })
  }

  disconnect(): void {
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout)
      this.reconnectTimeout = null
    }
    if (this.stableResetTimeout) {
      clearTimeout(this.stableResetTimeout)
      this.stableResetTimeout = null
    }
    this.stopStalenessCheck()
    if (this.ws) {
      this.ws.onclose = null // Prevent reconnect on intentional close
      this.ws.close()
      this.ws = null
    }
    this.prices.clear()
  }

  /** Get cached latest price. Synchronous. */
  getCachedPrice(symbol: 'BTC' | 'ETH' | 'SOL' | 'XRP'): BinancePriceUpdate | null {
    return this.prices.get(symbol) || null
  }

  /** Subscribe to price updates. Returns unsubscribe function. */
  onPriceUpdate(callback: PriceCallback): () => void {
    this.priceCallbacks.add(callback)
    return () => this.priceCallbacks.delete(callback)
  }

  /** Subscribe to individual trade updates (aggTrade). Returns unsubscribe function. */
  onTradeUpdate(callback: TradeCallback): () => void {
    this.tradeCallbacks.add(callback)
    return () => this.tradeCallbacks.delete(callback)
  }

  /** Subscribe to connection status changes. Returns unsubscribe function. */
  onConnectionChange(callback: ConnectionCallback): () => void {
    this.connectionCallbacks.add(callback)
    return () => this.connectionCallbacks.delete(callback)
  }

  isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN
  }

  // ─── Internal ────────────────────────────────────────────────

  private handleMessage(raw: string): void {
    this.lastMessageTime = Date.now()
    try {
      // Combined stream wraps each event: { stream: "ethusdt@miniTicker", data: { ... } }
      const envelope = JSON.parse(raw)
      const data = envelope.data
      if (!data) return

      // Route by event type
      if (data.e === 'aggTrade') {
        this.handleAggTrade(data)
        return
      }

      if (data.e !== '24hrMiniTicker') return

      const ticker = data as MiniTickerEvent
      const symbol = PAIR_TO_SYMBOL[ticker.s]
      if (!symbol) return

      const close = parseFloat(ticker.c)
      const open = parseFloat(ticker.o)
      if (close <= 0) return

      const update: BinancePriceUpdate = {
        symbol,
        priceUSD: close,
        priceChange24hPct: open > 0 ? ((close - open) / open) * 100 : 0,
        volume24hUSD: parseFloat(ticker.q) || 0,
        high24h: parseFloat(ticker.h) || close,
        low24h: parseFloat(ticker.l) || close,
        timestamp: ticker.E || Date.now(),
        source: 'binance-ws',
      }

      this.prices.set(symbol, update)

      for (const cb of this.priceCallbacks) {
        try { cb(update) } catch (e) { console.error('[BinanceWS] Callback error:', e) }
      }
    } catch {
      // Ignore malformed messages
    }
  }

  /**
   * Handle Binance aggTrade event — individual aggregated trades.
   * Fields: { e: 'aggTrade', s: 'BTCUSDT', p: '97000.50', q: '0.001', m: true, T: 1234567890 }
   * m = true means buyer was the maker → sell aggressor (taker sold into bid)
   * m = false means seller was the maker → buy aggressor (taker bought from ask)
   */
  private handleAggTrade(data: Record<string, unknown>): void {
    const pair = data.s as string
    if (!pair) return
    const symbol = PAIR_TO_SYMBOL[pair]
    if (!symbol) return

    const price = parseFloat(data.p as string)
    const quantity = parseFloat(data.q as string)
    if (price <= 0 || quantity <= 0) return

    const trade: BinanceTradeUpdate = {
      symbol,
      price,
      quantity,
      quoteQuantity: price * quantity,
      isBuyerMaker: Boolean(data.m),
      timestamp: (data.T as number) || Date.now(),
    }

    for (const cb of this.tradeCallbacks) {
      try { cb(trade) } catch (e) { console.error('[BinanceWS] Trade callback error:', e) }
    }
  }

  /** Binance mini tickers arrive ~1s. If no data for 15s, connection is dead. */
  private startStalenessCheck(): void {
    this.stopStalenessCheck()
    this.stalenessInterval = window.setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN && this.lastMessageTime > 0) {
        const silenceDuration = Date.now() - this.lastMessageTime
        if (silenceDuration > 15_000) {
          console.warn(`[BinanceWS] No data for ${Math.round(silenceDuration / 1000)}s — force-reconnecting`)
          this.ws.close() // triggers onclose → attemptReconnect
        }
      }
    }, 5_000)
  }

  private stopStalenessCheck(): void {
    if (this.stalenessInterval) {
      clearInterval(this.stalenessInterval)
      this.stalenessInterval = null
    }
  }

  private attemptReconnect(): void {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.error('[BinanceWS] Max reconnect attempts reached — triggering emergency stop')
      import('@/services/trading/RiskManager').then(({ riskManager }) => {
        riskManager.emergencyStop('BinanceWS died after max reconnect attempts')
      }).catch(() => {})
      return
    }

    const delay = this.reconnectDelay * Math.pow(2, this.reconnectAttempts)
    this.reconnectAttempts++

    console.log(`[BinanceWS] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})`)

    this.reconnectTimeout = window.setTimeout(() => {
      this.connect()
    }, delay)
  }

  private notifyConnection(status: 'connected' | 'disconnected' | 'error'): void {
    for (const cb of this.connectionCallbacks) {
      try { cb(status) } catch (e) { console.error('[BinanceWS] Connection callback error:', e) }
    }
  }
}

// Singleton export
export const binanceWSService = new BinanceWSService()
