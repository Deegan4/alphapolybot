/**
 * backtestStore — Zustand store for backtest run state.
 *
 * Lives outside of React component lifecycle so a running backtest survives
 * tab switches (BacktestView unmount/remount). The component is a thin
 * renderer; all async orchestration happens via store actions.
 *
 * Covers three run modes: single-strategy BTC signal, multi-strategy, and
 * parameter sweep — all survive unmount/remount.
 */
import { create } from 'zustand'
import { backtestRunner } from '@/services/strategies/btcupdown/BacktestRunner'
import { polyBacktestClient } from '@/services/api/PolyBacktestClient'
import { ParameterSweepRunner } from '@/services/strategies/btcupdown/ParameterSweepRunner'
import type { SweepResult } from '@/services/strategies/btcupdown/ParameterSweepRunner'
import type {
  BacktestResult,
  BacktestStrategyType,
  BacktestSummary,
  BtcUpDownConfig,
  MultiStrategyBacktestResult,
  PolyBacktestMarketType,
} from '@/types'

// ==========================================
// TYPES
// ==========================================

export type RunMode = 'single' | 'batch'
export type RunStatus = 'idle' | 'running' | 'done' | 'error'

export interface SweepGrid {
  [param: string]: { min: number; max: number; step: number }
}

export interface BacktestState {
  // ── Single-strategy run state (survives unmount) ──
  status: RunStatus
  progress: number
  progressLabel: string
  error: string | null
  results: BacktestResult[]
  aggregated: BacktestSummary | null

  // ── Multi-strategy run state (survives unmount) ──
  multiMode: boolean
  multiStatus: RunStatus
  multiProgress: string
  multiError: string | null
  multiResults: MultiStrategyBacktestResult | null
  selectedStrategies: Set<BacktestStrategyType>

  // ── Parameter sweep state (survives unmount) ──
  sweepActive: boolean
  sweepStatus: RunStatus
  sweepProgress: { done: number; total: number }
  sweepError: string | null
  sweepResults: SweepResult[]
  sweepGrid: SweepGrid

  // ── Controls (persisted across mounts so form values aren't lost) ──
  mode: RunMode
  marketType: PolyBacktestMarketType
  slug: string
  maxMarkets: number
  minConfidence: number
  maxEntryPrice: number
  regimeFilter: boolean
  rsiFilter: boolean

  // ── Actions: controls ──
  setMode: (mode: RunMode) => void
  setMarketType: (mt: PolyBacktestMarketType) => void
  setSlug: (slug: string) => void
  setMaxMarkets: (n: number) => void
  setMinConfidence: (v: number) => void
  setMaxEntryPrice: (v: number) => void
  setRegimeFilter: (v: boolean) => void
  setRsiFilter: (v: boolean) => void

  // ── Actions: single-strategy ──
  runBacktest: (apiKey: string) => void
  stopBacktest: () => void

  // ── Actions: multi-strategy ──
  setMultiMode: (v: boolean) => void
  toggleStrategy: (s: BacktestStrategyType) => void
  runMultiBacktest: (apiKey: string) => void
  stopMultiBacktest: () => void

  // ── Actions: sweep ──
  setSweepActive: (v: boolean) => void
  setSweepGrid: (grid: SweepGrid) => void
  runSweep: (apiKey: string) => void
  stopSweep: () => void
}

// ==========================================
// ABORT CONTROLLERS (module-level, not in store)
// ==========================================

let activeController: AbortController | null = null
let multiController: AbortController | null = null
let sweepController: AbortController | null = null

// ==========================================
// STORE
// ==========================================

export const useBacktestStore = create<BacktestState>()((set, get) => ({
  // Single-strategy run state
  status: 'idle',
  progress: 0,
  progressLabel: '',
  error: null,
  results: [],
  aggregated: null,

  // Multi-strategy run state
  multiMode: false,
  multiStatus: 'idle',
  multiProgress: '',
  multiError: null,
  multiResults: null,
  selectedStrategies: new Set<BacktestStrategyType>(['btc-updown', 'dual-side', 'gabagool', 'impulse-sniper']),

  // Sweep run state
  sweepActive: false,
  sweepStatus: 'idle',
  sweepProgress: { done: 0, total: 0 },
  sweepError: null,
  sweepResults: [],
  sweepGrid: {
    minConfidence: { min: 0.25, max: 0.50, step: 0.05 },
    maxEntryPrice: { min: 0.30, max: 0.60, step: 0.05 },
  },

  // Controls — defaults tuned for backtest exploration
  mode: 'batch',
  marketType: '15m',
  slug: '',
  maxMarkets: 50,
  minConfidence: 0.30,
  maxEntryPrice: 0.55,
  regimeFilter: false,
  rsiFilter: false,

  // ── Control setters ──
  setMode: (mode) => set({ mode }),
  setMarketType: (marketType) => set({ marketType }),
  setSlug: (slug) => set({ slug }),
  setMaxMarkets: (maxMarkets) => set({ maxMarkets }),
  setMinConfidence: (minConfidence) => set({ minConfidence }),
  setMaxEntryPrice: (maxEntryPrice) => set({ maxEntryPrice }),
  setRegimeFilter: (regimeFilter) => set({ regimeFilter }),
  setRsiFilter: (rsiFilter) => set({ rsiFilter }),

  // ── Single-strategy: RUN ──
  runBacktest: (apiKey: string) => {
    const state = get()
    if (state.status === 'running') return

    if (apiKey) polyBacktestClient.setApiKey(apiKey)

    const controller = new AbortController()
    activeController = controller

    const configOverrides: Partial<BtcUpDownConfig> = {
      minConfidence: state.minConfidence,
      maxEntryPrice: state.maxEntryPrice,
      regimeFilterEnabled: state.regimeFilter,
      rsiFilterEnabled: state.rsiFilter,
    }

    set({
      status: 'running',
      progress: 0,
      progressLabel: state.mode === 'batch'
        ? `Discovering ${state.marketType} markets...`
        : 'Fetching market...',
      error: null,
      results: [],
      aggregated: null,
    })

    if (state.mode === 'single') {
      runSingle(state.slug, configOverrides, controller)
    } else {
      runBatch(state.marketType, state.maxMarkets, configOverrides, controller)
    }
  },

  // ── Single-strategy: STOP ──
  stopBacktest: () => {
    activeController?.abort()
    activeController = null
    set({ status: 'idle', progressLabel: 'Aborted' })
  },

  // ── Multi-strategy ──
  setMultiMode: (multiMode) => set({ multiMode }),

  toggleStrategy: (s) => set((state) => {
    const next = new Set(state.selectedStrategies)
    if (next.has(s)) next.delete(s)
    else next.add(s)
    return { selectedStrategies: next }
  }),

  runMultiBacktest: (apiKey: string) => {
    const state = get()
    if (state.multiStatus === 'running') return
    if (state.selectedStrategies.size === 0) return

    const controller = new AbortController()
    multiController = controller

    set({
      multiStatus: 'running',
      multiProgress: 'Starting...',
      multiError: null,
      multiResults: null,
    })

    runMulti(
      Array.from(state.selectedStrategies),
      state.marketType,
      state.maxMarkets,
      apiKey,
      controller,
    )
  },

  stopMultiBacktest: () => {
    multiController?.abort()
    multiController = null
    set({ multiStatus: 'idle', multiProgress: 'Aborted' })
  },

  // ── Sweep ──
  setSweepActive: (sweepActive) => set({ sweepActive }),
  setSweepGrid: (sweepGrid) => set({ sweepGrid }),

  runSweep: (apiKey: string) => {
    const state = get()
    if (state.sweepStatus === 'running') return

    const grid: Record<string, number[]> = {}
    for (const [key, range] of Object.entries(state.sweepGrid)) {
      grid[key] = ParameterSweepRunner.range(range.min, range.max, range.step)
    }

    const total = ParameterSweepRunner.countCombinations(grid)
    if (total > 500) {
      set({
        sweepStatus: 'error',
        sweepError: `Too many combinations (${total}). Reduce ranges or increase step size.`,
      })
      return
    }

    const controller = new AbortController()
    sweepController = controller

    set({
      sweepStatus: 'running',
      sweepProgress: { done: 0, total },
      sweepResults: [],
      sweepError: null,
    })

    runSweepAsync(
      state.marketType,
      state.maxMarkets,
      state.regimeFilter,
      state.rsiFilter,
      grid,
      apiKey,
      controller,
    )
  },

  stopSweep: () => {
    sweepController?.abort()
    sweepController = null
    set({ sweepStatus: 'idle' })
  },
}))

// ==========================================
// ASYNC RUNNERS (write into store, survive unmounts)
// ==========================================

async function runSingle(
  slug: string,
  config: Partial<BtcUpDownConfig>,
  controller: AbortController,
) {
  const store = useBacktestStore
  try {
    const input = slug.trim()
    const isMarketId = input.startsWith('0x') || /^[0-9a-f-]{20,}$/i.test(input)

    const result = await backtestRunner.run({
      ...(isMarketId ? { marketId: input } : { slug: input }),
      signal: controller.signal,
      config,
      onProgress: (fetched, total) => {
        if (controller.signal.aborted) return
        const pct = total > 0 ? Math.round((fetched / total) * 100) : 0
        store.setState({ progress: pct, progressLabel: `Snapshots ${fetched}/${total}` })
      },
    })

    if (controller.signal.aborted) return
    store.setState({
      status: 'done',
      progress: 100,
      progressLabel: 'Complete',
      results: [result],
      aggregated: result.summary,
    })
  } catch (err) {
    if (controller.signal.aborted) return
    store.setState({ status: 'error', error: String(err) })
  } finally {
    if (activeController === controller) activeController = null
  }
}

async function runBatch(
  marketType: PolyBacktestMarketType,
  maxMarkets: number,
  config: Partial<BtcUpDownConfig>,
  controller: AbortController,
) {
  const store = useBacktestStore
  try {
    const results = await backtestRunner.runBatch(marketType, {
      signal: controller.signal,
      maxMarkets,
      config,
      onDiscovery: (label) => {
        if (controller.signal.aborted) return
        store.setState({ progressLabel: label })
      },
      onProgress: (i, total) => {
        if (controller.signal.aborted) return
        const pct = total > 0 ? Math.round((i / total) * 100) : 0
        store.setState({ progress: pct, progressLabel: `Market ${i}/${total}` })
      },
    })

    if (controller.signal.aborted) return
    const aggregated = backtestRunner.aggregateResults(results)
    store.setState({
      status: 'done',
      progress: 100,
      progressLabel: `${results.length} markets`,
      results,
      aggregated,
    })
  } catch (err) {
    if (controller.signal.aborted) return
    store.setState({ status: 'error', error: String(err) })
  } finally {
    if (activeController === controller) activeController = null
  }
}

async function runMulti(
  strategies: BacktestStrategyType[],
  marketType: PolyBacktestMarketType,
  maxMarkets: number,
  apiKey: string,
  controller: AbortController,
) {
  const store = useBacktestStore
  try {
    const { backtestOrchestrator } = await import('@/services/backtest')
    const result = await backtestOrchestrator.run({
      strategies,
      marketType,
      maxMarkets,
      apiKey,
      signal: controller.signal,
      onProgress: (_strategy, _pct, label) => {
        if (!controller.signal.aborted) {
          store.setState({ multiProgress: label })
        }
      },
    })

    if (!controller.signal.aborted) {
      store.setState({
        multiResults: result,
        multiStatus: 'done',
      })
    }
  } catch (err) {
    if (controller.signal.aborted) return
    if ((err as Error).name === 'AbortError') return
    store.setState({ multiStatus: 'error', multiError: String(err) })
  } finally {
    if (multiController === controller) multiController = null
  }
}

async function runSweepAsync(
  marketType: PolyBacktestMarketType,
  maxMarkets: number,
  regimeFilter: boolean,
  rsiFilter: boolean,
  grid: Record<string, number[]>,
  apiKey: string,
  controller: AbortController,
) {
  const store = useBacktestStore
  try {
    if (apiKey) {
      const { polyBacktestClient: pbc } = await import('@/services/api/PolyBacktestClient')
      pbc.setApiKey(apiKey)
    }

    const runner = new ParameterSweepRunner()
    const results = await runner.sweep({
      marketType,
      maxMarkets,
      config: { regimeFilterEnabled: regimeFilter, rsiFilterEnabled: rsiFilter },
      grid,
      signal: controller.signal,
      onProgress: (done, total) => {
        if (!controller.signal.aborted) {
          store.setState({ sweepProgress: { done, total } })
        }
      },
    })

    if (!controller.signal.aborted) {
      store.setState({
        sweepResults: results,
        sweepStatus: 'done',
      })
    }
  } catch (err) {
    if (controller.signal.aborted) return
    if ((err as Error).name === 'AbortError') return
    store.setState({ sweepStatus: 'error', sweepError: String(err) })
  } finally {
    if (sweepController === controller) sweepController = null
  }
}
