import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { WalletState } from '@/types'
import { walletService } from '@/services/wallet'
import { shouldPollBalanceRest } from '@/services/wallet/WalletService'

interface WalletStore extends WalletState {
  // Actions
  connect: (keyId: string, secretKey: string) => Promise<boolean>
  disconnect: () => void
  syncBalances: () => Promise<void>
  startPolling: () => void
  stopPolling: () => void
}

// Module-level polling state (not persisted, not in store).
// The tick runs every 15s but only calls REST when the private WebSocket is not
// pushing balances, or every 2 min as a safety net while it is.
const BALANCE_POLL_MS = 15_000
let pollIntervalId: ReturnType<typeof setInterval> | null = null
let lastRestSyncMs: number | null = null
let unsubLiveBalance: (() => void) | null = null

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
            unsubLiveBalance?.()
            unsubLiveBalance = userChannelService.onBalance((balance, buyingPower) => {
              walletService.applyLiveBalance(balance, buyingPower)
            })
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
        unsubLiveBalance?.()
        unsubLiveBalance = null
        lastRestSyncMs = null
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
        const sync = async () => {
          const { userChannelService } = await import('@/services/realtime')
          const now = Date.now()
          if (!shouldPollBalanceRest({ wsHasBalance: userChannelService.getLatestBalance() !== null, lastRestSyncMs, nowMs: now })) return
          lastRestSyncMs = now
          await useWalletStore.getState().syncBalances()
        }
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
