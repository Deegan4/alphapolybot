/**
 * Market Context Builder
 *
 * Gathers enrichment data from existing singletons to build rich context
 * for LLM prompts. Zero new API calls — reads from in-memory state only.
 *
 * Used by OllamaService to enrich analysis prompts with:
 * - Market quality scores
 * - Historical calibration accuracy per category
 * - Strategy win rate from EdgeTracker
 * - Calibration bias notes
 */

import type { Market } from '@/types'
import { marketScanner } from '@/services/trading/MarketScanner'
import { calibrationTracker } from '@/services/trading/CalibrationTracker'
import { edgeTracker } from '@/services/trading/EdgeTracker'
import { binanceWSService } from '@/services/realtime/BinanceWSService'

export interface MarketContext {
  // Market metadata
  category: string | null
  ageHours: number
  endDate: string | null

  // Quality (from MarketScanner)
  qualityScore: number | null

  // Calibration (from CalibrationTracker)
  categoryAccuracy: number | null
  categorySampleSize: number

  // Edge (from EdgeTracker)
  strategyWinRate: number | null
  strategySampleSize: number

  // Self-awareness (computed from calibration curve)
  calibrationNote: string | null

  // Price trend (from CLOB price history, async-fetched)
  priceTrend: 'rising' | 'falling' | 'stable' | null
  priceMomentum: number | null   // % change over 1h
  priceVolatility: number | null // stddev/mean as %, from 1h history
  priceSupport: number | null    // min price in 1h window
  priceResistance: number | null // max price in 1h window

  // Crypto mode fields (populated by gatherCryptoContext)
  priceChange24h: number | null
  volume24hUSD: number | null
  volatilityRegime: 'low' | 'medium' | 'high' | null
}

/**
 * Gather synchronous market context from existing singletons.
 * All reads are in-memory — no API calls, no async.
 */
export function gatherMarketContext(
  market: Market,
  tokenId: string,
  strategyName: string = 'llm',
): MarketContext {
  // Market metadata
  const category = market.category ?? null
  const ageHours = market.createdAt
    ? (Date.now() - new Date(market.createdAt).getTime()) / (1000 * 60 * 60)
    : 0
  const endDate = market.endDate ?? null

  // Quality score from MarketScanner
  const scanResults = marketScanner.getScanResults()
  const scanResult = scanResults.find(r => r.market.id === market.id)
  const qualityScore = scanResult?.score ?? null

  // Category accuracy from CalibrationTracker
  const catAccuracy = category
    ? calibrationTracker.getCategoryAccuracy(category)
    : null
  const categoryAccuracy = catAccuracy?.accuracy ?? null
  const categorySampleSize = catAccuracy?.sampleSize ?? 0

  // Strategy edge from EdgeTracker
  const edge = edgeTracker.getStrategyEdge(strategyName)
  const strategyWinRate = edge.sampleSize > 0 ? edge.winRate : null
  const strategySampleSize = edge.sampleSize

  // Calibration self-awareness note
  const calibrationNote = buildCalibrationNote(market.outcomePrices)

  return {
    category,
    ageHours,
    endDate,
    qualityScore,
    categoryAccuracy,
    categorySampleSize,
    strategyWinRate,
    strategySampleSize,
    calibrationNote,
    // Price trend — populated separately by enrichWithPriceTrend()
    priceTrend: null,
    priceMomentum: null,
    priceVolatility: null,
    priceSupport: null,
    priceResistance: null,
    // Crypto fields — populated separately by gatherCryptoContext
    priceChange24h: null,
    volume24hUSD: null,
    volatilityRegime: null,
  }
}

/**
 * Build a calibration self-awareness note for the LLM.
 * When we have reliable calibration data, tells the LLM how its
 * confidence maps to actual outcomes in the relevant bucket.
 */
function buildCalibrationNote(outcomePrices: number[]): string | null {
  const calibration = calibrationTracker.getCalibration()
  if (!calibration.isReliable) return null

  // Use the mid-range of outcome prices as a proxy for typical confidence
  const typicalConf = Math.max(...outcomePrices)
  const bucketIndex = Math.min(
    Math.floor(typicalConf * 10),
    9,
  )
  const bucket = calibration.buckets[bucketIndex]

  if (bucket.count < 5) return null

  const predicted = Math.round(bucket.avgPredicted * 100)
  const actual = Math.round(bucket.actualRate * 100)
  const diff = actual - predicted

  if (Math.abs(diff) < 3) return null // Close enough, no note needed

  const direction = diff > 0 ? 'underconfident' : 'overconfident'
  return `When you say ${predicted}% confident, outcomes happen ${actual}% of the time (${direction})`
}

/**
 * Format market context into a concise prompt section.
 * Returns empty string if no useful context is available.
 */
export function formatContextForPrompt(ctx: MarketContext): string {
  const lines: string[] = []

  // Line 1: Category, age, resolution
  const parts: string[] = []
  if (ctx.category) parts.push(`Category: ${ctx.category}`)
  if (ctx.ageHours > 0) {
    const ageDays = Math.floor(ctx.ageHours / 24)
    const ageStr = ageDays > 0 ? `${ageDays}d` : `${Math.round(ctx.ageHours)}h`
    parts.push(`Age: ${ageStr}`)
  }
  if (ctx.endDate) {
    parts.push(`Resolves: ${ctx.endDate.slice(0, 10)}`)
  }
  if (parts.length > 0) lines.push(`- ${parts.join(' | ')}`)

  // Line 2: Historical accuracy for this category
  if (ctx.categoryAccuracy !== null && ctx.categorySampleSize >= 5) {
    lines.push(`- Your past accuracy in ${ctx.category}: ${Math.round(ctx.categoryAccuracy * 100)}% (${ctx.categorySampleSize} samples)`)
  }

  // Line 4: Strategy win rate
  if (ctx.strategyWinRate !== null && ctx.strategySampleSize >= 10) {
    lines.push(`- Strategy win rate: ${Math.round(ctx.strategyWinRate * 100)}% (${ctx.strategySampleSize} closed trades)`)
  }

  // Line 5: Calibration self-awareness
  if (ctx.calibrationNote) {
    lines.push(`- Calibration: ${ctx.calibrationNote}`)
  }

  // Line 6: Price trend (from async enrichment)
  if (ctx.priceTrend && ctx.priceMomentum !== null) {
    const sign = ctx.priceMomentum > 0 ? '+' : ''
    lines.push(`- Price trend (1h): ${ctx.priceTrend} ${sign}${ctx.priceMomentum.toFixed(1)}%`)
  }

  // Line 7: Volatility + support/resistance (from async enrichment)
  if (ctx.priceVolatility !== null && ctx.priceSupport !== null && ctx.priceResistance !== null) {
    lines.push(`- 1h volatility: ${ctx.priceVolatility.toFixed(1)}%, range: ${(ctx.priceSupport * 100).toFixed(1)}¢ – ${(ctx.priceResistance * 100).toFixed(1)}¢`)
  }

  // Crypto-specific lines (Phase 5)
  if (ctx.priceChange24h !== null) {
    lines.push(`- 24h crypto: ${ctx.priceChange24h > 0 ? '+' : ''}${ctx.priceChange24h.toFixed(1)}% change, $${(ctx.volume24hUSD ?? 0).toLocaleString()} vol`)
  }
  if (ctx.volatilityRegime) {
    lines.push(`- Volatility regime: ${ctx.volatilityRegime}`)
  }

  if (lines.length === 0) return ''

  return '\nMARKET SIGNALS:\n' + lines.join('\n')
}

// ─── Async Price Trend Enrichment ─────────────────────────────

interface TrendCacheEntry {
  trend: 'rising' | 'falling' | 'stable'
  momentum: number  // % change
  volatility: number // stddev/mean as %
  support: number    // min price in window
  resistance: number // max price in window
  fetchedAt: number
}

const TREND_CACHE_TTL_MS = 5 * 60 * 1000 // 5 minutes
const trendCache = new Map<string, TrendCacheEntry>()

/**
 * Fetch 1-hour price history for a token and compute trend direction.
 * Results are cached for 5 minutes per tokenId.
 * Fails silently — returns unchanged context on any error.
 */
export async function enrichWithPriceTrend(
  ctx: MarketContext,
  tokenId: string,
): Promise<MarketContext> {
  if (!tokenId) return ctx

  // Check cache
  const cached = trendCache.get(tokenId)
  if (cached && Date.now() - cached.fetchedAt < TREND_CACHE_TTL_MS) {
    return {
      ...ctx,
      priceTrend: cached.trend,
      priceMomentum: cached.momentum,
      priceVolatility: cached.volatility,
      priceSupport: cached.support,
      priceResistance: cached.resistance,
    }
  }

  // US API does not expose a price history endpoint.
  // Price trend enrichment is unavailable — return context unchanged.
  return ctx
}

// ─── Crypto Context Enrichment ──────────────────────────────

/**
 * Detect which crypto asset a market question refers to.
 * Returns the BinanceWS symbol or null if not a crypto market.
 */
function detectCryptoSymbol(question: string): 'BTC' | 'ETH' | 'SOL' | 'XRP' | null {
  const q = question.toUpperCase()
  if (q.includes('BTC') || q.includes('BITCOIN')) return 'BTC'
  if (q.includes('ETH') || q.includes('ETHEREUM')) return 'ETH'
  if (q.includes('SOL') || q.includes('SOLANA')) return 'SOL'
  if (q.includes('XRP') || q.includes('RIPPLE')) return 'XRP'
  return null
}

/**
 * Enrich a MarketContext with real-time crypto data from BinanceWS.
 * Synchronous — reads from in-memory BinanceWS price cache.
 * Returns unchanged context if not a crypto market or no data available.
 */
export function gatherCryptoContext(ctx: MarketContext, market: Market): MarketContext {
  const symbol = detectCryptoSymbol(market.question)
  if (!symbol) return ctx

  const price = binanceWSService.getCachedPrice(symbol)
  if (!price) return ctx

  // Compute volatility regime from 24h range
  const range = price.high24h - price.low24h
  const rangePercent = price.priceUSD > 0 ? (range / price.priceUSD) * 100 : 0
  const volatilityRegime: 'low' | 'medium' | 'high' =
    rangePercent < 3 ? 'low'
    : rangePercent < 8 ? 'medium'
    : 'high'

  return {
    ...ctx,
    priceChange24h: price.priceChange24hPct,
    volume24hUSD: price.volume24hUSD,
    volatilityRegime,
  }
}

/**
 * Format a full crypto prompt context section for the LLM.
 * Includes all available BinanceWS asset data (not just the market's primary asset).
 */
export function formatCryptoDataForPrompt(market: Market): string {
  const lines: string[] = []
  const symbols: Array<'BTC' | 'ETH' | 'SOL' | 'XRP'> = ['BTC', 'ETH', 'SOL', 'XRP']

  for (const sym of symbols) {
    const price = binanceWSService.getCachedPrice(sym)
    if (!price) continue
    const sign = price.priceChange24hPct > 0 ? '+' : ''
    const range = price.high24h - price.low24h
    const rangePercent = price.priceUSD > 0 ? (range / price.priceUSD) * 100 : 0
    lines.push(`- ${sym}: $${price.priceUSD.toLocaleString(undefined, { maximumFractionDigits: 2 })} (24h: ${sign}${price.priceChange24hPct.toFixed(1)}%, range: ${rangePercent.toFixed(1)}%, vol: $${(price.volume24hUSD / 1e9).toFixed(2)}B)`)
  }

  if (lines.length === 0) return ''

  // Detect primary asset for this market
  const primarySymbol = detectCryptoSymbol(market.question)
  const primaryPrice = primarySymbol ? binanceWSService.getCachedPrice(primarySymbol) : null

  let volatilityNote = ''
  if (primaryPrice) {
    const range = primaryPrice.high24h - primaryPrice.low24h
    const rangePercent = primaryPrice.priceUSD > 0 ? (range / primaryPrice.priceUSD) * 100 : 0
    const regime = rangePercent < 3 ? 'low' : rangePercent < 8 ? 'medium' : 'high'
    volatilityNote = `\n- Volatility regime: ${regime} (${rangePercent.toFixed(1)}% 24h range)`
  }

  return '\nLIVE CRYPTO DATA:\n' + lines.join('\n') + volatilityNote
}
