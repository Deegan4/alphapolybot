import { useEffect, useState, useMemo } from 'react'
import { tradeLogger } from '@/services/trading'
import type { TradeRecord } from '@/services/trading/TradeLogger'

export interface EquityPoint {
  date: string
  equity: number
}

export interface StrategyLine {
  date: string
  [strategy: string]: string | number
}

export interface WinRatePoint {
  trade: number
  winRate: number
}

export interface HourPnl {
  hour: string
  pnl: number
}

export interface DayFrequency {
  day: string
  count: number
}

export interface TradeAnalytics {
  equityCurve: EquityPoint[]
  strategyComparison: StrategyLine[]
  winRateTrend: WinRatePoint[]
  pnlByHour: HourPnl[]
  tradesByDay: DayFrequency[]
  totalTrades: number
}

const STRAT_LABELS: Record<string, string> = {
  llm: 'LLM', dip: 'DIP', fw: 'FW', btc: 'BTC', micro: 'MICRO', mr: 'MR', copy: 'COPY',
}

function formatDay(ts: number): string {
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

function computeAnalytics(records: TradeRecord[]): TradeAnalytics {
  const closed = records
    .filter(r => r.exitTimestamp != null)
    .sort((a, b) => (a.exitTimestamp ?? 0) - (b.exitTimestamp ?? 0))

  // Equity curve — cumulative P&L grouped by day
  const equityByDay = new Map<string, number>()
  let cumPnl = 0
  for (const r of closed) {
    cumPnl += r.pnlUSD ?? 0
    const day = formatDay(r.exitTimestamp!)
    equityByDay.set(day, cumPnl)
  }
  const equityCurve: EquityPoint[] = Array.from(equityByDay, ([date, equity]) => ({ date, equity }))

  // Strategy comparison — cumulative P&L per strategy per day
  const stratCumPnl = new Map<string, number>()
  const stratByDay = new Map<string, Record<string, number>>()
  for (const r of closed) {
    const day = formatDay(r.exitTimestamp!)
    const strat = r.strategy
    stratCumPnl.set(strat, (stratCumPnl.get(strat) ?? 0) + (r.pnlUSD ?? 0))
    if (!stratByDay.has(day)) stratByDay.set(day, {})
    const dayEntry = stratByDay.get(day)!
    for (const [s, v] of stratCumPnl) dayEntry[STRAT_LABELS[s] ?? s] = v
  }
  const strategyComparison: StrategyLine[] = Array.from(stratByDay, ([date, vals]) => ({ date, ...vals }))

  // Win rate trend — sliding 20-trade window
  const winRateTrend: WinRatePoint[] = []
  const windowSize = 20
  for (let i = windowSize - 1; i < closed.length; i++) {
    const window = closed.slice(i - windowSize + 1, i + 1)
    const wins = window.filter(r => (r.pnlUSD ?? 0) > 0).length
    winRateTrend.push({ trade: i + 1, winRate: Math.round((wins / windowSize) * 100) })
  }

  // P&L by hour of day
  const hourMap = new Map<number, number>()
  for (const r of closed) {
    const hour = new Date(r.exitTimestamp!).getHours()
    hourMap.set(hour, (hourMap.get(hour) ?? 0) + (r.pnlUSD ?? 0))
  }
  const pnlByHour: HourPnl[] = Array.from({ length: 24 }, (_, h) => ({
    hour: `${h.toString().padStart(2, '0')}:00`,
    pnl: Math.round((hourMap.get(h) ?? 0) * 100) / 100,
  }))

  // Trade frequency by day
  const dayCountMap = new Map<string, number>()
  for (const r of closed) {
    const day = formatDay(r.exitTimestamp!)
    dayCountMap.set(day, (dayCountMap.get(day) ?? 0) + 1)
  }
  const tradesByDay: DayFrequency[] = Array.from(dayCountMap, ([day, count]) => ({ day, count }))

  return {
    equityCurve,
    strategyComparison,
    winRateTrend,
    pnlByHour,
    tradesByDay,
    totalTrades: closed.length,
  }
}

export function useTradeAnalytics(): TradeAnalytics {
  const [records, setRecords] = useState<TradeRecord[]>([])

  useEffect(() => {
    const tick = () => setRecords(tradeLogger.getRecords(10000))
    tick()
    const id = setInterval(tick, 10_000)
    return () => clearInterval(id)
  }, [])

  return useMemo(() => computeAnalytics(records), [records])
}
