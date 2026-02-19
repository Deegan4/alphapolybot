import { create } from 'zustand'
import { persist } from 'zustand/middleware'

export interface BalanceSnapshot {
  timestamp: number
  balance: number
}

interface BalanceHistoryState {
  snapshots: BalanceSnapshot[]
  initialBalance: number
  startTime: number
  /** Running simulated balance — tracks buys/sells for live chart updates (especially dry-run) */
  simulatedBalance: number

  addSnapshot: (balance: number) => void
  setInitialBalance: (balance: number) => void
  setStartTime: (time: number) => void
  bulkAddSnapshots: (snapshots: BalanceSnapshot[]) => void
  /** Record a BUY: deduct cost from simulated balance and snapshot */
  recordBuy: (costUsd: number) => void
  /** Record a SELL: add proceeds to simulated balance and snapshot */
  recordSell: (proceedsUsd: number) => void
  /** Sync simulated balance to real wallet balance (call when wallet refreshes) */
  syncSimulatedBalance: (realBalance: number) => void
}

const MAX_SNAPSHOTS = 500

export const useBalanceHistoryStore = create<BalanceHistoryState>()(
  persist(
    (set, get) => ({
      snapshots: [],
      initialBalance: 0,
      startTime: 0,
      simulatedBalance: 0,

      addSnapshot: (balance: number) => {
        if (balance <= 0) return
        // Deduplicate rapid-fire snapshots (e.g., recordBuy then recordSell in same second).
        // Each set() copies the array + triggers persist middleware → localStorage serialization.
        const { snapshots } = get()
        const last = snapshots[snapshots.length - 1]
        if (last && Date.now() - last.timestamp < 2000 && Math.abs(last.balance - balance) < 0.01) {
          return
        }
        set((state) => {
          const next = [...state.snapshots, { timestamp: Date.now(), balance }]
          if (next.length > MAX_SNAPSHOTS) {
            return { snapshots: next.slice(-MAX_SNAPSHOTS) }
          }
          return { snapshots: next }
        })
      },

      setInitialBalance: (balance: number) => {
        if (get().initialBalance !== 0) return // idempotent
        set({ initialBalance: balance, simulatedBalance: balance })
      },

      setStartTime: (time: number) => {
        if (get().startTime !== 0) return // idempotent
        set({ startTime: time })
      },

      bulkAddSnapshots: (newSnapshots: BalanceSnapshot[]) => {
        set((state) => {
          const existing = new Set(state.snapshots.map(s => s.timestamp))
          const merged = [
            ...newSnapshots.filter(s => !existing.has(s.timestamp)),
            ...state.snapshots,
          ].sort((a, b) => a.timestamp - b.timestamp)
          return { snapshots: merged.slice(-MAX_SNAPSHOTS) }
        })
      },

      recordBuy: (costUsd: number) => {
        const { simulatedBalance } = get()
        const newBalance = Math.max(0.01, simulatedBalance - costUsd)
        set({ simulatedBalance: newBalance })
        get().addSnapshot(newBalance)
      },

      recordSell: (proceedsUsd: number) => {
        const { simulatedBalance } = get()
        const newBalance = Math.max(0.01, simulatedBalance + proceedsUsd)
        set({ simulatedBalance: newBalance })
        get().addSnapshot(newBalance)
      },

      syncSimulatedBalance: (realBalance: number) => {
        if (realBalance > 0) {
          set({ simulatedBalance: realBalance })
        }
      },
    }),
    {
      name: 'alphapolybot-balance-history',
      version: 2,
      migrate: (persisted: unknown, version: number) => {
        const state = persisted as Record<string, unknown>
        if (version < 2) {
          return { ...state, simulatedBalance: (state.initialBalance as number) || 0 }
        }
        return state
      },
    }
  )
)
