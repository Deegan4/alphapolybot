import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { WalletState } from '@/types'
import { walletService } from '@/services/wallet'

interface WalletStore extends WalletState {
  // Actions
  connect: (seedPhrase: string) => Promise<boolean>
  disconnect: () => void
  syncBalances: () => Promise<void>
  checkApprovals: () => Promise<void>
  approveUSDC: () => Promise<boolean>
  approveCTF: () => Promise<boolean>
  ensureApprovals: () => Promise<boolean>
}

export const useWalletStore = create<WalletStore>()(
  persist(
    (set) => ({
      // Initial state
      address: null,
      balance: 0,
      usdcBalance: 0,
      isConnected: false,
      isConnecting: false,
      chainId: null,
      lastSync: null,
      approvals: { usdc: false, ctf: false },
      error: null,

      // Actions
      connect: async (seedPhrase: string) => {
        set({ isConnecting: true, error: null })
        
        const success = await walletService.connect(seedPhrase)
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
          balance: 0,
          usdcBalance: 0,
          isConnected: false,
          isConnecting: false,
          chainId: null,
          lastSync: null,
          approvals: { usdc: false, ctf: false },
          error: null,
        })
      },

      syncBalances: async () => {
        await walletService.syncBalances()
        const state = walletService.getState()
        set({
          balance: state.balance,
          usdcBalance: state.usdcBalance,
          lastSync: state.lastSync,
        })
      },

      checkApprovals: async () => {
        const approvals = await walletService.checkApprovals()
        set({ approvals })
      },

      approveUSDC: async () => {
        const result = await walletService.approveUSDC()
        if (result.success) {
          const state = walletService.getState()
          set({ approvals: state.approvals })
        }
        return result.success
      },

      approveCTF: async () => {
        const result = await walletService.approveCTF()
        if (result.success) {
          const state = walletService.getState()
          set({ approvals: state.approvals })
        }
        return result.success
      },

      ensureApprovals: async () => {
        const success = await walletService.ensureApprovals()
        const state = walletService.getState()
        set({ approvals: state.approvals })
        return success
      },
    }),
    {
      name: 'alphapolybot-wallet',
      partialize: (state) => ({
        // Only persist non-sensitive data
        address: state.address,
        chainId: state.chainId,
      }),
    }
  )
)

// Subscribe wallet service to store updates
walletService.subscribe((state) => {
  useWalletStore.setState(state)
})
