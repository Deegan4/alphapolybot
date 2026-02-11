import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { WalletState } from '@/types'
import { walletService } from '@/services/wallet'

interface WalletStore extends WalletState {
  // Actions
  connect: (seedPhrase: string) => Promise<boolean>
  disconnect: () => void
  setProxyAddress: (proxy: string | null) => void
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
      proxyAddress: null,
      balance: 0,
      usdcBalance: 0,
      usdcBridgedBalance: 0,
      usdcNativeBalance: 0,
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
          proxyAddress: null,
          balance: 0,
          usdcBalance: 0,
          usdcBridgedBalance: 0,
          usdcNativeBalance: 0,
          isConnected: false,
          isConnecting: false,
          chainId: null,
          lastSync: null,
          approvals: { usdc: false, ctf: false },
          error: null,
        })
      },

      setProxyAddress: (proxy: string | null) => {
        walletService.setProxyAddress(proxy)
        set({ proxyAddress: proxy })
      },

      syncBalances: async () => {
        await walletService.syncBalances()
        const state = walletService.getState()
        set({
          balance: state.balance,
          usdcBalance: state.usdcBalance,
          usdcBridgedBalance: state.usdcBridgedBalance,
          usdcNativeBalance: state.usdcNativeBalance,
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
        const result = await walletService.ensureApprovals()
        const state = walletService.getState()
        set({ approvals: state.approvals })
        return result.success
      },
    }),
    {
      name: 'alphapolybot-wallet',
      partialize: (state) => ({
        // Only persist non-sensitive data
        address: state.address,
        proxyAddress: state.proxyAddress,
        chainId: state.chainId,
      }),
    }
  )
)

// Subscribe wallet service to store updates
walletService.subscribe((state) => {
  useWalletStore.setState(state)
})
