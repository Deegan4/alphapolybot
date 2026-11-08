import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { WalletState } from '@/types'
import { walletService } from '@/services/wallet'

interface WalletStore extends WalletState {
  // Actions
  connect: (keyId: string, secretKey: string) => Promise<boolean>
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
    (set, get) => ({
      // Initial state
      keyId: null,
      isConnected: false,
      isConnecting: false,
      balance: 0,
      buyingPower: 0,
      lastSync: null,
      error: null,

      // Actions
      connect: async (keyId: string, secretKey: string) => {
        set({ isConnecting: true, error: null })

        const success = await walletService.connect(keyId, secretKey)
        const state = walletService.getState()

        set({
          ...state,
          isConnecting: false,
        })

        if (success) {
          // Post-connect wiring shared by Settings → Connect and App auto-reconnect:
          // balance polling (services read balance from any route) and the private
          // user-channel WebSocket (push-based fill/cancel events for GTD tracking + PLM).
          get().startPolling()
          import('@/services/realtime').then(({ userChannelService }) => {
            userChannelService.connect().then(connected => {
              if (connected) {
                console.log('[WalletStore] User channel connected — push-based order updates active')
              }
            })
          }).catch(() => {})
        }

        return success
      },

      disconnect: () => {
        get().stopPolling()
        import('@/services/realtime')
          .then(({ userChannelService }) => userChannelService.disconnect())
          .catch(() => {})
        walletService.disconnect()
        set({
          keyId: null,
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
        // Only persist non-sensitive data (keyId is not secret, but secretKey is never stored)
        keyId: state.keyId,
      }),
    }
  )
)

// Subscribe wallet service to store updates
walletService.subscribe((state) => {
  useWalletStore.setState(state)
})
