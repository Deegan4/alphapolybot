import { useWalletStore } from '@/stores/walletStore'

/**
 * Custom hook for wallet operations
 * Provides a convenient API for wallet-related functionality
 */
export function useWallet() {
  const {
    address,
    balance,
    buyingPower,
    isConnected,
    isConnecting,
    lastSync,
    error,
    connect,
    disconnect,
    syncBalances,
  } = useWalletStore()

  return {
    // State
    address,
    balance,
    buyingPower,
    isConnected,
    isConnecting,
    lastSync,
    error,

    // Derived state
    shortAddress: address ? `${address.slice(0, 6)}...${address.slice(-4)}` : null,

    // Actions
    connect,
    disconnect,
    syncBalances,
  }
}
