/**
 * Structured Trade Logger (Backtest Framework Foundation)
 *
 * Logs every trade decision with full context for offline replay:
 * - Entry conditions (model probability, market price, Kelly output)
 * - Market state at decision time (order book depth, volume, spread)
 * - Execution result (fill price, slippage, gas cost)
 * - Exit conditions (SL/TP/trailing/time/manual)
 *
 * Data persists to IndexedDB for cross-session analysis.
 * Export to JSON for offline backtesting.
 */

export interface TradeRecord {
  id: string
  timestamp: number

  // Market context
  marketId: string
  conditionId: string
  question: string
  category?: string
  outcomes: string[]

  // Decision context
  strategy: 'llm' | 'dip' | 'fw' | 'btc' | 'micro'
  side: 'BUY' | 'SELL'
  outcome: string
  modelProbability?: number     // LLM confidence (0-1)
  calibratedProbability?: number // After calibration correction
  marketPrice: number           // Market price at decision time
  kellyFraction: number         // f* from Kelly
  kellyBetSize: number          // Dollar amount Kelly recommended
  actualBetSize: number         // Dollar amount actually bet (after caps)

  // Market microstructure at decision time
  bidAskSpread?: number
  orderBookDepthUSD?: number    // Liquidity within 2% slippage
  volume24h?: number
  bidAskImbalance?: number      // Positive = more bids (bullish)

  // Execution
  orderId?: string
  orderType: 'FOK' | 'GTD' | 'GTC'
  fillPrice?: number
  filledSize?: number
  slippage?: number             // Actual slippage vs intended price
  gasCostUSD?: number
  executionTimeMs?: number
  success: boolean
  error?: string

  // Exit (filled in later when position closes)
  exitTimestamp?: number
  exitPrice?: number
  exitReason?: 'stop-loss' | 'take-profit' | 'trailing-stop' | 'time-exit' | 'manual' | 'emergency' | 'merge'
  pnlUSD?: number
  pnlPercent?: number
  holdTimeMs?: number

  // Arb-specific
  arbProfitRatio?: number       // For DipArb/FW: guaranteed profit ratio
  legCount?: number             // Number of legs in arb
  mergeSuccess?: boolean

  // Gas context
  gasPrice?: number             // gwei at execution time
}

export interface BacktestSummary {
  totalTrades: number
  wins: number
  losses: number
  winRate: number
  totalPnlUSD: number
  avgPnlPerTrade: number
  avgHoldTimeMs: number
  sharpeRatio: number | null
  maxDrawdownPercent: number
  byStrategy: Record<string, {
    trades: number
    winRate: number
    avgPnl: number
    totalPnl: number
  }>
}

export class TradeLogger {
  private records: TradeRecord[] = []
  private maxRecords = 5000

  /**
   * Log a new trade entry.
   * Returns the record ID for later updates (exit info).
   */
  logEntry(record: Omit<TradeRecord, 'id' | 'timestamp'>): string {
    const id = crypto.randomUUID()
    const entry: TradeRecord = {
      id,
      timestamp: Date.now(),
      ...record,
    }

    this.records.push(entry)

    // Trim old records
    if (this.records.length > this.maxRecords) {
      this.records = this.records.slice(-this.maxRecords)
    }

    // Persist to IndexedDB (fire-and-forget)
    this.persistRecord(entry)

    return id
  }

  /**
   * Update a trade record with exit information.
   * Called by PLM when a position closes.
   */
  logExit(recordId: string, exit: {
    exitPrice: number
    exitReason: TradeRecord['exitReason']
    pnlUSD: number
    pnlPercent: number
  }): void {
    const record = this.records.find(r => r.id === recordId)
    if (!record) return

    record.exitTimestamp = Date.now()
    record.exitPrice = exit.exitPrice
    record.exitReason = exit.exitReason
    record.pnlUSD = exit.pnlUSD
    record.pnlPercent = exit.pnlPercent
    record.holdTimeMs = record.exitTimestamp - record.timestamp

    this.persistRecord(record)
  }

  /**
   * Find a trade record by market and strategy for exit logging.
   */
  findOpenRecord(marketId: string, strategy: string, outcome: string): TradeRecord | undefined {
    return this.records.find(r =>
      r.marketId === marketId &&
      r.strategy === strategy &&
      r.outcome === outcome &&
      r.success &&
      !r.exitTimestamp
    )
  }

  /**
   * Compute backtest summary statistics.
   */
  getSummary(): BacktestSummary {
    const closed = this.records.filter(r => r.exitTimestamp != null)
    const wins = closed.filter(r => (r.pnlUSD ?? 0) > 0)
    const losses = closed.filter(r => (r.pnlUSD ?? 0) <= 0)

    const totalPnl = closed.reduce((sum, r) => sum + (r.pnlUSD ?? 0), 0)
    const avgPnl = closed.length > 0 ? totalPnl / closed.length : 0
    const avgHold = closed.length > 0
      ? closed.reduce((sum, r) => sum + (r.holdTimeMs ?? 0), 0) / closed.length
      : 0

    // Sharpe ratio (daily, annualized)
    let sharpe: number | null = null
    if (closed.length >= 10) {
      const pnls = closed.map(r => r.pnlUSD ?? 0)
      const mean = pnls.reduce((s, p) => s + p, 0) / pnls.length
      const variance = pnls.reduce((s, p) => s + (p - mean) ** 2, 0) / pnls.length
      const stddev = Math.sqrt(variance)
      if (stddev > 0) {
        sharpe = (mean / stddev) * Math.sqrt(252) // Annualized
      }
    }

    // Max drawdown
    let maxDrawdown = 0
    let peak = 0
    let cumPnl = 0
    for (const r of closed.sort((a, b) => a.timestamp - b.timestamp)) {
      cumPnl += r.pnlUSD ?? 0
      if (cumPnl > peak) peak = cumPnl
      const dd = peak > 0 ? (peak - cumPnl) / peak : 0
      if (dd > maxDrawdown) maxDrawdown = dd
    }

    // By strategy breakdown
    const byStrategy: BacktestSummary['byStrategy'] = {}
    for (const strat of ['llm', 'dip', 'fw'] as const) {
      const stratRecords = closed.filter(r => r.strategy === strat)
      const stratWins = stratRecords.filter(r => (r.pnlUSD ?? 0) > 0)
      const stratPnl = stratRecords.reduce((s, r) => s + (r.pnlUSD ?? 0), 0)
      byStrategy[strat] = {
        trades: stratRecords.length,
        winRate: stratRecords.length > 0 ? stratWins.length / stratRecords.length : 0,
        avgPnl: stratRecords.length > 0 ? stratPnl / stratRecords.length : 0,
        totalPnl: stratPnl,
      }
    }

    return {
      totalTrades: closed.length,
      wins: wins.length,
      losses: losses.length,
      winRate: closed.length > 0 ? wins.length / closed.length : 0,
      totalPnlUSD: totalPnl,
      avgPnlPerTrade: avgPnl,
      avgHoldTimeMs: avgHold,
      sharpeRatio: sharpe,
      maxDrawdownPercent: maxDrawdown,
      byStrategy,
    }
  }

  /**
   * Get all records (for export / UI display).
   */
  getRecords(limit?: number): TradeRecord[] {
    const sorted = [...this.records].sort((a, b) => b.timestamp - a.timestamp)
    return limit ? sorted.slice(0, limit) : sorted
  }

  /**
   * Export all records as JSON string (for offline backtesting).
   */
  exportJSON(): string {
    return JSON.stringify(this.records, null, 2)
  }

  /**
   * Load records from IndexedDB on startup.
   */
  async hydrate(): Promise<void> {
    try {
      const { indexedDBService } = await import('@/services/storage')
      const stored = await indexedDBService.loadTradeRecords?.() ?? []
      if (stored.length > 0) {
        // Merge: keep existing in-memory records, add stored ones
        const existingIds = new Set(this.records.map(r => r.id))
        const newFromStorage = stored.filter((r: TradeRecord) => !existingIds.has(r.id))
        this.records = [...this.records, ...newFromStorage].slice(-this.maxRecords)
        console.log(`[TradeLogger] Hydrated ${newFromStorage.length} trade records from storage`)
      }
    } catch {
      // Storage not available — that's fine, we're append-only
    }
  }

  private persistRecord(record: TradeRecord): void {
    import('@/services/storage').then(({ indexedDBService }) => {
      indexedDBService.storeTradeRecord?.(record)
    }).catch(() => {})
  }
}

// Export singleton
export const tradeLogger = new TradeLogger()
