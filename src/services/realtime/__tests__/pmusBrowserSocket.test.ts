import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as ed25519 from '@noble/ed25519'
import {
  signWsHandshake, bridgeUrl, eventForMessage,
  BrowserMarketsWebSocket, BrowserPrivateWebSocket, MARKETS_WS_PATH,
} from '../pmusBrowserSocket'

const toB64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes))
const fromB64 = (b64: string) => Uint8Array.from(atob(b64), c => c.charCodeAt(0))

describe('signWsHandshake', () => {
  it('signs timestamp + GET + path with the Ed25519 key, as the exchange verifies it', async () => {
    const priv = ed25519.utils.randomPrivateKey()
    const pub = await ed25519.getPublicKeyAsync(priv)
    const auth = await signWsHandshake('key-1', toB64(priv), MARKETS_WS_PATH, 1_700_000_000_000)
    expect(auth.keyId).toBe('key-1')
    expect(auth.timestamp).toBe('1700000000000')
    const message = new TextEncoder().encode(`1700000000000GET${MARKETS_WS_PATH}`)
    expect(await ed25519.verifyAsync(fromB64(auth.signature), message, pub)).toBe(true)
  })

  it('accepts a 64-byte secret (seed + public key)', async () => {
    const priv = ed25519.utils.randomPrivateKey()
    const pub = await ed25519.getPublicKeyAsync(priv)
    const long = new Uint8Array(64)
    long.set(priv)
    long.set(pub, 32)
    const a = await signWsHandshake('k', toB64(long), '/v1/ws/private', 5)
    const b = await signWsHandshake('k', toB64(priv), '/v1/ws/private', 5)
    expect(a.signature).toBe(b.signature)
  })
})

describe('bridgeUrl', () => {
  it('targets the bridge on the page origin and never carries the secret', () => {
    const url = new URL(bridgeUrl('https://app.example:4000', MARKETS_WS_PATH, { keyId: 'k', timestamp: '5', signature: 'a+b/c=' }))
    expect(url.protocol).toBe('wss:')
    expect(url.host).toBe('app.example:4000')
    expect(url.pathname).toBe('/ws/pm-us/v1/ws/markets')
    expect(Object.fromEntries(url.searchParams)).toEqual({ k: 'k', t: '5', s: 'a+b/c=' })
    expect(bridgeUrl('http://localhost:4000', MARKETS_WS_PATH, { keyId: 'k', timestamp: '5', signature: 's' })).toMatch(/^ws:\/\/localhost:4000\//)
  })
})

describe('eventForMessage', () => {
  it('maps server messages to the events the services listen for', () => {
    expect(eventForMessage({ heartbeat: {} })).toBe('heartbeat')
    expect(eventForMessage({ marketData: {} })).toBe('marketData')
    expect(eventForMessage({ marketDataLite: {} })).toBe('marketDataLite')
    expect(eventForMessage({ trade: {} })).toBe('trade')
    expect(eventForMessage({ orderSubscriptionSnapshot: {} })).toBe('orderSnapshot')
    expect(eventForMessage({ orderSubscriptionUpdate: {} })).toBe('orderUpdate')
    expect(eventForMessage({ positionSubscriptionUpdate: {} })).toBe('positionUpdate')
    expect(eventForMessage({ accountBalanceSubscriptionSnapshot: {} })).toBe('accountBalanceSnapshot')
    expect(eventForMessage({ accountBalanceSubscriptionUpdate: {} })).toBe('accountBalanceUpdate')
    expect(eventForMessage({ error: 'nope' })).toBe('error')
    expect(eventForMessage({ somethingElse: 1 })).toBeNull()
  })
})

/** Minimal stand-in for the browser WebSocket */
class FakeSocket {
  static OPEN = 1
  static CLOSING = 2
  static last: FakeSocket | null = null
  readyState = 0
  sent: string[] = []
  private handlers = new Map<string, Array<(ev: unknown) => void>>()
  constructor(public url: string) { FakeSocket.last = this }
  addEventListener(type: string, fn: (ev: unknown) => void) {
    this.handlers.set(type, [...(this.handlers.get(type) ?? []), fn])
  }
  fire(type: string, ev: unknown = {}) { for (const fn of this.handlers.get(type) ?? []) fn(ev) }
  send(data: string) { this.sent.push(data) }
  close() { this.readyState = 3 }
}

describe('browser sockets', () => {
  let secret: string
  beforeEach(() => {
    secret = toB64(ed25519.utils.randomPrivateKey())
    vi.stubGlobal('WebSocket', FakeSocket)
  })
  afterEach(() => vi.unstubAllGlobals())

  const opts = () => ({ keyId: 'k', secretKey: secret, bridgeOrigin: 'http://localhost:4000' })

  it('connects through the bridge, subscribes and dispatches messages', async () => {
    const ws = new BrowserMarketsWebSocket(opts())
    const events: string[] = []
    const books: unknown[] = []
    ws.on('open', () => events.push('open'))
    ws.on('marketData', (m: unknown) => books.push(m))
    ws.on('heartbeat', () => events.push('heartbeat'))
    await ws.connect()
    const sock = FakeSocket.last!
    expect(sock.url).toContain('/ws/pm-us/v1/ws/markets?k=k&t=')
    expect(sock.url).not.toContain(secret)

    ws.subscribeMarketData('r0', ['m']) // not open yet: ignored, no throw
    expect(sock.sent).toEqual([])

    sock.readyState = FakeSocket.OPEN
    sock.fire('open')
    expect(ws.isConnected).toBe(true)
    ws.subscribeMarketDataLite('r1', ['a', 'b'])
    ws.subscribeTrades('r2', ['a'])
    expect(sock.sent.map(s => JSON.parse(s).subscribe.subscriptionType)).toEqual([
      'SUBSCRIPTION_TYPE_MARKET_DATA_LITE', 'SUBSCRIPTION_TYPE_TRADE',
    ])

    sock.fire('message', { data: JSON.stringify({ marketData: { marketSlug: 'a' } }) })
    sock.fire('message', { data: JSON.stringify({ heartbeat: {} }) })
    expect(books).toHaveLength(1)
    expect(events).toEqual(['open', 'heartbeat'])
  })

  it('reports a refused connection as error then close, without throwing', async () => {
    const ws = new BrowserPrivateWebSocket(opts())
    const events: string[] = []
    ws.on('error', (e: unknown) => events.push(`error:${(e as Error).message}`))
    ws.on('close', () => events.push('close'))
    await ws.connect()
    FakeSocket.last!.readyState = 3
    FakeSocket.last!.fire('close', { reason: 'exchange refused the connection (HTTP 401)' })
    expect(events).toEqual(['error:WebSocket refused: exchange refused the connection (HTTP 401)', 'close'])
    expect(ws.isConnected).toBe(false)
  })

  it('reports a bad secret as error then close', async () => {
    const ws = new BrowserPrivateWebSocket({ keyId: 'k', secretKey: '%%%not-base64', bridgeOrigin: 'http://localhost:4000' })
    const events: string[] = []
    ws.on('error', () => events.push('error'))
    ws.on('close', () => events.push('close'))
    await expect(ws.connect()).resolves.toBeUndefined()
    expect(events).toEqual(['error', 'close'])
  })

  it('sends the private subscriptions', async () => {
    const ws = new BrowserPrivateWebSocket(opts())
    await ws.connect()
    const sock = FakeSocket.last!
    sock.readyState = FakeSocket.OPEN
    sock.fire('open')
    ws.subscribeOrders('o')
    ws.subscribePositions('p', ['m'])
    ws.subscribeAccountBalance('b')
    expect(sock.sent.map(s => JSON.parse(s).subscribe.subscriptionType)).toEqual([
      'SUBSCRIPTION_TYPE_ORDER', 'SUBSCRIPTION_TYPE_POSITION', 'SUBSCRIPTION_TYPE_ACCOUNT_BALANCE',
    ])
  })
})
