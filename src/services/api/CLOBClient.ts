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

// ─── Rounding Helpers (matching official Polymarket clob-client) ─

/** Count decimal places of a number (official SDK: decimalPlaces) */
function decimalPlaces(n: number): number {
  if (Number.isInteger(n)) return 0
  const arr = n.toString().split('.')
  if (arr.length <= 1) return 0
  return arr[1].length
}

/** Round to nearest `decimals` places with EPSILON correction (official SDK: roundNormal) */
function roundNormal(n: number, decimals: number): number {
  if (decimalPlaces(n) <= decimals) return n
  return Math.round((n + Number.EPSILON) * 10 ** decimals) / 10 ** decimals
}

/** Round down to `decimals` places (official SDK: roundDown) */
function roundDown(n: number, decimals: number): number {
  if (decimalPlaces(n) <= decimals) return n
  // Add EPSILON before flooring to prevent IEEE-754 drift from truncating
  // e.g. 8.45 * 0.01 = 0.08449999... → without EPSILON, floor gives 0.0844 (wrong)
  // With EPSILON: 0.0845000...01 → floor gives 0.0845 (correct)
  return Math.floor((n + Number.EPSILON) * 10 ** decimals) / 10 ** decimals
}

/** Round up to `decimals` places (official SDK: roundUp). Used for BUY maker amounts. */
function _roundUp(n: number, decimals: number): number {
  if (decimalPlaces(n) <= decimals) return n
  // Subtract EPSILON before ceiling to prevent IEEE-754 drift from false rounding up.
  // e.g. 5.11 * 0.43 = 2.1973 exactly, but JS gives 2.1973000000000003
  // Without correction: ceil(21973.000000000003) = 21974 → 2.1974 (WRONG)
  // With correction:    ceil(21972.999...998)    = 21973 → 2.1973 (correct)
  return Math.ceil((n - Number.EPSILON) * 10 ** decimals) / 10 ** decimals
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

  // ─── Tick Size / NegRisk / Fee Rate Caches ───────────────────
  /** Cache: tokenId → tick size string (e.g. "0.01", "0.001") */
  private tickSizeCache = new Map<string, string>()
  /** Cache: tokenId → negRisk boolean */
  private negRiskCache = new Map<string, boolean>()
  /** Cache: tokenId → fee rate in basis points (e.g. 0 or 1000) */
  private feeRateCache = new Map<string, number>()
  /** Short-lived balance cache to avoid redundant /balance-allowance calls */
  private _balanceCache: { result: { balance: number; allowance: number | null }; ts: number } | null = null
  private static readonly BALANCE_CACHE_TTL_MS = 5_000

  /**
   * Rounding config per tick size — matches the official Polymarket clob-client exactly.
   * price = decimal places for price snapping
   * size  = decimal places for share quantity
   * amount = decimal places for collateral (makerAmt for BUY, takerAmt for SELL)
   */
  static readonly ROUNDING_CONFIG: Record<string, { price: number; size: number; amount: number }> = {
    '0.1':    { price: 1, size: 2, amount: 3 },
    '0.01':   { price: 2, size: 2, amount: 4 },
    '0.001':  { price: 3, size: 2, amount: 5 },
    '0.0001': { price: 4, size: 2, amount: 6 },
  }

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

  /** Compute proxy address for a signer (instance convenience method) */
  computeProxyAddress(signerAddress: string): string {
    return CLOBClient.computePolyProxyAddress(signerAddress)
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

  // ─── Tick Size & NegRisk Queries (Public, No Auth) ──────────

  /**
   * Fetch the tick size for a token from the CLOB API.
   * Cached per-tokenId for the lifetime of the client.
   * Falls back to "0.01" if the API call fails.
   */
  async getTickSize(tokenId: string): Promise<string> {
    const cached = this.tickSizeCache.get(tokenId)
    if (cached) return cached

    try {
      // Official SDK: GET /tick-size?token_id={tokenId}
      // API returns { minimum_tick_size: "0.01" } (object, not bare string)
      const response = await this.get<string | { minimum_tick_size?: string }>(`/tick-size?token_id=${tokenId}`)
      let tickSize: string
      if (typeof response === 'string') {
        tickSize = response.trim().replace(/^"|"$/g, '')
      } else if (response && typeof response === 'object' && 'minimum_tick_size' in response) {
        tickSize = String((response as { minimum_tick_size: string }).minimum_tick_size)
      } else {
        tickSize = '0.01'
      }
      if (CLOBClient.ROUNDING_CONFIG[tickSize]) {
        this.tickSizeCache.set(tokenId, tickSize)
        return tickSize
      }
      console.warn(`[CLOBClient] Unknown tick size "${tickSize}" for token ${tokenId.slice(0, 12)}…, defaulting to 0.01`)
      this.tickSizeCache.set(tokenId, '0.01')
      return '0.01'
    } catch (error) {
      console.warn(`[CLOBClient] Failed to fetch tick size for ${tokenId.slice(0, 12)}…:`, error instanceof Error ? error.message : error)
      return '0.01'
    }
  }

  /**
   * Query whether a token belongs to a NegRisk market from the CLOB API.
   * Cached per-tokenId for the lifetime of the client.
   * Falls back to the caller-provided negRisk value if the API call fails.
   */
  async getNegRisk(tokenId: string): Promise<boolean | null> {
    const cached = this.negRiskCache.get(tokenId)
    if (cached !== undefined) return cached

    try {
      // Official SDK: GET /neg-risk?token_id={tokenId}
      // API returns { neg_risk: true/false } (object, not bare boolean)
      const response = await this.get<boolean | { neg_risk?: boolean }>(`/neg-risk?token_id=${tokenId}`)
      let isNegRisk: boolean
      if (typeof response === 'boolean') {
        isNegRisk = response
      } else if (response && typeof response === 'object' && 'neg_risk' in response) {
        isNegRisk = Boolean((response as { neg_risk: boolean }).neg_risk)
      } else {
        isNegRisk = response === ('true' as unknown as boolean)
      }
      this.negRiskCache.set(tokenId, isNegRisk)
      return isNegRisk
    } catch (error) {
      console.warn(`[CLOBClient] Failed to fetch neg-risk for ${tokenId.slice(0, 12)}…:`, error instanceof Error ? error.message : error)
      return null // Caller should fall back to their own negRisk value
    }
  }

  /**
   * Query the fee rate in basis points for a given token from the CLOB API.
   * Cached per-tokenId for the lifetime of the client.
   * Fee-enabled markets (e.g. 15-min crypto) return 1000; others return 0.
   * Official SDK: GET /fee-rate?token_id={tokenId} → { base_fee: number }
   */
  async getFeeRateBps(tokenId: string): Promise<number> {
    const cached = this.feeRateCache.get(tokenId)
    if (cached !== undefined) return cached

    try {
      const response = await this.get<number | { base_fee?: number; fee_rate_bps?: number }>(`/fee-rate?token_id=${tokenId}`)
      let feeRate: number
      if (typeof response === 'number') {
        feeRate = response
      } else if (response && typeof response === 'object') {
        // Official TS SDK reads `base_fee`; docs sometimes say `fee_rate_bps`
        feeRate = (response as { base_fee?: number }).base_fee
          ?? (response as { fee_rate_bps?: number }).fee_rate_bps
          ?? 0
      } else {
        feeRate = 0
      }
      this.feeRateCache.set(tokenId, feeRate)
      return feeRate
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      console.error(`[CLOBClient] Failed to fetch fee rate for ${tokenId.slice(0, 12)}…:`, msg)
      throw new Error(`Fee rate lookup failed for ${tokenId.slice(0, 12)}…: ${msg}`)
    }
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

      // ─── Fetch tick size, negRisk, and fee rate from CLOB API ─────────
      // These 3 per-token queries are independent — run in parallel to shave ~100-200ms
      // on cold tokens (cached tokens resolve instantly via Map lookup).
      const [tickSize, clobNegRisk, feeRateBps] = await Promise.all([
        this.getTickSize(request.tokenId),
        this.getNegRisk(request.tokenId),
        this.getFeeRateBps(request.tokenId),
      ])
      const roundConfig = CLOBClient.ROUNDING_CONFIG[tickSize] || CLOBClient.ROUNDING_CONFIG['0.01']
      const negRisk = clobNegRisk ?? request.negRisk ?? false

      // Snap price to tick grid (using official SDK's roundNormal with EPSILON correction)
      // and clamp to CLOB valid range [tickSize, 1-tickSize]
      const tickFloat = parseFloat(tickSize)
      const tickPrice = Math.min(
        1 - tickFloat,
        Math.max(tickFloat, roundNormal(request.price, roundConfig.price)),
      )

      // Round size down to `roundConfig.size` decimals (always 2 in current config)
      const rawSize = roundDown(request.size, roundConfig.size)
      if (rawSize <= 0) {
        return { success: false, error: `Order size too small after rounding: ${request.size} → ${rawSize}` }
      }

      // ─── Calculate raw amounts ───
      // FOK orders enforce STRICT precision: maker=size dp (2), taker=amount dp (4).
      // GTC/GTD orders are more permissive: derived field uses amount dp (4+).
      // See: https://github.com/Polymarket/py-clob-client/issues/121
      //
      // For FOK BUY: anchor maker (collateral) to size dp (2), derive taker (shares).
      // For GTC/GTD BUY: anchor taker (shares) to size dp (2), derive maker to amount dp.
      // SELL: always anchor maker (shares) to size dp, derive taker (collateral).
      const orderType = request.type || 'FOK'
      const isFok = orderType === 'FOK'
      let rawMakerAmt: number
      let rawTakerAmt: number
      // CRITICAL: All multiplication-derived amounts must use roundNormal (nearest-round),
      // NOT roundDown/roundUp. JavaScript float math: 5 * 0.94 = 4.699999999999999 (not 4.7).
      // roundDown(4.699999..., 4) = 4.6999 → CLOB rejects "invalid amounts".
      // roundNormal(4.699999..., 4) = 4.7 ✓ — matches CLOB's own server-side calculation.
      // The official Polymarket SDK uses roundNormal for multiplication-derived fields.
      if (request.side === 'BUY') {
        if (isFok) {
          // FOK BUY: maker must be ≤ size dp (2). Anchor maker, derive taker.
          rawMakerAmt = roundNormal(rawSize * tickPrice, roundConfig.size)
          rawTakerAmt = rawMakerAmt / tickPrice
          if (decimalPlaces(rawTakerAmt) > roundConfig.amount) {
            rawTakerAmt = roundDown(rawTakerAmt, roundConfig.amount)
          }
          // Enforce CLOB minimum of 5 shares for BUY orders.
          // rawSize itself can be <5 (e.g., $4.15 / $0.83 = 4.988) or rounding can push below.
          if (rawTakerAmt > 0 && rawTakerAmt < 5) {
            rawTakerAmt = 5
            rawMakerAmt = roundNormal(5 * tickPrice, roundConfig.size)
          }
        } else {
          // GTC/GTD BUY: official SDK approach — anchor taker (shares), derive maker.
          rawTakerAmt = roundDown(rawSize, roundConfig.size)
          // Enforce CLOB minimum of 5 shares for BUY orders
          if (rawTakerAmt > 0 && rawTakerAmt < 5) {
            rawTakerAmt = 5
          }
          rawMakerAmt = rawTakerAmt * tickPrice
          if (decimalPlaces(rawMakerAmt) > roundConfig.amount) {
            rawMakerAmt = roundNormal(rawMakerAmt, roundConfig.amount)
          }
        }
      } else {
        // SELL: anchor maker (shares) to size dp, derive taker (collateral) to amount dp
        rawMakerAmt = roundDown(rawSize, roundConfig.size)
        rawTakerAmt = rawMakerAmt * tickPrice
        if (decimalPlaces(rawTakerAmt) > roundConfig.amount) {
          rawTakerAmt = roundNormal(rawTakerAmt, roundConfig.amount)
        }
      }

      // Convert to USDC base units (6 decimals) as BigInt
      const makerAmount = ethers.parseUnits(rawMakerAmt.toFixed(6), 6)
      const takerAmount = ethers.parseUnits(rawTakerAmt.toFixed(6), 6)

      // Cryptographically random salt to prevent collisions on concurrent orders
      const saltBytes = crypto.getRandomValues(new Uint8Array(8))
      const salt = Number(new DataView(saltBytes.buffer).getBigUint64(0) % BigInt(Number.MAX_SAFE_INTEGER))

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
        feeRateBps,
        side: request.side === 'BUY' ? 0 : 1,
        signatureType, // 0=EOA, 1=POLY_PROXY, 2=GNOSIS_SAFE
      }

      // Sign the order (EIP-712) — NegRisk markets use a different verifyingContract
      console.log(`[CLOBClient] Signing order: negRisk=${negRisk}, tickSize=${tickSize}, feeRateBps=${feeRateBps}, signatureType=${signatureType}, maker=${makerAddress}, signer=${signerAddress}`)
      console.log(`[CLOBClient]   price=${tickPrice} (${roundConfig.price}dp), rawMaker=${rawMakerAmt}, rawTaker=${rawTakerAmt}, type=${orderType}`)
      const signature = await this.signOrder(orderData, negRisk)

      // Build the API request body (must match official SDK's orderToJson exactly).
      // Field types from @polymarket/clob-order-utils Order interface:
      //  - salt: number (integer)
      //  - maker, signer, taker, tokenId, signature: strings
      //  - makerAmount, takerAmount: strings (BigInt.toString())
      //  - expiration, nonce, feeRateBps: STRINGS (not numbers!)
      //  - side: "BUY" / "SELL" (string enum; server maps to uint8 for EIP-712)
      //  - signatureType: number
      // Build request body matching official SDK's orderToJson exactly:
      //  - salt: number (parseInt from string)
      //  - makerAmount, takerAmount, expiration, nonce, feeRateBps: strings
      //  - side: "BUY" | "SELL" (string enum)
      //  - signatureType: number
      //  - deferExec: boolean (top-level, default false)
      //  - postOnly: boolean (top-level, only for GTC/GTD)
      const requestBody: Record<string, unknown> = {
        deferExec: request.deferExec ?? false,
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
          feeRateBps: String(feeRateBps),
          side: request.side === 'BUY' ? 'BUY' : 'SELL',
          signatureType: orderData.signatureType,
          signature,
        },
        owner: this.creds!.key,
        orderType,
      }

      // postOnly is only valid for GTC and GTD (official SDK throws for other types)
      if (typeof request.postOnly === 'boolean') {
        if (orderType !== 'GTC' && orderType !== 'GTD') {
          return { success: false, error: 'postOnly is only supported for GTC and GTD orders' }
        }
        requestBody.postOnly = request.postOnly
      }

      console.log('[CLOBClient] Submitting order:', JSON.stringify(requestBody, null, 2))

      // Submit with L2 auth headers
      const response = await this.authPost<{
        success?: boolean
        orderID?: string
        transactionsHashes?: string[]
        errorMsg?: string
        status?: string
      }>('/order', requestBody)

      if (response.success || response.orderID) {
        const hasTxHash = response.transactionsHashes && response.transactionsHashes.length > 0

        // FOK orders that the CLOB accepted but couldn't match still return
        // an orderID.  Detect this: no transactionsHashes means zero fills.
        // For GTC/GTD orders, no immediate txHash is expected (they sit on the book).
        if (isFok && !hasTxHash) {
          // Query the order to confirm — the CLOB may have matched it after
          // the initial response (rare but possible under load)
          let confirmed = false
          if (response.orderID) {
            try {
              const check = await this.authGet<Order>(`/data/order/${response.orderID}`)
              if (check && (check.status === 'filled' || (check.filledSize && check.filledSize > 0))) {
                confirmed = true
                return {
                  success: true,
                  orderId: response.orderID,
                  txHash: response.transactionsHashes?.[0],
                  filledSize: check.filledSize,
                  avgPrice: check.price,
                }
              }
            } catch {
              // Query failed — treat as unconfirmed
            }
          }
          if (!confirmed) {
            console.warn(`[CLOBClient] FOK order ${response.orderID} accepted but no fills (killed by matching engine)`)
            return {
              success: false,
              error: "FOK order couldn't be fully filled — no matching liquidity",
              orderId: response.orderID,
            }
          }
        }

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
      // Auto-rederive on 401 and retry once — API keys can expire
      const status = (error as { status?: number }).status
      const msg = error instanceof Error ? error.message : String(error)
      const is401 = status === 401 || msg.includes('401')

      if (is401 && !request._retried) {
        console.warn('[CLOBClient] 401 on order — rederiving API key and retrying...')
        const newCreds = await this.deriveApiKey()
        if (newCreds) {
          return this.placeOrder({ ...request, _retried: true })
        }
      }

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

  /**
   * Test the full order signing pipeline against the live CLOB.
   * Places a $1 GTC limit buy well below best ask (won't fill), then cancels it.
   * Returns success/failure with error details.
   */
  async testOrderCycle(): Promise<{ success: boolean; error?: string; orderId?: string }> {
    try {
      if (!this.wallet || !this.creds) {
        return { success: false, error: 'Wallet or CLOB credentials not initialized' }
      }

      // Find a liquid binary market via GammaClient
      const { gammaClient } = await import('@/services/api/GammaClient')
      const markets = await gammaClient.getMarkets({
        active: true,
        closed: false,
        limit: 10,
        sort: 'volume24hr',
      })

      const binary = markets.find(m =>
        m.clobTokenIds && m.clobTokenIds.length === 2 && m.outcomes?.length === 2
      )
      if (!binary || !binary.clobTokenIds?.[0]) {
        return { success: false, error: 'No active binary markets found' }
      }

      const tokenId = binary.clobTokenIds[0] // YES token
      console.log(`[CLOBClient] Test order: using market "${binary.question}" token=${tokenId.slice(0, 10)}...`)

      // Get best ask to price our order well below it
      const prices = await this.getBestPrices(tokenId)
      if (!prices || prices.ask <= 0) {
        return { success: false, error: 'Could not get order book prices' }
      }

      // Use a safe low test price — this GTC limit buy won't fill; we just need a valid
      // price to verify the signing pipeline. Avoids collateral rounding edge cases where
      // high prices + small sizes inflate effective price to >= 1.0 (API rejects).
      const tickSize = await this.getTickSize(tokenId)
      const tickFloat = typeof tickSize === 'string' ? parseFloat(tickSize) : tickSize
      const testPrice = Math.max(tickFloat, 0.01)

      // Place a $1 GTC limit buy (will sit on book, not fill)
      const result = await this.placeOrder({
        tokenId,
        side: 'BUY',
        price: testPrice,
        size: 1.0,
        type: 'GTC',
        negRisk: binary.negRisk ?? false,
      })

      if (!result.success || !result.orderId) {
        return { success: false, error: result.error ?? 'Order placement failed' }
      }

      console.log(`[CLOBClient] Test order placed: ${result.orderId}, cancelling...`)

      // Cancel it immediately
      const cancelled = await this.cancelOrder(result.orderId)
      if (!cancelled) {
        console.warn(`[CLOBClient] Test order cancel failed — order may still be on book`)
      }

      console.log(`[CLOBClient] Test order cycle complete — signing pipeline verified`)
      return { success: true, orderId: result.orderId }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      return { success: false, error: msg }
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

    // Return cached result if fresh (avoids redundant API calls during rapid polling)
    if (this._balanceCache && (Date.now() - this._balanceCache.ts) < CLOBClient.BALANCE_CACHE_TTL_MS) {
      return this._balanceCache.result
    }

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

      const result = { balance, allowance }
      this._balanceCache = { result, ts: Date.now() }

      console.debug(`[CLOBClient] CLOB balance/allowance (sigType=${sigType}): ` +
        `balance=$${balance.toFixed(4)}, allowance=${allowance != null ? `$${allowance.toFixed(4)}` : 'N/A'} ` +
        `(raw: ${response.balance} / ${response.allowance})`)

      return result
    } catch (error) {
      // Auto-rederive on 401 and retry once — API keys can expire
      const status = (error as { status?: number }).status
      const msg = error instanceof Error ? error.message : String(error)
      const is401 = status === 401 || msg.includes('401')

      if (is401 && signatureType === undefined) {
        // Only retry once (signatureType acts as retry guard — undefined on first call)
        console.warn('[CLOBClient] 401 on balance — rederiving API key and retrying...')
        const newCreds = await this.deriveApiKey()
        if (newCreds) {
          return this.getBalanceAllowance(sigType) // pass explicit sigType = won't retry again
        }
      }

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

    // Invalidate local cache so the subsequent read is fresh
    this._balanceCache = null

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

  // ─── CREATE2 Proxy Address Computation ──────────────────────

  /** Polymarket Proxy Wallet Factory on Polygon mainnet */
  private static readonly PROXY_FACTORY = '0xaB45c5A4B0c941a2F231C04C3f49182e1A254052'

  /** Proxy implementation (queried from factory; this is the verified deployed impl) */
  private static readonly PROXY_IMPLEMENTATION = '0x44e999d5c2F66Ef0861317f9A4805AC2e90aEB4f'

  /**
   * Compute the deterministic Polymarket proxy wallet address for a signer EOA.
   *
   * Replicates the on-chain PolyProxyLib.getProxyWalletAddress() from
   * Polymarket's ctf-exchange contracts. The factory deploys minimal proxy
   * clones via CREATE2 with:
   *   salt = keccak256(abi.encodePacked(signer))
   *   creationCode = assembly-built minimal proxy + cloneConstructor("0x")
   *
   * If the computed proxy doesn't match the user-provided funder address,
   * order signing will ALWAYS fail because verifyPolyProxySignature() checks:
   *   getPolyProxyWalletAddress(signer) == maker
   */
  static computePolyProxyAddress(signerAddress: string): string {
    const factory = CLOBClient.PROXY_FACTORY
    const implementation = CLOBClient.PROXY_IMPLEMENTATION

    // Salt = keccak256(abi.encodePacked(signer))
    // On-chain: keccak256(abi.encodePacked(_addr)) where _addr is the signer
    const salt = ethers.keccak256(ethers.solidityPacked(['address'], [signerAddress]))

    // Build creation code matching PolyProxyLib._computeCreationCode assembly:
    //   The minimal proxy bytecode embeds both `factory` (as deployer) and `implementation` (as target).
    //   Structure:
    //     1. Clone bytecode with factory as deployer and implementation as target
    //     2. Appended: abi.encode of cloneConstructor(bytes) call with empty bytes
    const factoryLower = factory.slice(2).toLowerCase()
    const implLower = implementation.slice(2).toLowerCase()

    // This is the exact bytecode pattern from PolyProxyLib._computeCreationCode
    const bufHex =
      '3d3d606380380380913d393d73' +
      factoryLower +
      '5af4602a57600080fd5b602d8060366000396000f3363d3d373d3d3d363d73' +
      implLower +
      '5af43d82803e903d91602b57fd5bf3'

    // Append the cloneConstructor(bytes) calldata with empty bytes arg
    const iface = new ethers.Interface(['function cloneConstructor(bytes)'])
    const consData = iface.encodeFunctionData('cloneConstructor', ['0x'])

    const creationCode = ethers.concat([
      ethers.getBytes('0x' + bufHex),
      ethers.getBytes(consData),
    ])
    const bytecodeHash = ethers.keccak256(creationCode)

    return ethers.getCreate2Address(factory, salt, bytecodeHash)
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

    // Signature verification: recover signer and check match (no verbose logging)
    try {
      const recoveredAddress = ethers.verifyTypedData(
        domain,
        CLOBClient.ORDER_TYPES,
        normalizedOrder,
        signature,
      )
      const expectedSigner = await this.wallet.getAddress()
      if (recoveredAddress.toLowerCase() !== expectedSigner.toLowerCase()) {
        console.error('[CLOBClient] SIGNATURE RECOVERY MISMATCH — recovered:', recoveredAddress.slice(0, 10), 'expected:', expectedSigner.slice(0, 10))
      }
    } catch (diagErr) {
      console.warn('[CLOBClient] Signature verification failed:', diagErr)
    }

    return signature
  }
}

// Export singleton instance
export const clobClient = new CLOBClient()
