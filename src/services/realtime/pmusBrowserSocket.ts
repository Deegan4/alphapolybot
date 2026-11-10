/**
 * Browser WebSocket client for Polymarket US.
 *
 * The exchange authenticates WebSockets with request headers, which a browser
 * WebSocket cannot send, and the official SDK refuses to open one in a browser
 * at all. So the browser connects to a small bridge instead (the Vite dev
 * server's `/ws/pm-us` route, see vite.config.ts), passing the signed
 * handshake in the query string; the bridge opens the real connection with
 * those values as headers and relays messages both ways.
 *
 * The secret key never leaves the browser: only the key id, a timestamp and
 * the signature of `timestamp + "GET" + path` are sent, exactly what the
 * exchange receives anyway.
 *
 * The message protocol mirrors the SDK's MarketsWebSocket / PrivateWebSocket.
 */

import * as ed25519 from '@noble/ed25519'

export const MARKETS_WS_PATH = '/v1/ws/markets'
export const PRIVATE_WS_PATH = '/v1/ws/private'
/** Path prefix the bridge listens on */
export const WS_BRIDGE_PREFIX = '/ws/pm-us'

// Method-style signature so listeners may declare the specific message type they expect
type Listener = { handle(payload: never): void }['handle']

export interface PmusSocketOptions {
  keyId: string
  secretKey: string
  /** Origin of the bridge (ws:// or http://); defaults to the page's own origin */
  bridgeOrigin?: string
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

function bytesToBase64(bytes: Uint8Array): string {
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin)
}

/** Signed handshake values for a WebSocket path (same scheme as the REST API) */
export async function signWsHandshake(
  keyId: string,
  secretKey: string,
  path: string,
  nowMs = Date.now(),
): Promise<{ keyId: string; timestamp: string; signature: string }> {
  const timestamp = String(nowMs)
  const secret = base64ToBytes(secretKey)
  const privateKey = secret.length === 64 ? secret.slice(0, 32) : secret
  const message = new TextEncoder().encode(`${timestamp}GET${path}`)
  const signature = bytesToBase64(await ed25519.signAsync(message, privateKey))
  return { keyId, timestamp, signature }
}

/** Bridge URL carrying the signed handshake */
export function bridgeUrl(origin: string, path: string, auth: { keyId: string; timestamp: string; signature: string }): string {
  const url = new URL(`${WS_BRIDGE_PREFIX}${path}`, origin)
  url.protocol = url.protocol === 'https:' || url.protocol === 'wss:' ? 'wss:' : 'ws:'
  url.searchParams.set('k', auth.keyId)
  url.searchParams.set('t', auth.timestamp)
  url.searchParams.set('s', auth.signature)
  return url.toString()
}

/** Which event a server message maps to (null = no specific event) */
export function eventForMessage(message: Record<string, unknown>): string | null {
  if ('heartbeat' in message) return 'heartbeat'
  if ('error' in message) return 'error'
  if ('marketData' in message) return 'marketData'
  if ('marketDataLite' in message) return 'marketDataLite'
  if ('trade' in message) return 'trade'
  if ('orderSubscriptionSnapshot' in message || 'ordersSnapshot' in message) return 'orderSnapshot'
  if ('orderSubscriptionUpdate' in message || 'orderUpdate' in message) return 'orderUpdate'
  if ('positionSubscriptionSnapshot' in message || 'positionsSnapshot' in message) return 'positionSnapshot'
  if ('positionSubscriptionUpdate' in message || 'positionUpdate' in message) return 'positionUpdate'
  if ('accountBalanceSubscriptionSnapshot' in message || 'accountBalancesSnapshot' in message) return 'accountBalanceSnapshot'
  if ('accountBalanceSubscriptionUpdate' in message || 'accountBalanceUpdate' in message) return 'accountBalanceUpdate'
  return null
}

class PmusSocket {
  private socket: WebSocket | null = null
  private listeners = new Map<string, Set<Listener>>()

  constructor(private readonly options: PmusSocketOptions, private readonly path: string) {}

  on(event: string, listener: Listener): this {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set())
    this.listeners.get(event)!.add(listener)
    return this
  }

  protected emit(event: string, payload?: unknown): void {
    for (const l of this.listeners.get(event) ?? []) {
      try { (l as (p: unknown) => void)(payload) } catch (e) { console.error(`[pmus-ws] ${event} listener failed:`, e) }
    }
  }

  /** Open the connection. Never rejects: failures arrive as `error` then `close`. */
  async connect(): Promise<void> {
    try {
      const auth = await signWsHandshake(this.options.keyId, this.options.secretKey, this.path)
      const origin = this.options.bridgeOrigin ?? `${location.protocol}//${location.host}`
      const socket = new WebSocket(bridgeUrl(origin, this.path, auth))
      this.socket = socket
      let opened = false
      socket.addEventListener('open', () => { opened = true; this.emit('open') })
      socket.addEventListener('message', (ev) => this.handleMessage(String(ev.data)))
      socket.addEventListener('error', () => this.emit('error', new Error('WebSocket error')))
      socket.addEventListener('close', (ev) => {
        if (this.socket === socket) this.socket = null
        // A close before open means the bridge or the exchange refused the connection
        if (!opened) this.emit('error', new Error(`WebSocket refused${ev.reason ? `: ${ev.reason}` : ''}`))
        this.emit('close')
      })
    } catch (e) {
      this.emit('error', e instanceof Error ? e : new Error(String(e)))
      this.emit('close')
    }
  }

  close(): void {
    const socket = this.socket
    this.socket = null
    if (socket) {
      try { socket.close(1000, 'OK') } catch { /* already closed */ }
      // The services decide about reconnecting on `close`; a socket closed
      // before it opened would otherwise never report it
      if (socket.readyState !== WebSocket.OPEN && socket.readyState !== WebSocket.CLOSING) this.emit('close')
    }
  }

  get isConnected(): boolean {
    return this.socket !== null && this.socket.readyState === WebSocket.OPEN
  }

  protected subscribe(requestId: string, subscriptionType: string, marketSlugs?: string[]): void {
    if (!this.isConnected) return
    this.socket!.send(JSON.stringify({ subscribe: { requestId, subscriptionType, marketSlugs } }))
  }

  private handleMessage(data: string): void {
    let message: Record<string, unknown>
    try {
      message = JSON.parse(data)
    } catch {
      this.emit('error', new Error('Unparseable WebSocket message'))
      return
    }
    const event = eventForMessage(message)
    if (event === 'error') {
      this.emit('error', new Error(typeof message.error === 'string' ? message.error : JSON.stringify(message.error)))
    } else if (event) {
      this.emit(event, message)
    }
  }
}

export class BrowserMarketsWebSocket extends PmusSocket {
  constructor(options: PmusSocketOptions) {
    super(options, MARKETS_WS_PATH)
  }
  subscribeMarketData(requestId: string, marketSlugs: string[]): void {
    this.subscribe(requestId, 'SUBSCRIPTION_TYPE_MARKET_DATA', marketSlugs)
  }
  subscribeMarketDataLite(requestId: string, marketSlugs: string[]): void {
    this.subscribe(requestId, 'SUBSCRIPTION_TYPE_MARKET_DATA_LITE', marketSlugs)
  }
  subscribeTrades(requestId: string, marketSlugs: string[]): void {
    this.subscribe(requestId, 'SUBSCRIPTION_TYPE_TRADE', marketSlugs)
  }
}

export class BrowserPrivateWebSocket extends PmusSocket {
  constructor(options: PmusSocketOptions) {
    super(options, PRIVATE_WS_PATH)
  }
  subscribeOrders(requestId: string, marketSlugs?: string[]): void {
    this.subscribe(requestId, 'SUBSCRIPTION_TYPE_ORDER', marketSlugs)
  }
  subscribePositions(requestId: string, marketSlugs?: string[]): void {
    this.subscribe(requestId, 'SUBSCRIPTION_TYPE_POSITION', marketSlugs)
  }
  subscribeAccountBalance(requestId: string): void {
    this.subscribe(requestId, 'SUBSCRIPTION_TYPE_ACCOUNT_BALANCE')
  }
}
