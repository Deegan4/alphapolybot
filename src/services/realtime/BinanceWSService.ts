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

type PriceCallback = (price: BinancePriceUpdate) => void
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

const STREAMS = ['btcusdt@miniTicker', 'ethusdt@miniTicker', 'solusdt@miniTicker', 'xrpusdt@miniTicker']
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
      const data = envelope.data as MiniTickerEvent
      if (!data || data.e !== '24hrMiniTicker') return

      const symbol = PAIR_TO_SYMBOL[data.s]
      if (!symbol) return

      const close = parseFloat(data.c)
      const open = parseFloat(data.o)
      if (close <= 0) return

      const update: BinancePriceUpdate = {
        symbol,
        priceUSD: close,
        priceChange24hPct: open > 0 ? ((close - open) / open) * 100 : 0,
        volume24hUSD: parseFloat(data.q) || 0,
        high24h: parseFloat(data.h) || close,
        low24h: parseFloat(data.l) || close,
        timestamp: data.E || Date.now(),
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
