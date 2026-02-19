/**
 * WalletService — Polymarket US Credential Manager
 *
 * Thin wrapper for PM US Ed25519 API credentials + balance sync.
 * No blockchain interaction — PM US uses centralized clearing.
 */

import type { WalletState, WalletEntry } from '@/types'
import { polymarketUSClient } from '@/services/api'

export class WalletService {
  private state: WalletState = {
    keyId: null,
    isConnected: false,
    isConnecting: false,
    balance: 0,
    buyingPower: 0,
    lastSync: null,
    error: null,
  }

  private listeners = new Set<(state: WalletState) => void>()

  subscribe(listener: (state: WalletState) => void): () => void {
    this.listeners.add(listener)
    listener(this.state)
    return () => this.listeners.delete(listener)
  }

  private notifyListeners(): void {
    this.listeners.forEach(listener => listener(this.state))
  }

  private updateState(updates: Partial<WalletState>): void {
    this.state = { ...this.state, ...updates }
    this.notifyListeners()
  }

  getState(): WalletState {
    return this.state
  }

  /**
   * Connect using PM US Ed25519 API credentials.
   * Validates by calling getBalances().
   */
  async connect(keyId: string, secretKey: string): Promise<boolean> {
    this.updateState({ isConnecting: true, error: null })

    try {
      // Set credentials on the API client
      polymarketUSClient.setCredentials(keyId, secretKey)

      // Validate credentials by fetching balance
      const validation = await polymarketUSClient.validateCredentials()
      if (!validation.valid) {
        throw new Error(validation.error || 'Invalid credentials')
      }

      console.log(`[WalletService] Connected with key ID: ${keyId.slice(0, 8)}...`)

      // Fetch initial balances
      const balances = await polymarketUSClient.getBalances()

      this.updateState({
        keyId,
        isConnected: true,
        isConnecting: false,
        balance: balances.balance,
        buyingPower: balances.buyingPower,
        lastSync: new Date(),
      })

      return true
    } catch (error) {
      console.error('[WalletService] Failed to connect:', error)
      polymarketUSClient.setCredentials('', '') // Clear bad creds
      this.updateState({
        isConnecting: false,
        isConnected: false,
        error: error instanceof Error ? error.message : 'Failed to connect',
      })
      return false
    }
  }

  disconnect(): void {
    polymarketUSClient.setCredentials('', '')
    this.updateState({
      keyId: null,
      isConnected: false,
      isConnecting: false,
      balance: 0,
      buyingPower: 0,
      lastSync: null,
      error: null,
    })
  }

  /**
   * Sync balances from PM US API.
   */
  async syncBalances(): Promise<void> {
    if (!this.state.isConnected || !polymarketUSClient.hasCredentials()) {
      return
    }

    try {
      const balances = await polymarketUSClient.getBalances()
      this.updateState({
        balance: balances.balance,
        buyingPower: balances.buyingPower,
        lastSync: new Date(),
      })
    } catch (error) {
      console.error('[WalletService] Failed to sync balances:', error instanceof Error ? error.message : error)
    }
  }

  /**
   * Switch to a different wallet from the registry.
   * Loads secret key from secureStorage, disconnects current, connects new.
   */
  async switchWallet(wallet: WalletEntry): Promise<boolean> {
    try {
      // Load secret from secureStorage
      const { secureStorage } = await import('@/utils/secureStorage')
      const secretKey = await secureStorage.get<string>(`wallet-secret-${wallet.id}`)
      if (!secretKey) {
        this.updateState({ error: `No stored credentials for wallet "${wallet.label}"` })
        return false
      }

      // Disconnect current wallet (if any)
      this.disconnect()

      // Connect with the new wallet's credentials
      return this.connect(wallet.keyId, secretKey)
    } catch (error) {
      console.error('[WalletService] Failed to switch wallet:', error)
      this.updateState({
        error: error instanceof Error ? error.message : 'Failed to switch wallet',
      })
      return false
    }
  }

  isConnected(): boolean {
    return this.state.isConnected
  }

  getBalance(): number {
    return this.state.balance
  }

  getBuyingPower(): number {
    return this.state.buyingPower
  }
}

export const walletService = new WalletService()
