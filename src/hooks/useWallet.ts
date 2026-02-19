import { useWalletStore } from '@/stores/walletStore'

/**
 * Custom hook for wallet operations
 * Provides a convenient API for wallet-related functionality
 */
export function useWallet() {
  const {
    keyId,
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
    keyId,
    balance,
    buyingPower,
    isConnected,
    isConnecting,
    lastSync,
    error,

    // Derived state
    shortKeyId: keyId ? `${keyId.slice(0, 8)}...` : null,

    // Actions
    connect,
    disconnect,
    syncBalances,
  }
}
