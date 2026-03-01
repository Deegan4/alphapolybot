import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { WalletState } from '@/types'
import { walletService } from '@/services/wallet'

interface WalletStore extends WalletState {
  // Actions
  connect: (seedPhrase: string) => Promise<boolean>
  disconnect: () => void
  syncBalances: () => Promise<void>
  startPolling: () => void
  stopPolling: () => void
}

// Module-level polling state (not persisted, not in store)
const BALANCE_POLL_MS = 15_000
let pollIntervalId: ReturnType<typeof setInterval> | null = null

export const useWalletStore = create<WalletStore>()(
  persist(
    (set) => ({
      // Initial state
      address: null,
      isConnected: false,
      isConnecting: false,
      balance: 0,
      buyingPower: 0,
      proxyAddress: null,
      lastSync: null,
      error: null,

      // Actions
      connect: async (input: string) => {
        set({ isConnecting: true, error: null })

        const success = await walletService.connectAuto(input)
        const state = walletService.getState()

        set({
          ...state,
          isConnecting: false,
        })

        return success
      },

      disconnect: () => {
        walletService.disconnect()
        set({
          address: null,
          proxyAddress: null,
          isConnected: false,
          isConnecting: false,
          balance: 0,
          buyingPower: 0,
          lastSync: null,
          error: null,
        })
      },

      syncBalances: async () => {
        await walletService.syncBalances()
        const state = walletService.getState()
        set({
          balance: state.balance,
          buyingPower: state.buyingPower,
          lastSync: state.lastSync,
        })
      },

      startPolling: () => {
        if (pollIntervalId !== null) return          // idempotent
        const sync = () => useWalletStore.getState().syncBalances()
        sync()                                        // fire immediately
        pollIntervalId = setInterval(sync, BALANCE_POLL_MS)
      },

      stopPolling: () => {
        if (pollIntervalId !== null) {
          clearInterval(pollIntervalId)
          pollIntervalId = null
        }
      },
    }),
    {
      name: 'alphapolybot-wallet',
      partialize: (state) => ({
        // Only persist the wallet address (seed phrase is in .env, not stored)
        address: state.address,
      }),
    }
  )
)

// Subscribe wallet service to store updates
walletService.subscribe((state) => {
  useWalletStore.setState(state)
})
