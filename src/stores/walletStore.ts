import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { WalletState } from '@/types'

// Lazy-load walletService to avoid pulling ethers.js (~381kB) into the main bundle.
// walletService is only needed when the user actually connects/disconnects a wallet.
let _walletService: Awaited<typeof import('@/services/wallet')>['walletService'] | null = null
let _subscribed = false

async function getWalletService() {
  if (!_walletService) {
    const mod = await import('@/services/wallet')
    _walletService = mod.walletService
    // Subscribe once to push wallet state changes into the Zustand store
    if (!_subscribed) {
      _subscribed = true
      _walletService.subscribe((state) => {
        useWalletStore.setState(state)
      })
    }
  }
  return _walletService
}

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

        const ws = await getWalletService()
        const success = await ws.connectAuto(input)
        const state = ws.getState()

        set({
          ...state,
          isConnecting: false,
        })

        return success
      },

      disconnect: () => {
        // Synchronous disconnect — walletService may not be loaded yet if never connected
        if (_walletService) {
          _walletService.disconnect()
        }
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
        // Don't lazy-load WalletService if wallet isn't connected — avoids
        // pulling ethers.js and triggering subscription before wallet is ready
        if (!useWalletStore.getState().isConnected) return
        const ws = await getWalletService()
        await ws.syncBalances()
        const state = ws.getState()
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
      version: 1,
      partialize: (state) => ({
        // Persist address AND isConnected so hydration doesn't reset connection state
        address: state.address,
        isConnected: state.isConnected,
      }),
      // After hydration: if we have a persisted address + isConnected but WalletService
      // isn't loaded yet, the state is consistent for auto-reconnect in App.tsx.
      // If address was cleared (disconnect), isConnected will also be false.
      migrate: (persisted: unknown, version: number) => {
        if (version === 0) {
          // v0 only had address — infer isConnected from presence of address
          const old = persisted as { address?: string | null }
          return { address: old?.address ?? null, isConnected: !!old?.address }
        }
        return persisted as { address: string | null; isConnected: boolean }
      },
    }
  )
)
