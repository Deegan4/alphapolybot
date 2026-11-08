/**
 * Polymarket US wire format — pure helpers (unit tested against live fixtures).
 *
 * The polymarket-us@0.1.1 typings do not match what the gateway returns:
 *   - GET /v1/markets/{slug}/bbo and /book are wrapped: `{ marketData: {...} }`
 *   - markets have no `outcome`, `volume` or `liquidity`; they carry inline
 *     `bestBidQuote` / `bestAskQuote`, `orderPriceMinTickSize`,
 *     `minimumTradeQty` and (crypto Up/Down) `assetPriceTerms`
 *   - every market is ONE binary book on ONE slug: YES = long, NO = short.
 *     An event's markets are separate candidates (teams, price ranges, dates),
 *     not the YES and NO halves of one question, and nothing marks a set of
 *     them as mutually exclusive or exhaustive.
 *   - the `outcomes` / `outcomePrices` strings on a market are unreliable
 *     (labels seen as ["No","Yes"] while prices are [yesAsk, noAsk]); use quotes.
 *
 * All prices on the wire are YES-side. NO-side prices are derived:
 *   noBid = 1 - yesAsk, noAsk = 1 - yesBid, noMid = 1 - yesMid.
 */

import type { Market, OrderBook, OrderBookEntry, PriceData } from '@/types/api'

export interface WireAmount { value: string; currency?: string }

export interface WireAssetPriceTerms {
  marketType?: string            // ASSET_PRICE_MARKET_TYPE_UP_DOWN
  asset?: { assetClass?: string; symbol?: string }
  indexSymbol?: string
  horizon?: string               // 5m | 15m | 1h | 1d
  windowStart?: string
  windowEnd?: string
  priceToBeat?: WireAmount | null
  strike?: WireAmount | null
}

export interface WireMarket {
  id: number | string
  slug: string
  title?: string
  question?: string
  subtitle?: string
  description?: string
  active: boolean
  closed: boolean
  startDate?: string
  endDate?: string
  createdAt?: string
  updatedAt?: string
  category?: string
  bestBidQuote?: WireAmount | null
  bestAskQuote?: WireAmount | null
  orderPriceMinTickSize?: number
  minimumTradeQty?: number
  feeCoefficient?: number
  assetPriceTerms?: WireAssetPriceTerms | null
  // Present in the SDK typings but not on the wire today — honored if they appear
  outcome?: string
  volume?: number
  liquidity?: number
}

export interface WireEvent {
  id: number | string
  slug: string
  title: string
  description?: string
  active: boolean
  closed: boolean
  category?: string
  startDate?: string
  endDate?: string
  startTime?: string
  endTime?: string
  tags?: Array<{ label?: string }>
  markets?: WireMarket[]
  volume?: number
  liquidity?: number
}

export interface WireBBO {
  marketSlug: string
  bestBid?: WireAmount | null
  bestAsk?: WireAmount | null
  lastTradePx?: WireAmount | null
  currentPx?: WireAmount | null
  settlementPx?: WireAmount | null
  sharesTraded?: string
  openInterest?: string
  bidDepth?: number
  askDepth?: number
  state?: string
}

export interface WireBookLevel { px: WireAmount; qty: string }

export interface WireBook {
  marketSlug: string
  bids?: WireBookLevel[]
  offers?: WireBookLevel[]
  state?: string
  stats?: {
    lastTradePx?: WireAmount | null
    sharesTraded?: string
    openInterest?: string
    highPx?: WireAmount | null
    lowPx?: WireAmount | null
  }
  transactTime?: string
}

/** `{ marketData: X }` → X; already-unwrapped values pass through */
export function unwrapMarketData<T>(resp: unknown): T {
  if (resp && typeof resp === 'object' && 'marketData' in resp) {
    return (resp as { marketData: T }).marketData
  }
  return resp as T
}

export function amt(a?: WireAmount | null): number {
  if (!a) return 0
  const n = parseFloat(a.value)
  return Number.isFinite(n) ? n : 0
}

const round4 = (n: number) => Math.round(n * 10000) / 10000

/** YES mid from bid/ask (one-sided books fall back to the side present) */
export function yesMid(bid: number, ask: number): number {
  if (bid > 0 && ask > 0) return (bid + ask) / 2
  return ask || bid || 0
}

/**
 * Normalize an event into one binary Market per wire market.
 * `slug` is the tradeable market slug; `eventSlug` groups them.
 * outcomes are always ['Yes', 'No'] (or ['Up', 'Down'] for Up/Down markets)
 * and both outcomes trade on the same slug.
 */
export function normalizeEventToMarkets(event: WireEvent): Market[] {
  const markets = event.markets ?? []
  return markets.map(m => normalizeWireMarket(m, event, markets.length === 1))
}

export function normalizeWireMarket(m: WireMarket, event?: WireEvent, soleMarket = false): Market {
  const bid = amt(m.bestBidQuote)
  const ask = amt(m.bestAskQuote)
  const mid = yesMid(bid, ask)
  const terms = m.assetPriceTerms ?? undefined
  const isUpDown = terms?.marketType === 'ASSET_PRICE_MARKET_TYPE_UP_DOWN'
  const label = m.title || m.question || m.slug
  const eventTitle = event?.title
  const question = !eventTitle || soleMarket || eventTitle === label
    ? (isUpDown && m.subtitle ? `${label} (${m.subtitle})` : (eventTitle || label))
    : `${eventTitle}: ${label}`

  return {
    id: String(m.id),
    slug: m.slug,
    question,
    description: m.description ?? event?.description,
    groupItemTitle: label,
    outcomes: isUpDown ? ['Up', 'Down'] : ['Yes', 'No'],
    outcomeSlugs: [m.slug, m.slug],
    outcomePrices: mid > 0 ? [round4(mid), round4(1 - mid)] : [0, 0],
    bestBid: bid || undefined,
    bestAsk: ask || undefined,
    spread: bid > 0 && ask > 0 ? round4(ask - bid) : undefined,
    active: m.active && (event?.active ?? true),
    closed: m.closed || (event?.closed ?? false),
    // Up/Down: the trading window end is what matters, not the settlement time
    endDate: (isUpDown && terms?.windowEnd) || m.endDate || event?.endDate || event?.endTime || '',
    createdAt: m.createdAt || m.startDate || event?.startTime || '',
    updatedAt: m.updatedAt,
    volume: m.volume ?? 0,
    liquidity: m.liquidity ?? 0,
    category: m.category ?? event?.category,
    tags: event?.tags?.map(t => t.label).filter((l): l is string => Boolean(l)),
    eventSlug: event?.slug,
    orderPriceMinTickSize: m.orderPriceMinTickSize,
    orderMinSize: m.minimumTradeQty,
    feeCoefficient: m.feeCoefficient,
    windowStart: terms?.windowStart,
    windowEnd: terms?.windowEnd,
    priceToBeat: terms?.priceToBeat ? amt(terms.priceToBeat) || undefined : undefined,
  }
}

/**
 * Activity proxies from a BBO (the only place the gateway exposes them):
 * volume ≈ shares traded × price, liquidity ≈ open interest × price, in USD.
 */
export function statsFromBbo(bbo: WireBBO): { volume: number; liquidity: number } {
  const price = yesMid(amt(bbo.bestBid), amt(bbo.bestAsk)) || amt(bbo.lastTradePx) || amt(bbo.currentPx)
  const shares = parseFloat(bbo.sharesTraded ?? '0') || 0
  const oi = parseFloat(bbo.openInterest ?? '0') || 0
  return { volume: Math.round(shares * price), liquidity: Math.round(oi * price) }
}

/**
 * Order markets for a limited stats-lookup budget: two-sided books only,
 * tightest relative spread first (the most tradeable markets).
 */
export function rankForStats(markets: Market[]): Market[] {
  const rel = (m: Market) => {
    const mid = ((m.bestBid ?? 0) + (m.bestAsk ?? 0)) / 2
    return mid > 0 ? (m.spread ?? 1) / mid : Infinity
  }
  return markets.filter(m => m.bestBid && m.bestAsk).sort((a, b) => rel(a) - rel(b))
}

export function priceDataFromBbo(bbo: WireBBO): PriceData {
  const bid = amt(bbo.bestBid)
  const ask = amt(bbo.bestAsk)
  const last = amt(bbo.lastTradePx)
  const mid = yesMid(bid, ask)
  return {
    bid,
    ask,
    last: last || mid,
    mid,
    spread: bid > 0 && ask > 0 ? ask - bid : 0,
    timestamp: new Date(),
  }
}

export function orderBookFromWire(book: WireBook): OrderBook {
  const level = (l: WireBookLevel): OrderBookEntry => ({ price: amt(l.px), size: parseFloat(l.qty) || 0 })
  return {
    marketSlug: book.marketSlug,
    bids: (book.bids ?? []).map(level),
    asks: (book.offers ?? []).map(level),
    lastUpdate: book.transactTime ? new Date(book.transactTime).getTime() : Date.now(),
    state: book.state,
    stats: book.stats ? {
      lastTradePx: amt(book.stats.lastTradePx),
      sharesTraded: parseFloat(book.stats.sharesTraded || '0'),
      openInterest: parseFloat(book.stats.openInterest || '0'),
      highPx: amt(book.stats.highPx),
      lowPx: amt(book.stats.lowPx),
    } : undefined,
  }
}

// ==========================================
// OUTCOME-AWARE VIEWS (YES book → NO terms)
// ==========================================

const flip = (p: number) => (p > 0 ? round4(1 - p) : 0)

/** Price data in the given outcome's terms. YES passes through. */
export function priceForOutcome(pd: PriceData, outcome: 'yes' | 'no'): PriceData {
  if (outcome === 'yes') return pd
  return {
    ...pd,
    bid: flip(pd.ask),
    ask: flip(pd.bid),
    last: flip(pd.last),
    mid: flip(pd.mid),
  }
}

/**
 * Order book in the given outcome's terms. For NO, the asks are the YES bids
 * (a NO buy matches a YES bid at 1 - p) and vice versa; best-first ordering kept.
 */
export function bookForOutcome(book: OrderBook, outcome: 'yes' | 'no'): OrderBook {
  if (outcome === 'yes') return book
  const inv = (l: OrderBookEntry): OrderBookEntry => ({ ...l, price: flip(l.price) })
  return { ...book, bids: book.asks.map(inv), asks: book.bids.map(inv) }
}

// ==========================================
// CRYPTO UP/DOWN SLUGS
// ==========================================

export type UpDownHorizon = '5m' | '15m' | '1h' | '1d'

const HORIZON_SEC: Record<Exclude<UpDownHorizon, '1d'>, number> = { '5m': 300, '15m': 900, '1h': 3600 }

function formatSlugTime(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}-${p(d.getUTCHours())}${p(d.getUTCMinutes())}z`
}

/** UTC instant of 17:00 America/New_York on the NY calendar day containing `at` */
function nyFivePm(at: Date): Date {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(at)
  const get = (t: string) => Number(parts.find(p => p.type === t)?.value)
  const [y, mo, d] = [get('year'), get('month'), get('day')]
  // 17:00 NY is 21:00Z (EDT) or 22:00Z (EST) — pick the one that is 17:00 in NY
  for (const utcHour of [21, 22]) {
    const candidate = new Date(Date.UTC(y, mo - 1, d, utcHour))
    const hour = Number(new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York', hour: 'numeric', hourCycle: 'h23',
    }).format(candidate))
    if (hour === 17) return candidate
  }
  return new Date(Date.UTC(y, mo - 1, d, 22))
}

/**
 * Event slugs for the current and next Up/Down window, e.g.
 * `btc-updown-15m-2026-11-08-0130z` (window start, UTC).
 * Daily windows start at 5pm New York time.
 */
export function upDownEventSlugs(asset: string, horizon: UpDownHorizon, now: Date = new Date()): string[] {
  const a = asset.toLowerCase()
  if (horizon === '1d') {
    const todayStart = nyFivePm(now)
    const current = todayStart.getTime() <= now.getTime()
      ? todayStart
      : nyFivePm(new Date(now.getTime() - 24 * 3600 * 1000))
    const next = nyFivePm(new Date(current.getTime() + 25 * 3600 * 1000))
    return [current, next].map(d => `${a}-updown-1d-${formatSlugTime(d)}`)
  }
  const step = HORIZON_SEC[horizon] * 1000
  const start = Math.floor(now.getTime() / step) * step
  return [start, start + step].map(t => `${a}-updown-${horizon}-${formatSlugTime(new Date(t))}`)
}

/**
 * Express an exchange-reported price (fill / order price) in the outcome's
 * terms. PM US quotes YES-side, so a NO price p is usually reported as 1 - p;
 * since that is not documented for executions, pick whichever reading is
 * closer to the order's own limit (which is in outcome terms).
 */
export function reportedPriceForOutcome(px: number, outcome: 'yes' | 'no', limitInOutcomeTerms: number): number {
  if (outcome === 'yes' || !(px > 0)) return px
  const flipped = 1 - px
  return Math.abs(flipped - limitInOutcomeTerms) <= Math.abs(px - limitInOutcomeTerms)
    ? round4(flipped)
    : px
}

/**
 * Round an order quantity down to the market's tradeable step. Orders need
 * whole contracts unless the market's `minimumTradeQty` is below 1
 * (docs: Create Order -> quantity); live markets list 1 or 0.01. Unknown -> 1.
 * Returns 0 when the quantity is below one step.
 */
export function roundOrderQuantity(shares: number, minimumTradeQty?: number): number {
  const step = minimumTradeQty && minimumTradeQty > 0 ? minimumTradeQty : 1
  if (!(shares > 0)) return 0
  const decimals = Math.max(0, Math.ceil(-Math.log10(step) - 1e-9))
  const steps = Math.floor(shares / step + 1e-9)
  return Number((steps * step).toFixed(decimals))
}

// ==========================================
// PORTFOLIO (docs: Get User Positions / Get Account Balances)
// ==========================================

/** Position quantity fields; the integer ones are rounded and deprecated */
export interface WirePositionQty {
  netPosition?: string
  netPositionDecimal?: string
  qtyBought?: string
  qtyBoughtDecimal?: string
}

const num = (s?: string | null) => {
  const n = parseFloat(s ?? '')
  return Number.isFinite(n) ? n : 0
}

/** Net contracts (positive = YES/long, negative = NO/short), decimal-aware */
export function netPositionQty(p: WirePositionQty): number {
  return p.netPositionDecimal != null ? num(p.netPositionDecimal) : num(p.netPosition)
}

/** Total contracts bought, decimal-aware */
export function qtyBought(p: WirePositionQty): number {
  return p.qtyBoughtDecimal != null ? num(p.qtyBoughtDecimal) : num(p.qtyBought)
}

/** The USD balance entry (balances are listed per currency) */
export function usdBalance<T extends { currency?: string }>(balances?: T[]): T | undefined {
  if (!balances?.length) return undefined
  return balances.find(b => (b.currency ?? '').toUpperCase() === 'USD') ?? balances[0]
}

/**
 * Exchange latency stopgap: an order not processed within 5s is rejected with
 * "Order Processing Max Delay Exceeded" (historically "Global Rate Limit
 * Exceeded"). Both are transient latency rejects, not rate limits, and the
 * docs say the order may be resubmitted without throttling.
 */
export function isTransientLatencyReject(message?: string | null): boolean {
  if (!message) return false
  const m = message.toLowerCase()
  return m.includes('order processing max delay exceeded') || m.includes('global rate limit exceeded')
}

/**
 * Limit price for a maker-only (post-only) buy, in the outcome's terms.
 * Improves the best bid by one tick when the spread allows it, otherwise
 * joins the bid; always strictly below the best ask so the order rests.
 * Returns null when the book is not two-sided or has no room to rest.
 */
export function makerEntryPrice(bid: number, ask: number, tick = 0.01): number | null {
  if (!(bid > 0) || !(ask > 0) || ask <= bid || ask > 1) return null
  const t = tick > 0 ? tick : 0.01
  const decimals = Math.max(0, Math.ceil(-Math.log10(t) - 1e-9))
  const round = (x: number) => Number(x.toFixed(decimals))
  const improved = round(Math.floor((bid + t) / t + 1e-9) * t)
  const price = improved < ask - 1e-9 ? improved : round(Math.floor(bid / t + 1e-9) * t)
  if (price <= 0 || price >= ask - 1e-9 || price >= 1) return null
  return price
}

/**
 * Should an expired maker entry be completed as a taker order? Only when some
 * quantity is still unfilled and the current ask (outcome terms) has not run
 * more than `maxChase` above the maker limit — a price-based proxy for "the
 * entry still makes sense". Returns the quantity to take, or a reason to skip.
 */
export function takerAfterExpiryPlan(input: {
  makerPrice: number
  size: number
  filled: number
  ask: number | null | undefined
  maxChase: number
  minimumTradeQty?: number
}): { take: number; price: number } | { skip: string } {
  const remaining = roundOrderQuantity(input.size - Math.max(0, input.filled), input.minimumTradeQty)
  if (remaining <= 0) return { skip: 'nothing left unfilled' }
  const ask = input.ask ?? 0
  if (!(ask > 0) || ask >= 1) return { skip: 'no ask on the book' }
  if (ask > input.makerPrice + input.maxChase + 1e-9) {
    return { skip: `ask ${ask.toFixed(3)} ran more than ${(input.maxChase * 100).toFixed(0)}¢ above the maker price ${input.makerPrice.toFixed(2)}` }
  }
  return { take: remaining, price: ask }
}
