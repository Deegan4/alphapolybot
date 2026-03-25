/**
 * WeatherMarketAdapter — Scanner for Polymarket weather/temperature markets.
 *
 * NOT a BaseStrategy subclass — it's a market discovery adapter that feeds
 * weather markets to existing strategies (Gabagool, DualSide, etc.).
 *
 * Weather markets are attractive because:
 * - Fewer competing bots (most focus on crypto/politics)
 * - Local forecast data provides real informational edge
 * - Slower information flow = more time for maker fills
 * - After March 30 2026, weather fees are ~1.00% max (lower than crypto's 1.56%)
 *
 * Integration with GabagoolStrategy:
 *   In runScanCycle(), after scanning BTC markets, also scan:
 *     weatherMarketAdapter.getActiveMarkets()
 *   Weather markets use the same accumulation logic — buy cheap YES+NO, merge.
 *   Key difference: less liquid, use smaller order sizes and wider spreads.
 *
 * Integration with DualSideHedgeStrategy:
 *   Weather binary markets work identically to crypto for dual-side hedge.
 *   Pass the weather market's clobTokenIds to the same order flow.
 *
 * Settings needed (add to settingsStore):
 *   weatherScanEnabled: boolean (default false)
 *   weatherMinLiquidity: number (default 500)
 *   weatherScanIntervalMs: number (default 60000)
 *   weatherLocations: string[] (default ['NYC', 'LAX', 'CHI'])
 */

import type { Market } from '@/types'
import { activityLogger } from '@/services/trading/ActivityLogger'
import { useSettingsStore } from '@/stores/settingsStore'

// ==========================================
// TYPES
// ==========================================

export interface WeatherMarket extends Market {
  weatherType: 'temperature' | 'precipitation' | 'wind' | 'other'
  location?: string
  targetDate?: string
  forecastProb?: number  // NWS-derived fair probability estimate
}

interface WeatherForecast {
  location: string
  date: string
  tempHigh: number
  tempLow: number
  precipChance: number
}

type WeatherEventHandler = (event: string, data: unknown) => void

// NWS grid points for common cities (office/gridX,gridY)
const NWS_GRID_POINTS: Record<string, { office: string; gridX: number; gridY: number }> = {
  NYC: { office: 'OKX', gridX: 33, gridY: 37 },
  LAX: { office: 'LOX', gridX: 154, gridY: 44 },
  CHI: { office: 'LOT', gridX: 76, gridY: 73 },
  MIA: { office: 'MFL', gridX: 110, gridY: 50 },
  DEN: { office: 'BOU', gridX: 62, gridY: 60 },
  SEA: { office: 'SEW', gridX: 124, gridY: 67 },
}

// ==========================================
// ADAPTER
// ==========================================

export class WeatherMarketAdapter {
  private activeMarkets = new Map<string, WeatherMarket>()
  private scanInterval: ReturnType<typeof setInterval> | null = null
  private scanning = false
  private eventHandlers = new Map<string, Set<WeatherEventHandler>>()
  private forecastCache = new Map<string, { data: WeatherForecast[]; fetchedAt: number }>()
  private static readonly FORECAST_CACHE_TTL = 30 * 60 * 1000 // 30 min

  // ==========================================
  // CONFIG
  // ==========================================

  private get config() {
    const s = useSettingsStore.getState()
    // Fields may not exist in settingsStore yet — use safe defaults
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sa = s as any
    return {
      enabled: sa.weatherScanEnabled ?? false,
      minLiquidity: sa.weatherMinLiquidity ?? 500,
      scanIntervalMs: sa.weatherScanIntervalMs ?? 60_000,
      locations: sa.weatherLocations ?? ['NYC', 'LAX', 'CHI'],
    }
  }

  // ==========================================
  // LIFECYCLE
  // ==========================================

  start(): void {
    if (!this.config.enabled) {
      console.log('[Weather] Adapter disabled in settings')
      return
    }

    console.log(`[Weather] Starting scanner — locations: ${this.config.locations.join(', ')}`)
    activityLogger.logSystem('Weather market scanner started')

    // Initial scan
    this.scan()

    // Schedule recurring scans (weather markets move slowly)
    this.scanInterval = setInterval(() => this.scan(), this.config.scanIntervalMs)
  }

  stop(): void {
    if (this.scanInterval) {
      clearInterval(this.scanInterval)
      this.scanInterval = null
    }
    this.activeMarkets.clear()
    console.log('[Weather] Scanner stopped')
  }

  // ==========================================
  // MARKET SCANNING
  // ==========================================

  private async scan(): Promise<void> {
    if (this.scanning) return
    this.scanning = true

    try {
      const markets = await this.fetchWeatherMarkets()

      // Filter by liquidity
      const viable = markets.filter(m => m.liquidity >= this.config.minLiquidity)

      // Enrich with forecast probabilities
      for (const market of viable) {
        await this.enrichWithForecast(market)
      }

      // Update active markets
      const previousIds = new Set(this.activeMarkets.keys())
      this.activeMarkets.clear()

      for (const market of viable) {
        this.activeMarkets.set(market.id, market)

        if (!previousIds.has(market.id)) {
          this.emit('marketFound', market)
          console.log(`[Weather] New market: ${market.question} (liq: $${market.liquidity.toFixed(0)})`)
        }
      }

      if (viable.length > 0) {
        this.emit('scanComplete', { count: viable.length, markets: viable })
      }
    } catch (err) {
      console.warn('[Weather] Scan failed:', err instanceof Error ? err.message : err)
    } finally {
      this.scanning = false
    }
  }

  private async fetchWeatherMarkets(): Promise<WeatherMarket[]> {
    try {
      const { gammaClient } = await import('@/services/api')

      // Gamma API: fetch weather category markets
      const response = await gammaClient.get('/markets', {
        params: {
          active: true,
          closed: false,
          tag: 'weather',
          limit: 50,
        },
      })

      if (!response?.data) return []

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (response.data as any[]).map((m: any) => ({
        ...m,
        outcomePrices: m.outcomePrices?.map(Number) ?? [],
        volume: Number(m.volume ?? 0),
        liquidity: Number(m.liquidity ?? 0),
        weatherType: this.classifyWeatherType(m.question ?? '', m.tags ?? []),
        location: this.extractLocation(m.question ?? ''),
        targetDate: this.extractDate(m.question ?? ''),
      }))
    } catch (err) {
      console.warn('[Weather] Fetch failed:', err instanceof Error ? err.message : err)
      return []
    }
  }

  // ==========================================
  // FORECAST ENRICHMENT
  // ==========================================

  private async enrichWithForecast(market: WeatherMarket): Promise<void> {
    if (market.weatherType !== 'temperature' || !market.location) return

    const forecasts = await this.getForecasts(market.location)
    if (!forecasts.length) return

    // Try to match forecast to market's target date
    const targetDate = market.targetDate
    if (!targetDate) return

    const match = forecasts.find(f => f.date === targetDate)
    if (!match) return

    // Parse threshold from question (e.g., "exceed 75°F")
    const thresholdMatch = market.question?.match(/(\d+)\s*°?F/i)
    if (!thresholdMatch) return

    const threshold = parseInt(thresholdMatch[1], 10)
    const question = market.question?.toLowerCase() ?? ''

    // Estimate probability from forecast
    if (question.includes('exceed') || question.includes('above') || question.includes('over')) {
      // P(high > threshold) — rough estimate using forecast high
      const diff = match.tempHigh - threshold
      // Simple logistic approximation: P = 1 / (1 + e^(-diff/3))
      market.forecastProb = 1 / (1 + Math.exp(-diff / 3))
    } else if (question.includes('below') || question.includes('under')) {
      const diff = threshold - match.tempLow
      market.forecastProb = 1 / (1 + Math.exp(-diff / 3))
    }
  }

  private async getForecasts(location: string): Promise<WeatherForecast[]> {
    const cached = this.forecastCache.get(location)
    if (cached && Date.now() - cached.fetchedAt < WeatherMarketAdapter.FORECAST_CACHE_TTL) {
      return cached.data
    }

    const grid = NWS_GRID_POINTS[location.toUpperCase()]
    if (!grid) return []

    try {
      const url = `https://api.weather.gov/gridpoints/${grid.office}/${grid.gridX},${grid.gridY}/forecast`
      const response = await fetch(url, {
        headers: { 'User-Agent': 'AlphaPolyBot/1.0 (weather-adapter)' },
      })

      if (!response.ok) return []

      const data = await response.json()
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const periods = data?.properties?.periods ?? [] as any[]

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const forecasts: WeatherForecast[] = periods.map((p: any) => ({
        location,
        date: p.startTime?.split('T')[0] ?? '',
        tempHigh: p.isDaytime ? p.temperature : 0,
        tempLow: !p.isDaytime ? p.temperature : 0,
        precipChance: p.probabilityOfPrecipitation?.value ?? 0,
      }))

      this.forecastCache.set(location, { data: forecasts, fetchedAt: Date.now() })
      return forecasts
    } catch {
      return []
    }
  }

  // ==========================================
  // CLASSIFICATION HELPERS
  // ==========================================

  private classifyWeatherType(question: string, tags: string[]): WeatherMarket['weatherType'] {
    const q = question.toLowerCase()
    const t = tags.map(x => x.toLowerCase())

    if (q.includes('temperature') || q.includes('°f') || q.includes('°c') || t.includes('temperature')) return 'temperature'
    if (q.includes('rain') || q.includes('precipitation') || q.includes('snow') || t.includes('precipitation')) return 'precipitation'
    if (q.includes('wind') || q.includes('mph') || t.includes('wind')) return 'wind'
    return 'other'
  }

  private extractLocation(question: string): string | undefined {
    // Common city patterns in weather market questions
    const patterns = [
      /\b(NYC|New York|Manhattan)\b/i,
      /\b(LA|Los Angeles|LAX)\b/i,
      /\b(Chicago|CHI)\b/i,
      /\b(Miami|MIA)\b/i,
      /\b(Denver|DEN)\b/i,
      /\b(Seattle|SEA)\b/i,
    ]
    const nameMap: Record<string, string> = {
      'nyc': 'NYC', 'new york': 'NYC', 'manhattan': 'NYC',
      'la': 'LAX', 'los angeles': 'LAX', 'lax': 'LAX',
      'chicago': 'CHI', 'chi': 'CHI',
      'miami': 'MIA', 'mia': 'MIA',
      'denver': 'DEN', 'den': 'DEN',
      'seattle': 'SEA', 'sea': 'SEA',
    }

    for (const pattern of patterns) {
      const match = question.match(pattern)
      if (match) return nameMap[match[1].toLowerCase()] ?? match[1]
    }
    return undefined
  }

  private extractDate(question: string): string | undefined {
    // Match patterns like "March 28", "Mar 28", "2026-03-28"
    const isoMatch = question.match(/(\d{4}-\d{2}-\d{2})/)
    if (isoMatch) return isoMatch[1]

    const monthMatch = question.match(/\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\w*\s+(\d{1,2})\b/i)
    if (monthMatch) {
      const months: Record<string, string> = {
        jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
        jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12',
      }
      const month = months[monthMatch[1].toLowerCase().slice(0, 3)]
      const day = monthMatch[2].padStart(2, '0')
      return `2026-${month}-${day}`
    }
    return undefined
  }

  // ==========================================
  // PUBLIC API
  // ==========================================

  getActiveMarkets(): WeatherMarket[] {
    return [...this.activeMarkets.values()]
  }

  getMarketsByType(type: WeatherMarket['weatherType']): WeatherMarket[] {
    return this.getActiveMarkets().filter(m => m.weatherType === type)
  }

  getMarketsWithEdge(minEdge = 0.05): WeatherMarket[] {
    return this.getActiveMarkets().filter(m => {
      if (!m.forecastProb || !m.outcomePrices?.length) return false
      const marketProb = m.outcomePrices[0]
      return Math.abs(m.forecastProb - marketProb) >= minEdge
    })
  }

  // ==========================================
  // EVENTS
  // ==========================================

  on(event: string, handler: WeatherEventHandler): () => void {
    if (!this.eventHandlers.has(event)) {
      this.eventHandlers.set(event, new Set())
    }
    this.eventHandlers.get(event)!.add(handler)
    return () => this.eventHandlers.get(event)?.delete(handler)
  }

  private emit(event: string, data: unknown): void {
    for (const handler of this.eventHandlers.get(event) ?? []) {
      try { handler(event, data) } catch { /* ignore */ }
    }
  }
}

// ==========================================
// SINGLETON EXPORT
// ==========================================

export const weatherMarketAdapter = new WeatherMarketAdapter()
