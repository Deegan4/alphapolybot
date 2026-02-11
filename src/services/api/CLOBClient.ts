import { BaseApiClient } from './BaseApiClient'
import type { Order, OrderRequest, OrderResult, OrderBook, Trade, PriceHistoryOptions, PriceHistoryPoint, PriceHistoryResponse, SpreadData } from '@/types'
import { ethers } from 'ethers'

// ─── Polymarket CLOB Auth Constants ────────────────────────────
const CLOB_AUTH_DOMAIN = { name: 'ClobAuthDomain', version: '1', chainId: 137 }
const CLOB_AUTH_TYPES = {
  ClobAuth: [
    { name: 'address', type: 'address' },
    { name: 'timestamp', type: 'string' },
    { name: 'nonce', type: 'uint256' },
    { name: 'message', type: 'string' },
  ],
}
const MSG_TO_SIGN = 'This message attests that I control the given wallet'

// ─── API Key Credentials ───────────────────────────────────────
interface ApiKeyCreds {
  key: string
  secret: string
  passphrase: string
}

// ─── HMAC Utilities ────────────────────────────────────────────

/** Decode base64/base64url string to ArrayBuffer (matches official clob-client) */
function base64ToArrayBuffer(b64: string): ArrayBuffer {
  const sanitized = b64
    // Convert base64url → standard base64
    .replace(/-/g, '+')
    .replace(/_/g, '/')
    // Strip any non-base64 characters (for compat with Node Buffer.from)
    .replace(/[^A-Za-z0-9+/=]/g, '')
  const binary = atob(sanitized)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes.buffer
}

/** Encode ArrayBuffer to base64 string (standard, with padding) */
function arrayBufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf)
  let binary = ''
  for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i])
  return btoa(binary)
}

/**
 * Build HMAC-SHA256 signature for L2 auth.
 * Matches Polymarket's official clob-client:
 *   message = timestamp + method + requestPath [+ body]
 *   signature = url-safe base64 of HMAC-SHA256(secret, message)
 *   IMPORTANT: keeps '=' padding in the output
 */
async function buildPolyHmacSignature(
  secret: string,
  timestamp: number,
  method: string,
  requestPath: string,
  body?: string,
): Promise<string> {
  let message = `${timestamp}${method}${requestPath}`
  if (body !== undefined) message += body

  const keyData = base64ToArrayBuffer(secret)
  const cryptoKey = await globalThis.crypto.subtle.importKey(
    'raw', keyData, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  )
  const msgBuf = new TextEncoder().encode(message)
  const sigBuf = await globalThis.crypto.subtle.sign('HMAC', cryptoKey, msgBuf)

  // Standard base64 first, then make URL-safe but KEEP '=' padding
  const sig = arrayBufferToBase64(sigBuf)
  return sig.replace(/\+/g, '-').replace(/\//g, '_')
}

/**
 * CLOB API Client
 * Handles order placement, order book data, and trade execution
 * Uses L1 (EIP-712) auth for key derivation, L2 (HMAC) auth for all other requests
 *
 * @see https://docs.polymarket.com/developers/CLOB/authentication
 */
export class CLOBClient extends BaseApiClient {
  private wallet: ethers.Wallet | null = null
  private creds: ApiKeyCreds | null = null
  /** Polymarket proxy (funder) address — if set, orders use this as maker */
  private funderAddress: string | null = null
  /**
   * EIP-712 signatureType for orders:
   *   0 = EOA (signer IS maker, no proxy)
   *   1 = POLY_PROXY (standard Polymarket proxy wallet — created via email/Magic login)
   *   2 = POLY_GNOSIS_SAFE (rare — Gnosis Safe controlled by signer)
   * Defaults to 1 when proxy is set, 0 when no proxy.
   */
  private _signatureType: number | null = null
  /** One-time diagnostic flag */
  private _authDiagLogged = false

  constructor() {
    // Use local proxy to avoid CORS when running in browser
    // Vite proxies /api/clob → https://clob.polymarket.com
    super(import.meta.env.VITE_CLOB_API_URL || '/api/clob', {
      maxRequestsPerMinute: 50,
      maxRetries: 3,
      timeout: 15000,
    })

    // Allow env var override: VITE_SIGNATURE_TYPE=0|1|2
    const envSigType = import.meta.env.VITE_SIGNATURE_TYPE
    if (envSigType !== undefined && envSigType !== '') {
      const parsed = parseInt(envSigType, 10)
      if (parsed === 0 || parsed === 1 || parsed === 2) {
        this._signatureType = parsed
        console.log(`[CLOBClient] SignatureType from env: ${parsed}`)
      }
    }
  }

  // ─── Wallet & Credential Management ──────────────────────────

  /** Get API credentials for WebSocket user channel auth.
   *  Returns null if credentials haven't been derived yet. */
  getCredentials(): { key: string; secret: string; passphrase: string } | null {
    return this.creds ? { ...this.creds } : null
  }

  /** Initialize with wallet for signing */
  setWallet(wallet: ethers.Wallet): void {
    this.wallet = wallet
  }

  /** Set funder (proxy) address for Polymarket proxy wallets */
  setFunder(address: string | null): void {
    this.funderAddress = address
    if (address) {
      const sigType = this.getSignatureType()
      console.log(`[CLOBClient] Funder/proxy set: ${address} (signatureType=${sigType}: ${sigType === 1 ? 'POLY_PROXY' : sigType === 2 ? 'GNOSIS_SAFE' : 'EOA'})`)
    }
  }

  /** Override the signature type (0=EOA, 1=POLY_PROXY, 2=GNOSIS_SAFE) */
  setSignatureType(type: 0 | 1 | 2): void {
    this._signatureType = type
    console.log(`[CLOBClient] SignatureType override: ${type} (${type === 0 ? 'EOA' : type === 1 ? 'POLY_PROXY' : 'GNOSIS_SAFE'})`)
  }

  /** Get the effective signature type: explicit override > proxy-based default > EOA */
  getSignatureType(): number {
    if (this._signatureType !== null) return this._signatureType
    return this.funderAddress ? 1 : 0 // Default: POLY_PROXY for proxy wallets, EOA otherwise
  }

  /** Set pre-existing API credentials (e.g. loaded from storage) */
  setCredentials(creds: ApiKeyCreds): void {
    this.creds = creds
    console.log('[CLOBClient] API credentials set')
  }

  /** Check if we have valid API credentials */
  hasCredentials(): boolean {
    return this.creds !== null
  }

  // ─── L1 Auth: EIP-712 ClobAuth Signing ───────────────────────

  /** Build L1 headers for auth endpoints (derive-api-key, create-api-key) */
  private async buildL1Headers(): Promise<Record<string, string>> {
    if (!this.wallet) throw new Error('Wallet not initialized')

    const address = await this.wallet.getAddress()
    const timestamp = Math.floor(Date.now() / 1000)
    const nonce = 0

    const value = {
      address,
      timestamp: `${timestamp}`,
      nonce,
      message: MSG_TO_SIGN,
    }

    const sig = await this.wallet.signTypedData(CLOB_AUTH_DOMAIN, CLOB_AUTH_TYPES, value)

    return {
      POLY_ADDRESS: address,
      POLY_SIGNATURE: sig,
      POLY_TIMESTAMP: `${timestamp}`,
      POLY_NONCE: `${nonce}`,
    }
  }

  // ─── L2 Auth: HMAC Per-Request Headers ───────────────────────

  /** Build L2 headers for authenticated API requests */
  private async buildL2Headers(
    method: string,
    requestPath: string,
    body?: string,
  ): Promise<Record<string, string>> {
    if (!this.wallet) throw new Error('Wallet not initialized')
    if (!this.creds) throw new Error('API credentials not set — call deriveApiKey() first')

    const address = await this.wallet.getAddress()
    const timestamp = Math.floor(Date.now() / 1000)

    if (!this._authDiagLogged) {
      this._authDiagLogged = true
      console.log(
        `[CLOBClient] Auth diagnostic — POLY_ADDRESS: ${address}, ` +
        `API_KEY: ${this.creds.key.slice(0, 12)}…, ` +
        `funder: ${this.funderAddress ?? 'none (EOA mode)'}`,
      )
    }

    const sig = await buildPolyHmacSignature(
      this.creds.secret, timestamp, method, requestPath, body,
    )

    return {
      POLY_ADDRESS: address,
      POLY_SIGNATURE: sig,
      POLY_TIMESTAMP: `${timestamp}`,
      POLY_API_KEY: this.creds.key,
      POLY_PASSPHRASE: this.creds.passphrase,
    }
  }

  // ─── API Key Derivation ──────────────────────────────────────

  /**
   * Derive API key from wallet — idempotent, returns same key for same wallet.
   * Uses L1 auth (EIP-712) to authenticate, then stores credentials for L2 use.
   */
  async deriveApiKey(): Promise<ApiKeyCreds | null> {
    if (!this.wallet) return null

    try {
      const l1Headers = await this.buildL1Headers()

      const response = await this.get<{
        apiKey: string
        secret: string
        passphrase: string
      }>('/auth/derive-api-key', { headers: l1Headers })

      this.creds = {
        key: response.apiKey,
        secret: response.secret,
        passphrase: response.passphrase,
      }

      console.log('[CLOBClient] API key derived successfully')
      return this.creds
    } catch (error) {
      console.error('[CLOBClient] Failed to derive API key:', error)
      return null
    }
  }

  /**
   * Create new API key — generates a new key each time.
   * Use deriveApiKey() for idempotent key retrieval.
   */
  async createApiKey(): Promise<ApiKeyCreds | null> {
    if (!this.wallet) return null

    try {
      const l1Headers = await this.buildL1Headers()

      const response = await this.post<{
        apiKey: string
        secret: string
        passphrase: string
      }>('/auth/api-key', undefined, { headers: l1Headers })

      this.creds = {
        key: response.apiKey,
        secret: response.secret,
        passphrase: response.passphrase,
      }

      console.log('[CLOBClient] API key created successfully')
      return this.creds
    } catch (error) {
      console.error('[CLOBClient] Failed to create API key:', error)
      return null
    }
  }

  /** Test whether current credentials authenticate successfully against the CLOB API. */
  async validateCredentials(): Promise<{ valid: boolean; error?: string }> {
    if (!this.creds || !this.wallet) {
      return { valid: false, error: 'Wallet or credentials not set' }
    }
    try {
      // Direct authGet — bypasses getBalanceAllowance()'s try/catch that swallows 401s.
      // Uses getSignatureType() for correct sig type (0=EOA, 2=GNOSIS_SAFE).
      // No token_id param — official client omits it for COLLATERAL queries.
      await this.authGet<unknown>('/balance-allowance', {
        asset_type: 'COLLATERAL',
        signature_type: `${this.getSignatureType()}`,
      })
      return { valid: true }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      const status = (error as { status?: number }).status
      if (status === 401 || msg.includes('401')) {
        return {
          valid: false,
          error: 'CLOB auth failed (401). API credentials do not match this wallet\'s signer. ' +
            'Use "Derive from Wallet" in Settings → API Keys to generate matching credentials.',
        }
      }
      return { valid: false, error: `CLOB auth probe failed: ${msg}` }
    }
  }

  // ─── Authenticated Request Helper ────────────────────────────
  // IMPORTANT: The HMAC signature signs ONLY the bare endpoint path
  // (no query params). Query params go via axios `params` option.

  /** POST with L2 auth headers */
  private async authPost<T>(
    endpoint: string,
    data?: unknown,
    params?: Record<string, string>,
  ): Promise<T> {
    const body = data ? JSON.stringify(data) : undefined
    const headers = await this.buildL2Headers('POST', endpoint, body)
    return this.post<T>(endpoint, data, { headers, params })
  }

  /** GET with L2 auth headers */
  private async authGet<T>(
    endpoint: string,
    params?: Record<string, string>,
  ): Promise<T> {
    const headers = await this.buildL2Headers('GET', endpoint)
    return this.get<T>(endpoint, { headers, params })
  }

  /** DELETE with L2 auth headers */
  private async authDelete<T>(
    endpoint: string,
    data?: unknown,
  ): Promise<T> {
    const body = data ? JSON.stringify(data) : undefined
    const headers = await this.buildL2Headers('DELETE', endpoint, body)
    // Axios delete passes data via config.data, not as second arg
    return this.delete<T>(endpoint, { headers, data })
  }

  // ─── Order Book (Public, No Auth) ────────────────────────────

  /** Get order book for a market */
  async getOrderBook(tokenId: string): Promise<OrderBook | null> {
    try {
      const response = await this.get<{
        market: string
        asset_id: string
        bids: Array<{ price: string; size: string }>
        asks: Array<{ price: string; size: string }>
        timestamp: string
      }>(`/book?token_id=${tokenId}`)

      return {
        marketId: response.market || '',
        bids: response.bids?.map(b => ({
          price: parseFloat(b.price),
          size: parseFloat(b.size),
        })) || [],
        asks: response.asks?.map(a => ({
          price: parseFloat(a.price),
          size: parseFloat(a.size),
        })) || [],
        lastUpdate: Date.now(),
      }
    } catch (error) {
      console.error('Failed to fetch order book:', error)
      return null
    }
  }

  /** Get best bid/ask prices */
  async getBestPrices(tokenId: string): Promise<{ bid: number; ask: number; spread: number } | null> {
    const orderBook = await this.getOrderBook(tokenId)
    if (!orderBook) return null

    const bestBid = orderBook.bids[0]?.price || 0
    const bestAsk = orderBook.asks[0]?.price || 1
    const spread = bestAsk - bestBid

    return { bid: bestBid, ask: bestAsk, spread }
  }

  /** Get midpoint price */
  async getMidPrice(tokenId: string): Promise<number | null> {
    const prices = await this.getBestPrices(tokenId)
    if (!prices) return null
    return (prices.bid + prices.ask) / 2
  }

  // ─── Order Placement (Authenticated) ─────────────────────────

  async placeFOKOrder(request: OrderRequest): Promise<OrderResult> {
    return this.placeOrder({ ...request, type: 'FOK' })
  }

  async placeFAKOrder(request: OrderRequest): Promise<OrderResult> {
    return this.placeOrder({ ...request, type: 'FAK' })
  }

  async placeGTCOrder(request: OrderRequest): Promise<OrderResult> {
    return this.placeOrder({ ...request, type: 'GTC' })
  }

  /**
   * Place an order with L2 auth.
   *
   * The API expects a signed order in the exact schema documented at
   * https://docs.polymarket.com/developers/CLOB/orders/create-order
   *
   * Key differences from our old implementation:
   *  - `owner` is top-level (= API key), NOT nested in `order`
   *  - `order` contains the EIP-712–signed fields with STRING amounts
   *  - `verifyingContract` is required in the EIP-712 domain
   *  - BUY: maker pays collateral, taker pays shares
   *  - SELL: maker pays shares, taker pays collateral
   */
  async placeOrder(request: OrderRequest): Promise<OrderResult> {
    if (!this.wallet) {
      return { success: false, error: 'Wallet not initialized' }
    }
    if (!this.creds) {
      return { success: false, error: 'API credentials not set — call deriveApiKey() first' }
    }

    try {
      const signerAddress = await this.wallet.getAddress()
      // maker = funder (proxy) if set, otherwise signer (EOA)
      const makerAddress = this.funderAddress || signerAddress
      const signatureType = this.getSignatureType()

      // Snap price to tick size (cents)
      const tickPrice = Math.round(request.price * 100) / 100

      // Round size down to 2 decimals (matches official client's roundDown)
      const rawSize = Math.floor(request.size * 100) / 100

      // Calculate raw amounts (BUY vs SELL)
      // API precision rules:
      //   BUY:  makerAmount (collateral) max 2 decimals, takerAmount (shares) max 4 decimals
      //   SELL: makerAmount (shares) max 4 decimals, takerAmount (collateral) max 2 decimals
      let rawMakerAmt: number
      let rawTakerAmt: number
      if (request.side === 'BUY') {
        // BUY: maker spends collateral (size * price), taker delivers shares (size)
        rawMakerAmt = Math.floor(rawSize * tickPrice * 100) / 100   // collateral → 2 decimals
        rawTakerAmt = Math.floor(rawSize * 10000) / 10000           // shares → 4 decimals
      } else {
        // SELL: maker delivers shares (size), taker pays collateral (size * price)
        rawMakerAmt = Math.floor(rawSize * 10000) / 10000           // shares → 4 decimals
        rawTakerAmt = Math.floor(rawSize * tickPrice * 100) / 100   // collateral → 2 decimals
      }

      // Convert to USDC base units (6 decimals) as BigInt
      const makerAmount = ethers.parseUnits(rawMakerAmt.toFixed(6), 6)
      const takerAmount = ethers.parseUnits(rawTakerAmt.toFixed(6), 6)

      // Random salt for order uniqueness
      const salt = Date.now()

      // Build the order data that gets EIP-712 signed AND sent to the API
      // maker = proxy/funder (holds funds), signer = EOA (signs the order)
      const orderData = {
        salt,
        maker: makerAddress,
        signer: signerAddress,
        taker: ethers.ZeroAddress,
        tokenId: request.tokenId,
        makerAmount,
        takerAmount,
        expiration: request.expiration ?? 0,   // 0 = no expiry; non-zero = GTD Unix timestamp
        nonce: 0,
        feeRateBps: 0,
        side: request.side === 'BUY' ? 0 : 1,
        signatureType, // 0=EOA, 2=GNOSIS_SAFE (proxy)
      }

      // Sign the order (EIP-712) — NegRisk markets use a different verifyingContract
      console.log(`[CLOBClient] Signing order: negRisk=${request.negRisk ?? false}, signatureType=${signatureType}, maker=${makerAddress}, signer=${signerAddress}`)
      const signature = await this.signOrder(orderData, request.negRisk)

      // Build the API request body
      // CRITICAL: The CLOB server reconstructs the EIP-712 hash from these fields
      // to verify the signature. Fields must match the signed data exactly.
      // - side: must be the numeric string "0" (BUY) / "1" (SELL), NOT "BUY"/"SELL"
      // - salt, signatureType: integers (not strings)
      // - makerAmount, takerAmount, expiration, nonce, feeRateBps, side: strings
      const requestBody = {
        order: {
          salt: orderData.salt,
          maker: orderData.maker,
          signer: orderData.signer,
          taker: orderData.taker,
          tokenId: orderData.tokenId,
          makerAmount: makerAmount.toString(),
          takerAmount: takerAmount.toString(),
          expiration: String(request.expiration ?? 0),
          nonce: '0',
          feeRateBps: '0',
          side: String(orderData.side),   // "0" or "1", NOT "BUY"/"SELL"
          signatureType: orderData.signatureType,
          signature,
        },
        owner: this.creds!.key,  // API key, NOT wallet address
        orderType: request.type || 'FOK',
      }

      console.log('[CLOBClient] Submitting order:', JSON.stringify(requestBody, null, 2))

      // Submit with L2 auth headers
      const response = await this.authPost<{
        success?: boolean
        orderID?: string
        transactionsHashes?: string[]
        errorMsg?: string
      }>('/order', requestBody)

      if (response.success || response.orderID) {
        return {
          success: true,
          orderId: response.orderID,
          txHash: response.transactionsHashes?.[0],
        }
      }

      return {
        success: false,
        error: response.errorMsg || 'Order placement failed',
      }
    } catch (error) {
      console.error('Failed to place order:', error)
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      }
    }
  }

  // ─── Order Management (Authenticated) ────────────────────────

  async cancelOrder(orderId: string): Promise<boolean> {
    try {
      // Official: DELETE /order with body { id: orderId }
      const response = await this.authDelete<{ success?: boolean }>(
        '/order',
        { id: orderId },
      )
      return response.success || false
    } catch (error) {
      console.error('Failed to cancel order:', error)
      return false
    }
  }

  async cancelAllOrders(tokenId?: string): Promise<boolean> {
    try {
      if (tokenId) {
        // Official: DELETE /cancel-market-orders with body
        const response = await this.authDelete<{ success?: boolean }>(
          '/cancel-market-orders',
          { asset_id: tokenId },
        )
        return response.success || false
      }
      // Official: DELETE /cancel-all (no body)
      const response = await this.authDelete<{ success?: boolean }>('/cancel-all')
      return response.success || false
    } catch (error) {
      console.error('Failed to cancel orders:', error)
      return false
    }
  }

  async getOpenOrders(tokenId?: string): Promise<Order[]> {
    try {
      if (!this.wallet) return []

      // Official: GET /data/orders — query params are NOT part of HMAC signature
      // Use funder (proxy) address as maker when set, since orders are placed with proxy as maker
      const signerAddress = await this.wallet.getAddress()
      const makerAddress = this.funderAddress || signerAddress
      const params: Record<string, string> = { maker: makerAddress }
      if (tokenId) params.asset_id = tokenId

      const response = await this.authGet<Order[]>('/data/orders', params)
      return response || []
    } catch (error) {
      console.error('Failed to fetch open orders:', error)
      return []
    }
  }

  async getOrder(orderId: string): Promise<Order | null> {
    try {
      // Official: GET /data/order/{id}
      const response = await this.authGet<Order>(`/data/order/${orderId}`)
      return response
    } catch (error) {
      console.error('Failed to fetch order:', error)
      return null
    }
  }

  async getTrades(tokenId: string, limit = 100): Promise<Trade[]> {
    try {
      // Official: GET /data/trades (public, no auth needed)
      const response = await this.get<Trade[]>('/data/trades', {
        params: { asset_id: tokenId, limit: `${limit}` },
      })
      return response || []
    } catch (error) {
      console.error('Failed to fetch trades:', error)
      return []
    }
  }

  // ─── Balance / Allowance Check ─────────────────────────────

  /**
   * Check CLOB-side USDC balance and allowance.
   * This reflects what the CLOB exchange actually sees — may differ from
   * on-chain wallet balance if approvals or deposits are pending.
   *
   * Returns `allowance: null` when the API doesn't include the field
   * (some signature types or API versions omit it). Callers should treat
   * null allowance as "unknown — don't block on it".
   *
   * @param signatureType 0=EOA, 1=Proxy, 2=GnosisSafe
   */
  async getBalanceAllowance(signatureType?: number): Promise<{ balance: number; allowance: number | null } | null> {
    // Default to auto-detect: use GNOSIS_SAFE (2) if proxy is set, else EOA (0)
    const sigType = signatureType ?? this.getSignatureType()
    if (!this.creds || !this.wallet) return null

    try {
      const response = await this.authGet<Record<string, string>>('/balance-allowance', {
        asset_type: 'COLLATERAL',
        signature_type: `${sigType}`,
      })

      const balance = parseFloat(response.balance || '0') / 1e6

      // The API may omit `allowance` entirely for certain signature types.
      // Treat missing / undefined as null (unknown) rather than 0 (denied).
      const rawAllowance = response.allowance
      const allowance = rawAllowance != null ? parseFloat(rawAllowance) / 1e6 : null

      console.log(`[CLOBClient] CLOB balance/allowance (sigType=${sigType}): ` +
        `balance=$${balance.toFixed(4)}, allowance=${allowance != null ? `$${allowance.toFixed(4)}` : 'N/A'} ` +
        `(raw: ${response.balance} / ${response.allowance})`)

      return { balance, allowance }
    } catch (error) {
      // Non-critical — log but don't block trading
      console.warn('[CLOBClient] Failed to check CLOB balance:', error instanceof Error ? error.message : error)
      return null
    }
  }

  /**
   * Refresh the CLOB's cached balance/allowance from on-chain state, then read.
   * The official Polymarket client's updateBalanceAllowance returns void —
   * the /update endpoint triggers a server-side refresh but returns no body.
   * So we fire the update, then immediately call getBalanceAllowance to read.
   */
  async updateBalanceAllowance(signatureType?: number): Promise<{ balance: number; allowance: number | null } | null> {
    const sigType = signatureType ?? this.getSignatureType()
    if (!this.creds || !this.wallet) return null

    try {
      // Fire the cache refresh (returns void / empty body per official client)
      await this.authGet<unknown>('/balance-allowance/update', {
        asset_type: 'COLLATERAL',
        signature_type: `${sigType}`,
      })
      console.log(`[CLOBClient] Balance cache refresh triggered (sigType=${sigType})`)
    } catch (error) {
      console.warn('[CLOBClient] Failed to trigger balance cache refresh:', error instanceof Error ? error.message : error)
    }

    // Now read the (hopefully refreshed) value
    return this.getBalanceAllowance(sigType)
  }

  // ─── Price History (Public, No Auth) ─────────────────────────

  /**
   * Get historical prices for a token.
   * GET /prices-history?market={tokenId}&interval={1m|1h|6h|1d|1w|max}
   */
  async getPricesHistory(
    tokenId: string,
    options: PriceHistoryOptions
  ): Promise<PriceHistoryPoint[]> {
    try {
      const params = new URLSearchParams()
      params.set('market', tokenId)
      params.set('interval', options.interval)
      if (options.startTs != null) params.set('startTs', String(options.startTs))
      if (options.endTs != null) params.set('endTs', String(options.endTs))
      if (options.fidelity != null) params.set('fidelity', String(options.fidelity))

      const response = await this.get<PriceHistoryResponse>(
        `/prices-history?${params.toString()}`
      )
      return response?.history || []
    } catch (error) {
      console.error('[CLOBClient] Failed to fetch price history:', error)
      return []
    }
  }

  // ─── Spread Data (Public, No Auth) ──────────────────────────

  /**
   * Get current bid-ask spread for a token.
   * Lightweight alternative to getOrderBook() when only spread data is needed.
   * Wraps getBestPrices() with SpreadData return type.
   */
  async getSpread(tokenId: string): Promise<SpreadData | null> {
    try {
      const prices = await this.getBestPrices(tokenId)
      if (!prices) return null

      return {
        tokenId,
        bid: prices.bid,
        ask: prices.ask,
        spread: prices.spread,
        timestamp: Date.now(),
      }
    } catch (error) {
      console.error('[CLOBClient] Failed to fetch spread:', error)
      return null
    }
  }

  /**
   * Batch spread fetch for multiple tokens.
   * Rate-limit aware: serializes calls through the built-in token bucket.
   */
  async getSpreads(tokenIds: string[]): Promise<Map<string, SpreadData>> {
    const results = new Map<string, SpreadData>()
    for (const tokenId of tokenIds) {
      const spread = await this.getSpread(tokenId)
      if (spread) results.set(tokenId, spread)
    }
    return results
  }

  // ─── EIP-712 Order Signing ───────────────────────────────────

  /** CTF Exchange contract address on Polygon mainnet */
  private static readonly CTF_EXCHANGE = '0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E'

  /** Neg Risk CTF Exchange contract address on Polygon mainnet */
  private static readonly NEG_RISK_CTF_EXCHANGE = '0xC5d563A36AE78145C45a50134d48A1215220f80a'

  /** EIP-712 domain for standard order signing */
  private static readonly ORDER_DOMAIN = {
    name: 'Polymarket CTF Exchange',
    version: '1',
    chainId: 137,
    verifyingContract: CLOBClient.CTF_EXCHANGE,
  }

  /** EIP-712 domain for NegRisk order signing (different verifyingContract!) */
  private static readonly ORDER_DOMAIN_NEG_RISK = {
    name: 'Polymarket CTF Exchange',
    version: '1',
    chainId: 137,
    verifyingContract: CLOBClient.NEG_RISK_CTF_EXCHANGE,
  }

  /** EIP-712 Order type struct */
  private static readonly ORDER_TYPES = {
    Order: [
      { name: 'salt', type: 'uint256' },
      { name: 'maker', type: 'address' },
      { name: 'signer', type: 'address' },
      { name: 'taker', type: 'address' },
      { name: 'tokenId', type: 'uint256' },
      { name: 'makerAmount', type: 'uint256' },
      { name: 'takerAmount', type: 'uint256' },
      { name: 'expiration', type: 'uint256' },
      { name: 'nonce', type: 'uint256' },
      { name: 'feeRateBps', type: 'uint256' },
      { name: 'side', type: 'uint8' },
      { name: 'signatureType', type: 'uint8' },
    ],
  }

  /**
   * Sign an order using EIP-712 typed data.
   *
   * IMPORTANT: The official Polymarket SDK passes ALL order fields as strings
   * to signTypedData. We normalize to strings here to match exactly.
   * ethers v6 signTypedData handles string→uint256 coercion automatically.
   */
  private async signOrder(order: {
    salt: number
    maker: string
    signer: string
    taker: string
    tokenId: string
    makerAmount: bigint
    takerAmount: bigint
    expiration: number
    nonce: number
    feeRateBps: number
    side: number
    signatureType: number
  }, negRisk = false): Promise<string> {
    if (!this.wallet) throw new Error('Wallet not initialized')
    const domain = negRisk ? CLOBClient.ORDER_DOMAIN_NEG_RISK : CLOBClient.ORDER_DOMAIN

    // Normalize ALL fields to strings to match the official Polymarket SDK exactly.
    // The official clob-order-utils passes every field as a string to signTypedData.
    const normalizedOrder = {
      salt: String(order.salt),
      maker: order.maker,
      signer: order.signer,
      taker: order.taker,
      tokenId: order.tokenId,
      makerAmount: order.makerAmount.toString(),
      takerAmount: order.takerAmount.toString(),
      expiration: String(order.expiration),
      nonce: String(order.nonce),
      feeRateBps: String(order.feeRateBps),
      side: String(order.side),
      signatureType: String(order.signatureType),
    }

    const signature = await this.wallet.signTypedData(
      domain,
      CLOBClient.ORDER_TYPES,
      normalizedOrder,
    )

    // ─── Signature Diagnostics ──────────────────────────────
    // Compute the EIP-712 hash and recover signer to verify correctness
    try {
      const hash = ethers.TypedDataEncoder.hash(
        domain,
        CLOBClient.ORDER_TYPES,
        normalizedOrder,
      )
      const recoveredAddress = ethers.verifyTypedData(
        domain,
        CLOBClient.ORDER_TYPES,
        normalizedOrder,
        signature,
      )
      const expectedSigner = await this.wallet.getAddress()
      console.log('[CLOBClient] ─── Signature Diagnostic ───')
      console.log(`  EIP-712 hash:      ${hash}`)
      console.log(`  Recovered signer:  ${recoveredAddress}`)
      console.log(`  Expected signer:   ${expectedSigner}`)
      console.log(`  Match:             ${recoveredAddress.toLowerCase() === expectedSigner.toLowerCase()}`)
      console.log(`  Domain:            ${negRisk ? 'NegRisk' : 'Standard'} (${domain.verifyingContract})`)
      console.log(`  Signature:         ${signature}`)
      console.log(`  Order fields:      salt=${normalizedOrder.salt} maker=${normalizedOrder.maker} signer=${normalizedOrder.signer}`)
      console.log(`                     tokenId=${normalizedOrder.tokenId.slice(0, 20)}...`)
      console.log(`                     makerAmt=${normalizedOrder.makerAmount} takerAmt=${normalizedOrder.takerAmount}`)
      console.log(`                     side=${normalizedOrder.side} sigType=${normalizedOrder.signatureType}`)
      if (recoveredAddress.toLowerCase() !== expectedSigner.toLowerCase()) {
        console.error('[CLOBClient] ⚠️ SIGNATURE RECOVERY MISMATCH — this will cause "invalid signature"!')
      }
    } catch (diagErr) {
      console.warn('[CLOBClient] Signature diagnostic failed:', diagErr)
    }

    return signature
  }
}

// Export singleton instance
export const clobClient = new CLOBClient()
