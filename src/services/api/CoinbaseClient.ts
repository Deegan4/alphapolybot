/**
 * CoinbaseClient — Coinbase Advanced Trade REST API wrapper
 *
 * Handles HMAC-SHA256 signing, spot order placement, balance queries,
 * and historical candle data for the Mean Reversion strategy.
 *
 * Auth: Legacy API key + secret with CB-ACCESS-* headers.
 * Base URL: /api/coinbase (proxied via vite.config.ts / netlify.toml)
 * Product IDs: BTC-USD, ETH-USD, SOL-USD
 */

import type { CoinbaseOrderResult, CoinbaseAccountBalance, CoinbaseCandle } from '@/types'

// ─── Constants ──────────────────────────────────────────────

const BASE_PATH = '/api/coinbase'
const BROKERAGE = '/api/v3/brokerage'

const SYMBOL_TO_PRODUCT: Record<string, string> = {
  BTC: 'BTC-USD',
  ETH: 'ETH-USD',
  SOL: 'SOL-USD',
}

// Coinbase candle granularities (in seconds string for the API)
export const CANDLE_GRANULARITY = {
  ONE_MINUTE: 'ONE_MINUTE',
  FIVE_MINUTE: 'FIVE_MINUTE',
  FIFTEEN_MINUTE: 'FIFTEEN_MINUTE',
  ONE_HOUR: 'ONE_HOUR',
  ONE_DAY: 'ONE_DAY',
} as const

// ─── HMAC Utilities ─────────────────────────────────────────

/** Decode base64 string to ArrayBuffer */
function base64ToArrayBuffer(b64: string): ArrayBuffer {
  const binary = atob(b64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes.buffer
}

/** Encode ArrayBuffer to base64 string */
function arrayBufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf)
  let binary = ''
  for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i])
  return btoa(binary)
}

/**
 * Build Coinbase HMAC-SHA256 signature.
 * Prehash: timestamp + method + requestPath + body
 * Secret: base64-decoded before use as HMAC key
 * Output: base64-encoded signature
 */
async function buildCoinbaseSignature(
  secret: string,
  timestamp: string,
  method: string,
  requestPath: string,
  body: string = '',
): Promise<string> {
  const message = timestamp + method.toUpperCase() + requestPath + body

  const keyData = base64ToArrayBuffer(secret)
  const cryptoKey = await globalThis.crypto.subtle.importKey(
    'raw', keyData, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  )
  const msgBuf = new TextEncoder().encode(message)
  const sigBuf = await globalThis.crypto.subtle.sign('HMAC', cryptoKey, msgBuf)

  return arrayBufferToBase64(sigBuf)
}

// ─── Client ─────────────────────────────────────────────────

export class CoinbaseClient {
  private apiKey = ''
  private secret = ''

  // ─── Configuration ────────────────────────────────────────

  setCredentials(apiKey: string, secret: string): void {
    this.apiKey = apiKey.trim()
    this.secret = secret.trim()
    if (this.apiKey && this.secret) {
      console.log('[CoinbaseClient] Credentials set')
    }
  }

  hasCredentials(): boolean {
    return this.apiKey.length > 0 && this.secret.length > 0
  }

  // ─── Account ──────────────────────────────────────────────

  /** List all accounts with balances */
  async getAccounts(): Promise<CoinbaseAccountBalance[]> {
    const resp = await this.signedRequest('GET', `${BROKERAGE}/accounts`, undefined, { limit: 250 })
    if (!resp.ok) {
      const err = await resp.text()
      console.error('[CoinbaseClient] getAccounts failed:', err)
      return []
    }
    const data = await resp.json()
    return (data.accounts || []).map((a: Record<string, unknown>) => ({
      currency: (a.currency as string) || '',
      available: parseFloat((a.available_balance as Record<string, string>)?.value || '0'),
      hold: parseFloat((a.hold as Record<string, string>)?.value || '0'),
      total: parseFloat((a.available_balance as Record<string, string>)?.value || '0') +
             parseFloat((a.hold as Record<string, string>)?.value || '0'),
    }))
  }

  /** Get available balance for a specific currency */
  async getBalance(currency: string): Promise<number> {
    const accounts = await this.getAccounts()
    const acct = accounts.find(a => a.currency === currency)
    return acct?.available ?? 0
  }

  // ─── Trading ──────────────────────────────────────────────

  /**
   * Place a market order (buy by USD amount, sell by base quantity).
   *
   * For BUY: quoteSize is the USD amount to spend.
   * For SELL: baseSize is the quantity of the asset to sell.
   */
  async placeMarketOrder(
    productId: string,
    side: 'BUY' | 'SELL',
    sizeValue: number,
  ): Promise<CoinbaseOrderResult> {
    if (!this.hasCredentials()) {
      return { success: false, error: 'Coinbase credentials not configured' }
    }

    const clientOrderId = crypto.randomUUID()
    const orderConfig: Record<string, string> = {}

    if (side === 'BUY') {
      orderConfig.quote_size = sizeValue.toFixed(2)
    } else {
      // For sell, we need to send the base quantity
      orderConfig.base_size = sizeValue.toString()
    }

    const body = {
      client_order_id: clientOrderId,
      product_id: productId,
      side,
      order_configuration: {
        market_market_ioc: orderConfig,
      },
    }

    try {
      const resp = await this.signedRequest('POST', `${BROKERAGE}/orders`, body)
      const data = await resp.json()

      if (!resp.ok || !data.success) {
        const errMsg = data.error_response?.message
          || data.error?.message
          || data.message
          || `HTTP ${resp.status}`
        console.error('[CoinbaseClient] Order failed:', errMsg, data)
        return { success: false, error: errMsg }
      }

      const result = data.success_response || data.order || {}
      return {
        success: true,
        orderId: result.order_id || clientOrderId,
        productId,
        side,
        status: result.status || 'PENDING',
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      console.error('[CoinbaseClient] Order error:', msg)
      return { success: false, error: msg }
    }
  }

  /**
   * Place a limit order (GTC).
   */
  async placeLimitOrder(
    productId: string,
    side: 'BUY' | 'SELL',
    baseSize: number,
    limitPrice: number,
  ): Promise<CoinbaseOrderResult> {
    if (!this.hasCredentials()) {
      return { success: false, error: 'Coinbase credentials not configured' }
    }

    const clientOrderId = crypto.randomUUID()
    const body = {
      client_order_id: clientOrderId,
      product_id: productId,
      side,
      order_configuration: {
        limit_limit_gtc: {
          base_size: baseSize.toString(),
          limit_price: limitPrice.toString(),
        },
      },
    }

    try {
      const resp = await this.signedRequest('POST', `${BROKERAGE}/orders`, body)
      const data = await resp.json()

      if (!resp.ok || !data.success) {
        const errMsg = data.error_response?.message || data.message || `HTTP ${resp.status}`
        return { success: false, error: errMsg }
      }

      const result = data.success_response || {}
      return {
        success: true,
        orderId: result.order_id || clientOrderId,
        productId,
        side,
        status: result.status || 'PENDING',
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      return { success: false, error: msg }
    }
  }

  /** Cancel a pending order */
  async cancelOrder(orderId: string): Promise<boolean> {
    try {
      const resp = await this.signedRequest('POST', `${BROKERAGE}/orders/batch_cancel`, {
        order_ids: [orderId],
      })
      const data = await resp.json()
      return data.results?.[0]?.success === true
    } catch {
      return false
    }
  }

  /** Get order details by ID */
  async getOrder(orderId: string): Promise<CoinbaseOrderResult> {
    try {
      const resp = await this.signedRequest('GET', `${BROKERAGE}/orders/historical/${orderId}`)
      if (!resp.ok) return { success: false, error: `HTTP ${resp.status}` }

      const data = await resp.json()
      const order = data.order || {}
      return {
        success: true,
        orderId: order.order_id,
        productId: order.product_id,
        side: order.side,
        filledSize: parseFloat(order.filled_size || '0'),
        filledValue: parseFloat(order.filled_value || '0'),
        avgPrice: parseFloat(order.average_filled_price || '0'),
        status: order.status,
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      return { success: false, error: msg }
    }
  }

  // ─── Market Data (public, but still needs auth on Advanced Trade) ──

  /** Get historical candles for a product */
  async getCandles(
    productId: string,
    granularity: string,
    limit: number = 100,
  ): Promise<CoinbaseCandle[]> {
    const now = Math.floor(Date.now() / 1000)
    // Estimate start time based on granularity and limit
    const granularitySeconds = this.granularityToSeconds(granularity)
    const start = now - (granularitySeconds * limit)

    try {
      const resp = await this.signedRequest('GET', `${BROKERAGE}/products/${productId}/candles`, undefined, {
        start: start.toString(),
        end: now.toString(),
        granularity,
      })
      if (!resp.ok) return []

      const data = await resp.json()
      return (data.candles || []).map((c: Record<string, string>) => ({
        start: parseInt(c.start, 10),
        open: parseFloat(c.open),
        high: parseFloat(c.high),
        low: parseFloat(c.low),
        close: parseFloat(c.close),
        volume: parseFloat(c.volume),
      }))
    } catch {
      return []
    }
  }

  /** Get current ticker price (uses best_bid/best_ask midpoint) */
  async getTickerPrice(productId: string): Promise<number | null> {
    try {
      const resp = await this.signedRequest('GET', `${BROKERAGE}/products/${productId}`)
      if (!resp.ok) return null

      const data = await resp.json()
      return parseFloat(data.price || '0') || null
    } catch {
      return null
    }
  }

  // ─── Helpers ──────────────────────────────────────────────

  /** Convert symbol (BTC/ETH/SOL) to Coinbase product ID */
  static productId(symbol: string): string {
    return SYMBOL_TO_PRODUCT[symbol.toUpperCase()] || `${symbol.toUpperCase()}-USD`
  }

  private granularityToSeconds(granularity: string): number {
    switch (granularity) {
      case 'ONE_MINUTE': return 60
      case 'FIVE_MINUTE': return 300
      case 'FIFTEEN_MINUTE': return 900
      case 'ONE_HOUR': return 3600
      case 'ONE_DAY': return 86400
      default: return 60
    }
  }

  // ─── Signed Request ───────────────────────────────────────

  /**
   * Make an authenticated request to Coinbase Advanced Trade API.
   *
   * Headers: CB-ACCESS-KEY, CB-ACCESS-SIGN, CB-ACCESS-TIMESTAMP
   * Signature: HMAC-SHA256(secret, timestamp + METHOD + path + body)
   */
  private async signedRequest(
    method: string,
    path: string,
    body?: unknown,
    queryParams?: Record<string, string>,
  ): Promise<Response> {
    if (!this.hasCredentials()) {
      return new Response(null, { status: 401, statusText: 'Coinbase credentials not configured' })
    }

    // Build the URL with query params (but sign ONLY the path, no query params)
    // Coinbase HMAC prehash: timestamp + METHOD + requestPath + body
    // requestPath must NOT include query parameters per Coinbase docs.
    let url = `${BASE_PATH}${path}`

    if (queryParams && Object.keys(queryParams).length > 0) {
      const qs = new URLSearchParams(queryParams).toString()
      url += `?${qs}`
    }

    const timestamp = Math.floor(Date.now() / 1000).toString()
    const bodyStr = body ? JSON.stringify(body) : ''

    const signature = await buildCoinbaseSignature(
      this.secret,
      timestamp,
      method.toUpperCase(),
      path, // sign path only, no query params
      bodyStr,
    )

    const headers: Record<string, string> = {
      'CB-ACCESS-KEY': this.apiKey,
      'CB-ACCESS-SIGN': signature,
      'CB-ACCESS-TIMESTAMP': timestamp,
      'Content-Type': 'application/json',
    }

    return fetch(url, {
      method: method.toUpperCase(),
      headers,
      body: bodyStr || undefined,
    })
  }
}

// Singleton export
export const coinbaseClient = new CoinbaseClient()
