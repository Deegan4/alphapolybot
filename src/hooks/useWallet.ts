import { useWalletStore } from '@/stores/walletStore'

/**
 * Custom hook for wallet operations
 * Provides a convenient API for wallet-related functionality
 */
export function useWallet() {
  const {
    address,
    balance,
    usdcBalance,
    isConnected,
    isConnecting,
    chainId,
    lastSync,
    approvals,
    error,
    connect,
    disconnect,
    syncBalances,
    checkApprovals,
    approveUSDC,
    approveCTF,
    ensureApprovals,
  } = useWalletStore()

  return {
    // State
    address,
    balance,
    usdcBalance,
    isConnected,
    isConnecting,
    chainId,
    lastSync,
    approvals,
    error,
    
    // Derived state
    shortAddress: address ? `${address.slice(0, 6)}...${address.slice(-4)}` : null,
    hasApprovals: approvals.usdc && approvals.ctf,
    
    // Actions
    connect,
    disconnect,
    syncBalances,
    checkApprovals,
    approveUSDC,
    approveCTF,
    ensureApprovals,
  }
}
