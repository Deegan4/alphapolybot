import React, { useState, useCallback } from 'react'
import { MatrixCard } from '@/components/ui'
import { MatrixLineChart } from '@/components/charts/MatrixLineChart'
import { MatrixBarChart } from '@/components/charts/MatrixBarChart'
import { useBacktestStore } from '@/stores/backtestStore'
import { useSettingsStore } from '@/stores'
import { ParameterSweepRunner } from '@/services/strategies/btcupdown/ParameterSweepRunner'
import type { SweepResult } from '@/services/strategies/btcupdown/ParameterSweepRunner'
import type { BacktestResult, BacktestStrategyType, StrategyBacktestResult } from '@/types'

// ==========================================
// MARKET TYPE OPTIONS
// ==========================================

const MARKET_TYPES = [
  { value: '5m' as const, label: '5m' },
  { value: '15m' as const, label: '15m' },
  { value: '1hr' as const, label: '1h' },
  { value: '4hr' as const, label: '4h' },
  { value: '24hr' as const, label: '24h' },
]

const STRATEGY_OPTIONS: Array<{ value: BacktestStrategyType; label: string; source: string }> = [
  { value: 'btc-updown', label: 'Crypto Up/Down', source: 'Gamma + CLOB + Binance (free)' },
  { value: 'dual-side', label: 'Dual-Side', source: 'Gamma + CLOB + Binance (free)' },
  { value: 'gabagool', label: 'Gabagool', source: 'Gamma + CLOB + Binance (free)' },
  { value: 'impulse-sniper', label: 'Impulse', source: 'Gamma + CLOB + Binance (free)' },
  { value: 'dip-arb', label: 'Dip Arb', source: 'Recorded snapshots' },
  { value: 'project-fw', label: 'ProjectFW', source: 'Recorded snapshots' },
  { value: 'llm-prediction', label: 'LLM', source: 'Baseline simulation' },
]

// ==========================================
// BACKTEST VIEW (thin renderer over backtestStore)
// ==========================================

export const BacktestView: React.FC = () => {
  const polyBacktestApiKey = useSettingsStore(s => s.polyBacktestApiKey)

  // All state from store — survives tab switches
  const mode = useBacktestStore(s => s.mode)
  const marketType = useBacktestStore(s => s.marketType)
  const slug = useBacktestStore(s => s.slug)
  const maxMarkets = useBacktestStore(s => s.maxMarkets)
  const minConfidence = useBacktestStore(s => s.minConfidence)
  const maxEntryPrice = useBacktestStore(s => s.maxEntryPrice)
  const regimeFilter = useBacktestStore(s => s.regimeFilter)
  const rsiFilter = useBacktestStore(s => s.rsiFilter)
  const status = useBacktestStore(s => s.status)
  const progress = useBacktestStore(s => s.progress)
  const progressLabel = useBacktestStore(s => s.progressLabel)
  const error = useBacktestStore(s => s.error)
  const results = useBacktestStore(s => s.results)
  const aggregated = useBacktestStore(s => s.aggregated)

  const {
    setMode, setMarketType, setSlug, setMaxMarkets,
    setMinConfidence, setMaxEntryPrice, setRegimeFilter, setRsiFilter,
    runBacktest, stopBacktest,
  } = useBacktestStore.getState()

  // ── Multi-strategy state (in store — survives tab switches) ──
  const multiMode = useBacktestStore(s => s.multiMode)
  const multiStatus = useBacktestStore(s => s.multiStatus)
  const multiProgress = useBacktestStore(s => s.multiProgress)
  const multiError = useBacktestStore(s => s.multiError)
  const multiResults = useBacktestStore(s => s.multiResults)
  const selectedStrategies = useBacktestStore(s => s.selectedStrategies)

  // ── Sweep state (in store — survives tab switches) ──
  const sweepActive = useBacktestStore(s => s.sweepActive)
  const sweepGrid = useBacktestStore(s => s.sweepGrid)
  const sweepResults = useBacktestStore(s => s.sweepResults)
  const sweepStatus = useBacktestStore(s => s.sweepStatus)
  const sweepProgress = useBacktestStore(s => s.sweepProgress)
  const sweepError = useBacktestStore(s => s.sweepError)

  const {
    setMultiMode, toggleStrategy, runMultiBacktest, stopMultiBacktest,
    setSweepActive, setSweepGrid, runSweep, stopSweep,
  } = useBacktestStore.getState()

  const handleRun = useCallback(() => {
    runBacktest(polyBacktestApiKey)
  }, [polyBacktestApiKey, runBacktest])

  const handleMultiRun = useCallback(() => {
    runMultiBacktest(polyBacktestApiKey)
  }, [polyBacktestApiKey, runMultiBacktest])

  const handleMultiStop = stopMultiBacktest

  const handleSweepRun = useCallback(() => {
    runSweep(polyBacktestApiKey)
  }, [polyBacktestApiKey, runSweep])

  const handleSweepStop = stopSweep

  const isRunning = status === 'running'
  const hasResults = !!aggregated

  return (
    <div className="flex-1 flex flex-col gap-3 p-4 min-h-0 overflow-y-auto">

      {/* ── MODE TOGGLE: Single Strategy vs Multi-Strategy ── */}
      <div className="flex items-center gap-2">
        <div className="flex rounded overflow-hidden border border-agent-border/50">
          <button onClick={() => setMultiMode(false)}
            className={`px-4 py-1.5 text-[11px] font-mono font-bold uppercase tracking-wider transition-colors border-r border-agent-border/50 ${
              !multiMode ? 'bg-agent-green/20 text-agent-green' : 'text-agent-text-muted hover:text-agent-text'
            }`}>BTC Signal</button>
          <button onClick={() => setMultiMode(true)}
            className={`px-4 py-1.5 text-[11px] font-mono font-bold uppercase tracking-wider transition-colors ${
              multiMode ? 'bg-agent-cyan/20 text-agent-cyan' : 'text-agent-text-muted hover:text-agent-text'
            }`}>All Strategies</button>
        </div>
        {multiMode && (
          <span className="text-[10px] text-agent-text-muted/50 font-sans">
            Run backtests across multiple strategies simultaneously
          </span>
        )}
      </div>

      {/* ── MULTI-STRATEGY PANEL ── */}
      {multiMode && (
        <>
          <MatrixCard title="MULTI-STRATEGY BACKTEST" subtitle="Select strategies to backtest" variant="glass">
            <div className="space-y-4">
              {/* Strategy selector */}
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-[10px] text-agent-text-muted/60 font-sans uppercase tracking-wider mr-1">Strategies</span>
                {STRATEGY_OPTIONS.map(s => (
                  <button key={s.value} onClick={() => toggleStrategy(s.value)}
                    className={`px-2.5 py-1 rounded text-[10px] font-mono font-bold uppercase tracking-wider border transition-colors ${
                      selectedStrategies.has(s.value)
                        ? 'bg-agent-cyan/15 text-agent-cyan border-agent-cyan/30'
                        : 'text-agent-text-muted/50 border-agent-border/30 hover:text-agent-text-muted hover:border-agent-border/50'
                    }`}
                    title={s.source}
                  >{s.label}</button>
                ))}
              </div>

              {/* Market type + limit + run */}
              <div className="flex items-end gap-3 flex-wrap">
                <div className="flex rounded overflow-hidden border border-agent-border/50">
                  {MARKET_TYPES.map(t => (
                    <button key={t.value} onClick={() => setMarketType(t.value)}
                      className={`px-2.5 py-1.5 text-[11px] font-mono font-bold transition-colors border-r border-agent-border/50 last:border-r-0 ${
                        marketType === t.value ? 'bg-agent-cyan/15 text-agent-cyan' : 'text-agent-text-muted hover:text-agent-text'
                      }`}>{t.label}</button>
                  ))}
                </div>
                <div className="flex items-center gap-1.5">
                  <span className="text-[10px] text-agent-text-muted font-sans uppercase">Limit</span>
                  <input type="number" min={1} max={200} value={maxMarkets}
                    onChange={e => setMaxMarkets(Math.max(1, Math.min(200, Number(e.target.value) || 20)))}
                    className="w-16 bg-agent-bg/60 border border-agent-border/40 rounded px-2 py-1 text-xs font-mono text-agent-text focus:border-agent-cyan/50 outline-none tabular-nums"
                  />
                </div>
                <div className="flex-1" />
                {multiStatus === 'running' ? (
                  <button onClick={handleMultiStop}
                    className="px-5 py-1.5 rounded text-xs font-mono font-bold uppercase tracking-wider bg-red-500/10 text-red-400 border border-red-500/25 hover:bg-red-500/20 transition-colors"
                  >■ Stop</button>
                ) : (
                  <button onClick={handleMultiRun} disabled={selectedStrategies.size === 0}
                    className="px-5 py-1.5 rounded text-xs font-mono font-bold uppercase tracking-wider bg-agent-cyan/10 text-agent-cyan border border-agent-cyan/25 hover:bg-agent-cyan/20 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
                  >▶ Run All</button>
                )}
              </div>

              {/* Progress */}
              {multiStatus === 'running' && (
                <div className="flex items-center gap-3">
                  <div className="flex-1 h-1 bg-agent-border/20 rounded-full overflow-hidden">
                    <div className="h-full bg-agent-cyan/70 rounded-full animate-pulse" style={{ width: '50%' }} />
                  </div>
                  <span className="text-[10px] font-mono text-agent-text-muted tabular-nums whitespace-nowrap">{multiProgress}</span>
                </div>
              )}

              {multiStatus === 'error' && (
                <div className="flex items-start gap-2 bg-red-500/5 border border-red-500/15 rounded px-3 py-2">
                  <span className="text-red-400 text-xs">✗</span>
                  <span className="text-[11px] font-mono text-red-400/80 break-all">{multiError}</span>
                </div>
              )}

              <div className="text-[9px] text-agent-text-muted/40 font-sans">
                BTC strategies use free APIs (Gamma + CLOB + Binance). DipArb/ProjectFW need recorded snapshots.
              </div>
            </div>
          </MatrixCard>

          {/* Multi-strategy results */}
          {multiResults && (
            <>
              {/* Combined summary */}
              <div className="grid grid-cols-4 lg:grid-cols-8 gap-1.5">
                <StatCell label="Strategies" value={multiResults.strategies.length.toString()} />
                <StatCell label="Trades" value={multiResults.combined.totalTrades.toString()} />
                <StatCell label="Win Rate"
                  value={`${(multiResults.combined.winRate * 100).toFixed(1)}%`}
                  color={multiResults.combined.winRate >= 0.5 ? 'green' : 'red'} />
                <StatCell label="Total P&L"
                  value={`${multiResults.combined.totalPnl >= 0 ? '+' : ''}$${multiResults.combined.totalPnl.toFixed(2)}`}
                  color={multiResults.combined.totalPnl >= 0 ? 'green' : 'red'} />
                <StatCell label="Avg P&L"
                  value={`${multiResults.combined.avgPnl >= 0 ? '+' : ''}$${multiResults.combined.avgPnl.toFixed(3)}`}
                  color={multiResults.combined.avgPnl >= 0 ? 'green' : 'red'} />
                <StatCell label="Max DD"
                  value={`$${multiResults.combined.maxDrawdown.toFixed(2)}`} color="orange" />
                <StatCell label="Sharpe"
                  value={multiResults.combined.sharpeRatio != null ? multiResults.combined.sharpeRatio.toFixed(2) : '—'} />
                <StatCell label="Profit Factor"
                  value={multiResults.combined.profitFactor != null ? multiResults.combined.profitFactor.toFixed(2) : '—'} />
              </div>

              {/* Per-strategy breakdown */}
              <MatrixCard title="PER-STRATEGY BREAKDOWN" subtitle="Individual strategy performance" variant="default">
                <div className="overflow-x-auto -mx-3">
                  <table className="w-full text-xs font-mono border-collapse">
                    <thead>
                      <tr className="border-b border-agent-border/30">
                        <th className="py-2 px-3 font-sans font-semibold text-agent-text-muted/70 text-[10px] uppercase tracking-wider text-left">Strategy</th>
                        <th className="py-2 px-3 font-sans font-semibold text-agent-text-muted/70 text-[10px] uppercase tracking-wider text-right">Trades</th>
                        <th className="py-2 px-3 font-sans font-semibold text-agent-text-muted/70 text-[10px] uppercase tracking-wider text-right">Win%</th>
                        <th className="py-2 px-3 font-sans font-semibold text-agent-text-muted/70 text-[10px] uppercase tracking-wider text-right">P&L</th>
                        <th className="py-2 px-3 font-sans font-semibold text-agent-text-muted/70 text-[10px] uppercase tracking-wider text-right">Avg P&L</th>
                        <th className="py-2 px-3 font-sans font-semibold text-agent-text-muted/70 text-[10px] uppercase tracking-wider text-right">Max DD</th>
                        <th className="py-2 px-3 font-sans font-semibold text-agent-text-muted/70 text-[10px] uppercase tracking-wider text-right">Sharpe</th>
                        <th className="py-2 px-3 font-sans font-semibold text-agent-text-muted/70 text-[10px] uppercase tracking-wider text-right">PF</th>
                        <th className="py-2 px-3 font-sans font-semibold text-agent-text-muted/70 text-[10px] uppercase tracking-wider text-center">Source</th>
                      </tr>
                    </thead>
                    <tbody>
                      {multiResults.strategies.map((s, i) => (
                        <tr key={s.strategy} className={`border-b border-agent-border/5 ${i % 2 ? 'bg-agent-card/30' : ''}`}>
                          <td className="py-1.5 px-3 text-agent-text font-bold">{s.strategyName}</td>
                          <td className="py-1.5 px-3 text-right tabular-nums text-agent-text-muted">{s.summary.totalTrades}</td>
                          <td className={`py-1.5 px-3 text-right tabular-nums ${s.summary.winRate >= 0.5 ? 'text-agent-green' : 'text-agent-red'}`}>
                            {(s.summary.winRate * 100).toFixed(1)}%
                          </td>
                          <td className={`py-1.5 px-3 text-right tabular-nums font-bold ${s.summary.totalPnl >= 0 ? 'text-agent-green' : 'text-agent-red'}`}>
                            {s.summary.totalPnl >= 0 ? '+' : ''}${s.summary.totalPnl.toFixed(2)}
                          </td>
                          <td className={`py-1.5 px-3 text-right tabular-nums ${s.summary.avgPnl >= 0 ? 'text-agent-green/70' : 'text-agent-red/70'}`}>
                            {s.summary.avgPnl >= 0 ? '+' : ''}${s.summary.avgPnl.toFixed(3)}
                          </td>
                          <td className="py-1.5 px-3 text-right tabular-nums text-orange-400">${s.summary.maxDrawdown.toFixed(2)}</td>
                          <td className="py-1.5 px-3 text-right tabular-nums text-agent-text-muted">
                            {s.summary.sharpeRatio?.toFixed(2) ?? '—'}
                          </td>
                          <td className="py-1.5 px-3 text-right tabular-nums text-agent-text-muted">
                            {s.summary.profitFactor?.toFixed(2) ?? '—'}
                          </td>
                          <td className="py-1.5 px-3 text-center">
                            <span className={`text-[9px] px-1.5 py-0.5 rounded-full ${
                              s.dataSource === 'polybacktest' ? 'bg-agent-green/10 text-agent-green/60' :
                              s.dataSource === 'snapshot-recorder' ? 'bg-agent-cyan/10 text-agent-cyan/60' :
                              'bg-orange-400/10 text-orange-400/60'
                            }`}>{s.dataSource}</span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </MatrixCard>

              {/* Correlation matrix */}
              {Object.keys(multiResults.correlationMatrix).length > 1 && (
                <MatrixCard title="STRATEGY CORRELATION" subtitle="P&L correlation between strategies" variant="default">
                  <div className="overflow-x-auto -mx-3">
                    <table className="text-[10px] font-mono border-collapse">
                      <thead>
                        <tr>
                          <th className="py-1 px-2" />
                          {Object.keys(multiResults.correlationMatrix).map(k => (
                            <th key={k} className="py-1 px-2 text-agent-text-muted/60 font-normal whitespace-nowrap">
                              {k.split('-').map(w => w[0]?.toUpperCase()).join('')}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {Object.entries(multiResults.correlationMatrix).map(([row, cols]) => (
                          <tr key={row}>
                            <td className="py-1 px-2 text-agent-text-muted/60 whitespace-nowrap">{row}</td>
                            {Object.entries(cols).map(([col, val]) => {
                              const abs = Math.abs(val)
                              const bg = row === col ? 'bg-agent-text/5'
                                : val > 0.3 ? 'bg-agent-green/10' : val < -0.3 ? 'bg-agent-red/10' : ''
                              return (
                                <td key={col} className={`py-1 px-2 text-center tabular-nums ${bg} ${
                                  abs > 0.5 ? 'text-agent-text font-bold' : 'text-agent-text-muted/60'
                                }`}>
                                  {val.toFixed(2)}
                                </td>
                              )
                            })}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </MatrixCard>
              )}

              {/* Multi-strategy equity curve */}
              <MultiEquityCurve strategies={multiResults.strategies} />
            </>
          )}

          {/* Multi empty state */}
          {multiStatus === 'idle' && !multiResults && (
            <div className="flex-1 flex items-center justify-center opacity-40">
              <div className="text-center space-y-1">
                <div className="text-2xl font-mono">⟐</div>
                <p className="text-xs font-sans text-agent-text-muted">
                  Select strategies and click Run All to backtest across all 7 strategies
                </p>
              </div>
            </div>
          )}
        </>
      )}

      {/* ── SINGLE STRATEGY CONTROL PANEL (existing BTC backtest) ── */}
      {!multiMode && (<>
      <MatrixCard title="CRYPTO UP/DOWN BACKTEST" subtitle="Replay signal logic against historical snapshots" variant="glass">
        <div className="space-y-4">

          {/* Row 1: Mode + Target + Action */}
          <div className="flex items-end gap-3 flex-wrap">
            {/* Mode pills */}
            <div className="flex rounded overflow-hidden border border-agent-border/50">
              {(['batch', 'single', 'sweep'] as const).map(m => (
                <button key={m} onClick={() => { if (m === 'sweep') setSweepActive(true); else setSweepActive(false); setMode(m === 'sweep' ? 'batch' : m) }}
                  className={`px-3 py-1.5 text-[11px] font-mono font-bold uppercase tracking-wider transition-colors ${
                    (m === 'sweep' ? sweepActive : !sweepActive && mode === m)
                      ? 'bg-agent-green/20 text-agent-green border-r border-agent-border/50'
                      : 'text-agent-text-muted hover:text-agent-text border-r border-agent-border/50 last:border-r-0'
                  }`}
                >{m}</button>
              ))}
            </div>

            {/* Target selector (hidden in sweep mode — sweep always uses batch) */}
            {sweepActive ? (
              <>
                <div className="flex rounded overflow-hidden border border-agent-border/50">
                  {MARKET_TYPES.map(t => (
                    <button key={t.value} onClick={() => setMarketType(t.value)}
                      className={`px-2.5 py-1.5 text-[11px] font-mono font-bold transition-colors border-r border-agent-border/50 last:border-r-0 ${
                        marketType === t.value
                          ? 'bg-agent-cyan/15 text-agent-cyan'
                          : 'text-agent-text-muted hover:text-agent-text'
                      }`}
                    >{t.label}</button>
                  ))}
                </div>
                <div className="flex items-center gap-1.5">
                  <span className="text-[10px] text-agent-text-muted font-sans uppercase">Limit</span>
                  <input type="number" min={1} max={500} value={maxMarkets}
                    onChange={e => setMaxMarkets(Math.max(1, Math.min(500, Number(e.target.value) || 50)))}
                    className="w-16 bg-agent-bg/60 border border-agent-border/40 rounded px-2 py-1 text-xs font-mono text-agent-text focus:border-agent-green/50 outline-none tabular-nums"
                  />
                </div>
                <div className="flex-1" />
                {sweepStatus === 'running' ? (
                  <button onClick={handleSweepStop}
                    className="px-5 py-1.5 rounded text-xs font-mono font-bold uppercase tracking-wider bg-red-500/10 text-red-400 border border-red-500/25 hover:bg-red-500/20 transition-colors"
                  >■ Stop</button>
                ) : (
                  <button onClick={handleSweepRun}
                    className="px-5 py-1.5 rounded text-xs font-mono font-bold uppercase tracking-wider bg-agent-cyan/10 text-agent-cyan border border-agent-cyan/25 hover:bg-agent-cyan/20 transition-colors"
                  >▶ Sweep</button>
                )}
              </>
            ) : mode === 'batch' ? (
              <>
                <div className="flex rounded overflow-hidden border border-agent-border/50">
                  {MARKET_TYPES.map(t => (
                    <button key={t.value} onClick={() => setMarketType(t.value)}
                      className={`px-2.5 py-1.5 text-[11px] font-mono font-bold transition-colors border-r border-agent-border/50 last:border-r-0 ${
                        marketType === t.value
                          ? 'bg-agent-cyan/15 text-agent-cyan'
                          : 'text-agent-text-muted hover:text-agent-text'
                      }`}
                    >{t.label}</button>
                  ))}
                </div>
                <div className="flex items-center gap-1.5">
                  <span className="text-[10px] text-agent-text-muted font-sans uppercase">Limit</span>
                  <input type="number" min={1} max={500} value={maxMarkets}
                    onChange={e => setMaxMarkets(Math.max(1, Math.min(500, Number(e.target.value) || 50)))}
                    className="w-16 bg-agent-bg/60 border border-agent-border/40 rounded px-2 py-1 text-xs font-mono text-agent-text focus:border-agent-green/50 outline-none tabular-nums"
                  />
                </div>
              </>
            ) : (
              <input value={slug} onChange={e => setSlug(e.target.value)}
                placeholder="market slug or 0x condition ID..."
                className="flex-1 min-w-[200px] max-w-md bg-agent-bg/60 border border-agent-border/40 rounded px-3 py-1.5 text-xs font-mono text-agent-text placeholder:text-agent-text-muted/30 focus:border-agent-green/50 outline-none"
              />
            )}

            {/* Spacer */}
            <div className="flex-1" />

            {/* Action button */}
            {isRunning ? (
              <button onClick={stopBacktest}
                className="px-5 py-1.5 rounded text-xs font-mono font-bold uppercase tracking-wider bg-red-500/10 text-red-400 border border-red-500/25 hover:bg-red-500/20 transition-colors"
              >■ Stop</button>
            ) : (
              <button onClick={handleRun}
                disabled={mode === 'single' && !slug.trim()}
                className="px-5 py-1.5 rounded text-xs font-mono font-bold uppercase tracking-wider bg-agent-green/10 text-agent-green border border-agent-green/25 hover:bg-agent-green/20 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
              >▶ Run</button>
            )}
          </div>

          {/* Row 2: Signal params or Sweep grid */}
          {sweepActive ? (
            <div className="space-y-2 pt-1 border-t border-agent-border/20">
              <div className="flex items-center gap-2">
                <span className="text-[10px] text-agent-text-muted/60 font-sans uppercase tracking-wider">Sweep Grid</span>
                <span className="text-[10px] text-agent-cyan/60 font-mono">
                  {(() => {
                    const grid: Record<string, number[]> = {}
                    for (const [key, range] of Object.entries(sweepGrid)) {
                      grid[key] = ParameterSweepRunner.range(range.min, range.max, range.step)
                    }
                    return `${ParameterSweepRunner.countCombinations(grid)} combos`
                  })()}
                </span>
              </div>
              {SWEEP_PARAMS.map(sp => (
                <SweepRangeRow
                  key={sp.key}
                  label={sp.label}
                  enabled={sp.key in sweepGrid}
                  range={sweepGrid[sp.key] ?? sp.default}
                  format={sp.format}
                  onToggle={(on) => {
                    const next = { ...sweepGrid }
                    if (on) next[sp.key] = sp.default
                    else delete next[sp.key]
                    setSweepGrid(next)
                  }}
                  onChange={(range) => setSweepGrid({ ...sweepGrid, [sp.key]: range })}
                />
              ))}
              <div className="flex items-center gap-2 pt-1">
                <ToggleChip label="Regime" checked={regimeFilter} onChange={setRegimeFilter} />
                <ToggleChip label="RSI" checked={rsiFilter} onChange={setRsiFilter} />
                <span className="text-[9px] text-agent-text-muted/40 font-sans">(fixed, not swept)</span>
              </div>
            </div>
          ) : (
            <div className="flex items-center gap-4 flex-wrap pt-1 border-t border-agent-border/20">
              <span className="text-[10px] text-agent-text-muted/60 font-sans uppercase tracking-wider">Signal</span>
              <ParamInput label="Min Conf" value={minConfidence} step={0.05} min={0} max={1}
                onChange={setMinConfidence} format={v => `${(v * 100).toFixed(0)}%`} />
              <ParamInput label="Max Price" value={maxEntryPrice} step={0.05} min={0.05} max={0.95}
                onChange={setMaxEntryPrice} format={v => `¢${(v * 100).toFixed(0)}`} />
              <ToggleChip label="Regime" checked={regimeFilter} onChange={setRegimeFilter} />
              <ToggleChip label="RSI" checked={rsiFilter} onChange={setRsiFilter} />
            </div>
          )}

          {/* Progress bar — backtest or sweep */}
          {(isRunning || sweepStatus === 'running') && (
            <div className="flex items-center gap-3">
              <div className="flex-1 h-1 bg-agent-border/20 rounded-full overflow-hidden">
                <div className={`h-full rounded-full transition-all duration-300 ease-out ${sweepActive ? 'bg-agent-cyan/70' : 'bg-agent-green/70'}`}
                  style={{ width: `${sweepActive
                    ? (sweepProgress.total > 0 ? Math.round((sweepProgress.done / sweepProgress.total) * 100) : 0)
                    : progress}%` }} />
              </div>
              <span className="text-[10px] font-mono text-agent-text-muted tabular-nums whitespace-nowrap">
                {sweepActive
                  ? `Combo ${sweepProgress.done}/${sweepProgress.total}`
                  : progressLabel}
              </span>
            </div>
          )}

          {/* Error */}
          {(status === 'error' || sweepStatus === 'error') && (
            <div className="flex items-start gap-2 bg-red-500/5 border border-red-500/15 rounded px-3 py-2">
              <span className="text-red-400 text-xs">✗</span>
              <span className="text-[11px] font-mono text-red-400/80 break-all">{sweepActive ? sweepError : error}</span>
            </div>
          )}
        </div>
      </MatrixCard>

      {/* ── SWEEP RESULTS ── */}
      {sweepActive && sweepResults.length > 0 && (
        <SweepResultsTable results={sweepResults} onApply={(params) => {
          const settings = useSettingsStore.getState()
          // Apply to live strategy via settingsStore setters (these also push to the running strategy)
          if (params.minConfidence != null) settings.setBtcMinConfidence(params.minConfidence)
          if (params.maxEntryPrice != null) settings.setBtcMaxEntryPrice(params.maxEntryPrice)
          // Also update backtest controls so they reflect the applied values
          if (params.minConfidence != null) setMinConfidence(params.minConfidence)
          if (params.maxEntryPrice != null) setMaxEntryPrice(params.maxEntryPrice)
        }} />
      )}

      {/* ── BACKTEST RESULTS (non-sweep) ── */}
      {!sweepActive && hasResults && (
        <>
          {/* Summary stats row */}
          <div className="grid grid-cols-4 lg:grid-cols-8 gap-1.5">
            <StatCell label="Markets" value={results.length.toString()} />
            <StatCell label="Trades" value={aggregated!.totalTrades.toString()} />
            <StatCell label="Win Rate"
              value={`${(aggregated!.winRate * 100).toFixed(1)}%`}
              color={aggregated!.winRate >= 0.5 ? 'green' : 'red'} />
            <StatCell label="Total P&L"
              value={`${aggregated!.totalPnl >= 0 ? '+' : ''}$${aggregated!.totalPnl.toFixed(2)}`}
              color={aggregated!.totalPnl >= 0 ? 'green' : 'red'} />
            <StatCell label="Avg P&L"
              value={`${aggregated!.avgPnl >= 0 ? '+' : ''}$${aggregated!.avgPnl.toFixed(3)}`}
              color={aggregated!.avgPnl >= 0 ? 'green' : 'red'} />
            <StatCell label="Max DD"
              value={`$${aggregated!.maxDrawdown.toFixed(2)}`} color="orange" />
            <StatCell label="Sharpe"
              value={aggregated!.sharpeRatio != null ? aggregated!.sharpeRatio.toFixed(2) : '—'} />
            <StatCell label="Profit Factor"
              value={aggregated!.profitFactor != null ? aggregated!.profitFactor.toFixed(2) : '—'} />
          </div>

          {/* Charts */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-3 min-h-0">
            <EquityCurve results={results} />
            <PnlDistribution results={results} />
          </div>

          {/* Trade log */}
          <TradeTable results={results} />
        </>
      )}

      {/* ── EMPTY STATE ── */}
      {!sweepActive && status === 'idle' && !hasResults && (
        <div className="flex-1 flex items-center justify-center opacity-40">
          <div className="text-center space-y-1">
            <div className="text-2xl font-mono">⟐</div>
            <p className="text-xs font-sans text-agent-text-muted">
              Replay Crypto Up/Down signal against historical data
            </p>
          </div>
        </div>
      )}

      {/* ── SWEEP EMPTY STATE ── */}
      {sweepActive && sweepStatus === 'idle' && sweepResults.length === 0 && (
        <div className="flex-1 flex items-center justify-center opacity-40">
          <div className="text-center space-y-1">
            <div className="text-2xl font-mono">⟐</div>
            <p className="text-xs font-sans text-agent-text-muted">
              Grid search over parameter ranges to find optimal settings
            </p>
          </div>
        </div>
      )}
      </>)}
    </div>
  )
}

// ==========================================
// SHARED MICRO-COMPONENTS
// ==========================================

/** Inline parameter control: label + stepper */
const ParamInput: React.FC<{
  label: string; value: number; step: number; min: number; max: number
  onChange: (v: number) => void; format: (v: number) => string
}> = ({ label, value, step, min, max, onChange, format }) => (
  <div className="flex items-center gap-1.5 group">
    <span className="text-[10px] text-agent-text-muted/70 font-sans">{label}</span>
    <button onClick={() => onChange(Math.max(min, +(value - step).toFixed(2)))}
      className="w-4 h-4 flex items-center justify-center rounded text-[10px] text-agent-text-muted hover:text-agent-green hover:bg-agent-green/10 transition-colors">−</button>
    <span className="text-[11px] font-mono text-agent-text tabular-nums min-w-[32px] text-center">{format(value)}</span>
    <button onClick={() => onChange(Math.min(max, +(value + step).toFixed(2)))}
      className="w-4 h-4 flex items-center justify-center rounded text-[10px] text-agent-text-muted hover:text-agent-green hover:bg-agent-green/10 transition-colors">+</button>
  </div>
)

/** Toggle chip for boolean filters */
const ToggleChip: React.FC<{ label: string; checked: boolean; onChange: (v: boolean) => void }> = ({ label, checked, onChange }) => (
  <button onClick={() => onChange(!checked)}
    className={`px-2 py-0.5 rounded-full text-[10px] font-mono font-bold uppercase tracking-wider border transition-colors ${
      checked
        ? 'bg-agent-green/15 text-agent-green border-agent-green/30'
        : 'text-agent-text-muted/50 border-agent-border/30 hover:text-agent-text-muted hover:border-agent-border/50'
    }`}
  >{label}</button>
)

/** Single stat cell */
const StatCell: React.FC<{ label: string; value: string; color?: 'green' | 'red' | 'orange' }> = ({ label, value, color }) => {
  const colorClass = color === 'green' ? 'text-agent-green' : color === 'red' ? 'text-agent-red' : color === 'orange' ? 'text-orange-400' : 'text-agent-text'
  return (
    <div className="bg-agent-card/60 border border-agent-border/20 rounded px-2.5 py-2 text-center">
      <div className="text-[9px] uppercase tracking-wider text-agent-text-muted/60 font-sans">{label}</div>
      <div className={`text-sm font-mono font-bold tabular-nums mt-0.5 ${colorClass}`}>{value}</div>
    </div>
  )
}

// ==========================================
// SWEEP PARAMETER CONFIG
// ==========================================

const SWEEP_PARAMS = [
  { key: 'minConfidence', label: 'Min Confidence', default: { min: 0.25, max: 0.50, step: 0.05 }, format: (v: number) => `${(v * 100).toFixed(0)}%` },
  { key: 'maxEntryPrice', label: 'Max Entry Price', default: { min: 0.30, max: 0.60, step: 0.05 }, format: (v: number) => `¢${(v * 100).toFixed(0)}` },
  { key: 'minEntryPrice', label: 'Min Entry Price', default: { min: 0.05, max: 0.20, step: 0.05 }, format: (v: number) => `¢${(v * 100).toFixed(0)}` },
  { key: 'tradeSize', label: 'Trade Size', default: { min: 1, max: 5, step: 1 }, format: (v: number) => `$${v}` },
]

/** Single row: checkbox + label + min/max/step inputs */
const SweepRangeRow: React.FC<{
  label: string; enabled: boolean; range: { min: number; max: number; step: number }
  format: (v: number) => string
  onToggle: (on: boolean) => void; onChange: (r: { min: number; max: number; step: number }) => void
}> = ({ label, enabled, range, format, onToggle, onChange }) => (
  <div className="flex items-center gap-3 flex-wrap">
    <button onClick={() => onToggle(!enabled)}
      className={`w-4 h-4 rounded border flex items-center justify-center text-[9px] transition-colors ${
        enabled ? 'bg-agent-cyan/20 border-agent-cyan/40 text-agent-cyan' : 'border-agent-border/40 text-transparent'
      }`}
    >✓</button>
    <span className={`text-[11px] font-sans w-28 ${enabled ? 'text-agent-text' : 'text-agent-text-muted/40'}`}>{label}</span>
    {enabled && (
      <>
        {(['min', 'max', 'step'] as const).map(field => (
          <div key={field} className="flex items-center gap-1">
            <span className="text-[9px] text-agent-text-muted/50 font-sans uppercase w-7">{field}</span>
            <input type="number" step={0.01} value={range[field]}
              onChange={e => onChange({ ...range, [field]: Number(e.target.value) || 0 })}
              className="w-14 bg-agent-bg/60 border border-agent-border/40 rounded px-1.5 py-0.5 text-[11px] font-mono text-agent-text focus:border-agent-cyan/50 outline-none tabular-nums"
            />
          </div>
        ))}
        <span className="text-[9px] text-agent-text-muted/40 font-mono">
          {format(range.min)}→{format(range.max)}
        </span>
      </>
    )}
  </div>
)

/** Ranked results table for sweep */
const SweepResultsTable: React.FC<{
  results: SweepResult[]; onApply: (params: Record<string, number>) => void
}> = ({ results, onApply }) => {
  const [expanded, setExpanded] = useState(false)
  const visible = expanded ? results : results.slice(0, 20)
  const best = results[0]

  return (
    <MatrixCard
      title="SWEEP RESULTS"
      subtitle={`${results.length} combinations ranked by Sharpe`}
      variant="default"
    >
      {/* Apply best button */}
      {best && (
        <div className="flex items-center gap-3 mb-3 p-2 bg-agent-cyan/5 border border-agent-cyan/15 rounded">
          <span className="text-[10px] font-sans text-agent-cyan uppercase tracking-wider">Best:</span>
          <span className="text-xs font-mono text-agent-text">
            {Object.entries(best.params).map(([k, v]) => `${k}=${v}`).join(', ')}
          </span>
          <span className="text-xs font-mono font-bold text-agent-cyan">
            Sharpe {best.score.toFixed(2)}
          </span>
          <div className="flex-1" />
          <button onClick={() => onApply(best.params as Record<string, number>)}
            className="px-3 py-1 rounded text-[10px] font-mono font-bold uppercase tracking-wider bg-agent-cyan/10 text-agent-cyan border border-agent-cyan/25 hover:bg-agent-cyan/20 transition-colors"
          >Apply to Live</button>
        </div>
      )}

      <div className="overflow-x-auto -mx-3">
        <table className="w-full text-xs font-mono border-collapse">
          <thead>
            <tr className="border-b border-agent-border/30">
              <th className="py-2 px-3 font-sans font-semibold text-agent-text-muted/70 text-[10px] uppercase tracking-wider text-center w-8">#</th>
              <th className="py-2 px-3 font-sans font-semibold text-agent-text-muted/70 text-[10px] uppercase tracking-wider text-left">Params</th>
              <th className="py-2 px-3 font-sans font-semibold text-agent-text-muted/70 text-[10px] uppercase tracking-wider text-right">Sharpe</th>
              <th className="py-2 px-3 font-sans font-semibold text-agent-text-muted/70 text-[10px] uppercase tracking-wider text-right">P&L</th>
              <th className="py-2 px-3 font-sans font-semibold text-agent-text-muted/70 text-[10px] uppercase tracking-wider text-right">Win%</th>
              <th className="py-2 px-3 font-sans font-semibold text-agent-text-muted/70 text-[10px] uppercase tracking-wider text-right">Trades</th>
              <th className="py-2 px-3 font-sans font-semibold text-agent-text-muted/70 text-[10px] uppercase tracking-wider text-right">Max DD</th>
              <th className="py-2 px-3 font-sans font-semibold text-agent-text-muted/70 text-[10px] uppercase tracking-wider text-center w-16">Apply</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((r, i) => {
              const isTop = i === 0
              return (
                <tr key={i} className={`border-b border-agent-border/5 transition-colors hover:bg-agent-cyan/[0.03] ${
                  i % 2 === 0 ? 'bg-transparent' : 'bg-agent-card/30'
                } ${isTop ? 'bg-agent-cyan/5' : ''}`}>
                  <td className="py-1.5 px-3 text-center text-agent-text-muted/60 tabular-nums">{i + 1}</td>
                  <td className="py-1.5 px-3 text-agent-text/80 whitespace-nowrap">
                    {Object.entries(r.params).map(([k, v]) => (
                      <span key={k} className="inline-block mr-2">
                        <span className="text-agent-text-muted/50">{k.replace(/([A-Z])/g, ' $1').trim()}:</span>{' '}
                        <span className="text-agent-text font-semibold">{typeof v === 'number' ? v.toFixed(2) : v}</span>
                      </span>
                    ))}
                  </td>
                  <td className={`py-1.5 px-3 text-right tabular-nums font-bold ${r.score >= 0 ? 'text-agent-green' : 'text-agent-red'}`}>
                    {r.score.toFixed(2)}
                  </td>
                  <td className={`py-1.5 px-3 text-right tabular-nums ${r.summary.totalPnl >= 0 ? 'text-agent-green' : 'text-agent-red'}`}>
                    {r.summary.totalPnl >= 0 ? '+' : ''}${r.summary.totalPnl.toFixed(2)}
                  </td>
                  <td className="py-1.5 px-3 text-right tabular-nums text-agent-text-muted">
                    {(r.summary.winRate * 100).toFixed(1)}%
                  </td>
                  <td className="py-1.5 px-3 text-right tabular-nums text-agent-text-muted">
                    {r.summary.totalTrades}
                  </td>
                  <td className="py-1.5 px-3 text-right tabular-nums text-orange-400">
                    ${r.summary.maxDrawdown.toFixed(2)}
                  </td>
                  <td className="py-1.5 px-3 text-center">
                    <button onClick={() => onApply(r.params as Record<string, number>)}
                      className="text-[9px] font-mono text-agent-cyan/60 hover:text-agent-cyan transition-colors"
                    >use</button>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      {results.length > 20 && (
        <button onClick={() => setExpanded(e => !e)}
          className="mt-2 w-full py-2 text-[10px] font-mono text-agent-text-muted/50 hover:text-agent-cyan transition-colors border-t border-agent-border/15 uppercase tracking-wider"
        >
          {expanded ? '▲ Collapse' : `▼ Show all ${results.length} combinations`}
        </button>
      )}
    </MatrixCard>
  )
}

// ==========================================
// EQUITY CURVE
// ==========================================

const EquityCurve: React.FC<{ results: BacktestResult[] }> = ({ results }) => {
  const allTrades = results.flatMap(r => r.trades).filter(t => t.resolved)
  if (allTrades.length === 0) return null

  let cumPnl = 0
  const data = allTrades.map((t, i) => {
    cumPnl += t.pnl
    return { trade: i + 1, pnl: Number(cumPnl.toFixed(3)) }
  })
  const isNeg = data[data.length - 1]?.pnl < 0

  return (
    <MatrixCard title="EQUITY CURVE" subtitle="Cumulative P&L" variant="default" className="min-h-[260px]">
      <MatrixLineChart
        data={data}
        lines={[{ dataKey: 'pnl', name: 'P&L', color: isNeg ? '#ef4444' : '#22c55e', strokeWidth: 1.5, dot: false }]}
        xAxisKey="trade"
        height={200}
        showGrid
        yAxisFormatter={v => `$${v.toFixed(1)}`}
        xAxisFormatter={v => `${v}`}
      />
    </MatrixCard>
  )
}

// ==========================================
// P&L DISTRIBUTION
// ==========================================

const PnlDistribution: React.FC<{ results: BacktestResult[] }> = ({ results }) => {
  const allTrades = results.flatMap(r => r.trades).filter(t => t.resolved)
  if (allTrades.length === 0) return null

  const buckets = new Map<string, number>()
  for (const t of allTrades) {
    const bucket = t.pnl >= 0
      ? `+${(Math.floor(t.pnl * 10) / 10).toFixed(1)}`
      : `${(Math.ceil(t.pnl * 10) / 10).toFixed(1)}`
    buckets.set(bucket, (buckets.get(bucket) ?? 0) + 1)
  }

  const data = Array.from(buckets.entries())
    .sort(([a], [b]) => parseFloat(a) - parseFloat(b))
    .map(([range, count]) => ({ range, count }))

  return (
    <MatrixCard title="P&L DISTRIBUTION" subtitle="Trade outcomes" variant="default" className="min-h-[260px]">
      <MatrixBarChart
        data={data}
        bars={[{ dataKey: 'count', name: 'Trades', color: '#22c55e' }]}
        xAxisKey="range"
        height={200}
        showGrid
        colorByValue
        barSize={20}
      />
    </MatrixCard>
  )
}

// ==========================================
// MULTI-STRATEGY EQUITY CURVE
// ==========================================

const STRATEGY_COLORS: Record<string, string> = {
  'btc-updown': '#22c55e',
  'dual-side': '#06b6d4',
  'gabagool': '#f97316',
  'impulse-sniper': '#a855f7',
  'dip-arb': '#eab308',
  'project-fw': '#ec4899',
  'llm-prediction': '#6366f1',
}

const MultiEquityCurve: React.FC<{ strategies: StrategyBacktestResult[] }> = ({ strategies }) => {
  if (strategies.length === 0) return null

  // Build per-strategy cumulative P&L series
  const lines: Array<{ dataKey: string; name: string; color: string; strokeWidth: number; dot: false }> = []
  let maxLen = 0

  const seriesMap = new Map<string, number[]>()
  for (const s of strategies) {
    if (s.trades.length === 0) continue
    let cum = 0
    const series = s.trades.map(t => { cum += t.pnl; return Number(cum.toFixed(3)) })
    seriesMap.set(s.strategy, series)
    if (series.length > maxLen) maxLen = series.length
    lines.push({
      dataKey: s.strategy,
      name: s.strategyName,
      color: STRATEGY_COLORS[s.strategy] ?? '#888',
      strokeWidth: 1.5,
      dot: false,
    })
  }

  if (maxLen === 0) return null

  // Merge into unified data array (pad shorter series with last value)
  const data: Array<Record<string, number>> = []
  for (let i = 0; i < maxLen; i++) {
    const point: Record<string, number> = { trade: i + 1 }
    for (const [key, series] of seriesMap) {
      point[key] = series[Math.min(i, series.length - 1)]
    }
    data.push(point)
  }

  return (
    <MatrixCard title="MULTI-STRATEGY EQUITY" subtitle="Cumulative P&L per strategy" variant="default" className="min-h-[260px]">
      <MatrixLineChart
        data={data}
        lines={lines}
        xAxisKey="trade"
        height={200}
        showGrid
        yAxisFormatter={v => `$${v.toFixed(1)}`}
        xAxisFormatter={v => `${v}`}
      />
    </MatrixCard>
  )
}

// ==========================================
// TRADE TABLE
// ==========================================

/** Format hold time from ms to human-readable */
const fmtHold = (ms: number) => {
  if (ms < 60_000) return `${(ms / 1000).toFixed(0)}s`
  if (ms < 3_600_000) return `${(ms / 60_000).toFixed(0)}m`
  return `${(ms / 3_600_000).toFixed(1)}h`
}

/** Format market slug: strip prefix, convert epoch to short date */
const fmtMarket = (slug: string, marketType: string) => {
  const stripped = slug.replace(/^btc-updown-/, '').replace(/-/g, ' ')
  // If the remaining text looks like a bare epoch (all digits), format it
  const match = stripped.match(/^(\d+)$/) || stripped.match(/^(\w+)\s+(\d{8,})$/)
  if (match) {
    const epoch = Number(match[2] ?? match[1])
    if (epoch > 1_000_000_000) {
      const d = new Date(epoch * 1000)
      const time = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false })
      return `${marketType} ${time}`
    }
  }
  return `${marketType} ${stripped}`
}

const TradeTable: React.FC<{ results: BacktestResult[] }> = ({ results }) => {
  const [expanded, setExpanded] = useState(false)
  const [sortKey, setSortKey] = useState<'time' | 'pnl' | 'conf' | 'entry'>('time')
  const [sortAsc, setSortAsc] = useState(false)

  const rows = results.flatMap(r =>
    r.trades.map(t => ({ ...t, slug: r.slug, marketType: r.marketType }))
  )
  if (rows.length === 0) return null

  // Sort
  const sorted = [...rows].sort((a, b) => {
    const dir = sortAsc ? 1 : -1
    switch (sortKey) {
      case 'pnl': return (a.pnl - b.pnl) * dir
      case 'conf': return (a.confidence - b.confidence) * dir
      case 'entry': return (a.entryPrice - b.entryPrice) * dir
      default: return (new Date(a.snapshotTime).getTime() - new Date(b.snapshotTime).getTime()) * dir
    }
  })

  const visible = expanded ? sorted : sorted.slice(0, 30)
  const wins = rows.filter(r => r.pnl > 0).length
  const losses = rows.filter(r => r.pnl < 0).length

  const handleSort = (key: typeof sortKey) => {
    if (sortKey === key) setSortAsc(a => !a)
    else { setSortKey(key); setSortAsc(key === 'time') }
  }

  const sortIcon = (key: typeof sortKey) =>
    sortKey === key ? (sortAsc ? ' ↑' : ' ↓') : ''

  return (
    <MatrixCard
      title="TRADE LOG"
      subtitle={`${rows.length} trades · ${wins}W / ${losses}L`}
      variant="default"
    >
      <div className="overflow-x-auto -mx-3">
        <table className="w-full text-xs font-mono border-collapse">
          <thead>
            <tr className="border-b border-agent-border/30">
              <th onClick={() => handleSort('time')}
                className="py-2 px-3 font-sans font-semibold text-agent-text-muted/70 text-[10px] uppercase tracking-wider text-left cursor-pointer hover:text-agent-green select-none whitespace-nowrap">
                Time{sortIcon('time')}
              </th>
              <th className="py-2 px-3 font-sans font-semibold text-agent-text-muted/70 text-[10px] uppercase tracking-wider text-left">
                Market
              </th>
              <th className="py-2 px-3 font-sans font-semibold text-agent-text-muted/70 text-[10px] uppercase tracking-wider text-center w-10">
                Dir
              </th>
              <th onClick={() => handleSort('conf')}
                className="py-2 px-3 font-sans font-semibold text-agent-text-muted/70 text-[10px] uppercase tracking-wider text-right cursor-pointer hover:text-agent-green select-none">
                Conf{sortIcon('conf')}
              </th>
              <th onClick={() => handleSort('entry')}
                className="py-2 px-3 font-sans font-semibold text-agent-text-muted/70 text-[10px] uppercase tracking-wider text-right cursor-pointer hover:text-agent-green select-none">
                Entry{sortIcon('entry')}
              </th>
              <th className="py-2 px-3 font-sans font-semibold text-agent-text-muted/70 text-[10px] uppercase tracking-wider text-right">
                BTC
              </th>
              <th className="py-2 px-3 font-sans font-semibold text-agent-text-muted/70 text-[10px] uppercase tracking-wider text-right">
                Hold
              </th>
              <th onClick={() => handleSort('pnl')}
                className="py-2 px-3 font-sans font-semibold text-agent-text-muted/70 text-[10px] uppercase tracking-wider text-right cursor-pointer hover:text-agent-green select-none">
                P&L{sortIcon('pnl')}
              </th>
            </tr>
          </thead>
          <tbody>
            {visible.map((t, i) => {
              const won = t.winner === t.direction
              const isWin = t.pnl > 0
              const isLoss = t.pnl < 0
              return (
                <tr key={i} className={`border-b border-agent-border/5 transition-colors hover:bg-agent-green/[0.03] ${
                  i % 2 === 0 ? 'bg-transparent' : 'bg-agent-card/30'
                }`}>
                  <td className="py-1.5 px-3 text-agent-text-muted/60 whitespace-nowrap">
                    {new Date(t.snapshotTime).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                  </td>
                  <td className="py-1.5 px-3 text-agent-text/60 whitespace-nowrap" title={t.slug}>
                    {fmtMarket(t.slug, t.marketType)}
                  </td>
                  <td className="py-1.5 px-3 text-center">
                    <span className={`text-xs font-bold ${t.direction === 'up' ? 'text-agent-green' : 'text-orange-400'}`}>
                      {t.direction === 'up' ? '▲' : '▼'}
                    </span>
                  </td>
                  <td className="py-1.5 px-3 text-right tabular-nums text-agent-text-muted">
                    {(t.confidence * 100).toFixed(0)}%
                  </td>
                  <td className="py-1.5 px-3 text-right tabular-nums">
                    ¢{(t.entryPrice * 100).toFixed(1)}
                  </td>
                  <td className="py-1.5 px-3 text-right tabular-nums text-agent-text-muted/50">
                    {(t.btcPriceAtEntry / 1000).toFixed(1)}k
                  </td>
                  <td className="py-1.5 px-3 text-right tabular-nums text-agent-text-muted/50">
                    {t.holdTimeMs > 0 ? fmtHold(t.holdTimeMs) : '—'}
                  </td>
                  <td className="py-1.5 px-3 text-right tabular-nums font-bold">
                    <span className={`inline-flex items-center gap-1 ${
                      isWin ? 'text-agent-green' : isLoss ? 'text-agent-red' : 'text-agent-text-muted'
                    }`}>
                      {t.winner && (
                        <span className="text-[9px]">{won ? '✓' : '✗'}</span>
                      )}
                      {t.pnl > 0 ? '+' : ''}{t.pnl.toFixed(2)}
                    </span>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      {rows.length > 30 && (
        <button onClick={() => setExpanded(e => !e)}
          className="mt-2 w-full py-2 text-[10px] font-mono text-agent-text-muted/50 hover:text-agent-green transition-colors border-t border-agent-border/15 uppercase tracking-wider"
        >
          {expanded ? '▲ Collapse' : `▼ Show all ${rows.length} trades`}
        </button>
      )}
    </MatrixCard>
  )
}
