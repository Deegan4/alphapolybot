/**
 * backtestStore — Zustand store for backtest run state.
 *
 * Lives outside of React component lifecycle so a running backtest survives
 * tab switches (BacktestView unmount/remount). The component is a thin
 * renderer; all async orchestration happens via store actions.
 */
import { create } from 'zustand'
import { backtestRunner } from '@/services/strategies/btcupdown/BacktestRunner'
import { polyBacktestClient } from '@/services/api/PolyBacktestClient'
import type {
  BacktestResult,
  BacktestSummary,
  BtcUpDownConfig,
  PolyBacktestMarketType,
} from '@/types'

// ==========================================
// TYPES
// ==========================================

export type RunMode = 'single' | 'batch'
export type RunStatus = 'idle' | 'running' | 'done' | 'error'

export interface BacktestState {
  // Run state (survives unmount)
  status: RunStatus
  progress: number
  progressLabel: string
  error: string | null
  results: BacktestResult[]
  aggregated: BacktestSummary | null

  // Controls (persisted across mounts so form values aren't lost)
  mode: RunMode
  marketType: PolyBacktestMarketType
  slug: string
  maxMarkets: number
  minConfidence: number
  maxEntryPrice: number
  regimeFilter: boolean
  rsiFilter: boolean

  // Actions
  setMode: (mode: RunMode) => void
  setMarketType: (mt: PolyBacktestMarketType) => void
  setSlug: (slug: string) => void
  setMaxMarkets: (n: number) => void
  setMinConfidence: (v: number) => void
  setMaxEntryPrice: (v: number) => void
  setRegimeFilter: (v: boolean) => void
  setRsiFilter: (v: boolean) => void
  runBacktest: (apiKey: string) => void
  stopBacktest: () => void
}

// ==========================================
// ABORT CONTROLLER (module-level, not in store)
// ==========================================

let activeController: AbortController | null = null

// ==========================================
// STORE
// ==========================================

export const useBacktestStore = create<BacktestState>()((set, get) => ({
  // Run state
  status: 'idle',
  progress: 0,
  progressLabel: '',
  error: null,
  results: [],
  aggregated: null,

  // Controls — defaults tuned for backtest exploration
  mode: 'batch',
  marketType: '15m',
  slug: '',
  maxMarkets: 50,
  minConfidence: 0.30,
  maxEntryPrice: 0.55,
  regimeFilter: false,
  rsiFilter: false,

  // Setters
  setMode: (mode) => set({ mode }),
  setMarketType: (marketType) => set({ marketType }),
  setSlug: (slug) => set({ slug }),
  setMaxMarkets: (maxMarkets) => set({ maxMarkets }),
  setMinConfidence: (minConfidence) => set({ minConfidence }),
  setMaxEntryPrice: (maxEntryPrice) => set({ maxEntryPrice }),
  setRegimeFilter: (regimeFilter) => set({ regimeFilter }),
  setRsiFilter: (rsiFilter) => set({ rsiFilter }),

  // ---- RUN ----
  runBacktest: (apiKey: string) => {
    const state = get()
    if (state.status === 'running') return

    // Configure API key
    if (apiKey) polyBacktestClient.setApiKey(apiKey)
    if (!polyBacktestClient.hasApiKey()) {
      set({ status: 'error', error: 'No PolyBacktest API key — set in Settings → API Keys.' })
      return
    }

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

    // Fire-and-forget async — writes results into the store
    if (state.mode === 'single') {
      runSingle(state.slug, configOverrides, controller)
    } else {
      runBatch(state.marketType, state.maxMarkets, configOverrides, controller)
    }
  },

  // ---- STOP ----
  stopBacktest: () => {
    activeController?.abort()
    activeController = null
    set({ status: 'idle', progressLabel: 'Aborted' })
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
