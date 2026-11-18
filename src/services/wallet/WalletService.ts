/**
 * WalletService — Polymarket US Credential Manager
 *
 * Thin wrapper for PM US Ed25519 API credentials + balance sync.
 * No blockchain interaction — PM US uses centralized clearing.
 */

import type { WalletState, WalletEntry } from '@/types'
import { polymarketUSClient } from '@/services/api'

/** REST balance fallback interval while the private feed is pushing balances */
export const BALANCE_REST_FALLBACK_MS = 2 * 60_000

/**
 * Whether the periodic balance sync should call REST. The private WebSocket
 * pushes a snapshot on subscribe and an update on every change, so while it
 * is live REST is only a slow safety net (catches a silently stalled feed).
 */
export function shouldPollBalanceRest(opts: {
  wsHasBalance: boolean
  lastRestSyncMs: number | null
  nowMs: number
  fallbackMs?: number
}): boolean {
  if (!opts.wsHasBalance || opts.lastRestSyncMs == null) return true
  return opts.nowMs - opts.lastRestSyncMs >= (opts.fallbackMs ?? BALANCE_REST_FALLBACK_MS)
}

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

  /** Apply a balance pushed by the private WebSocket (no REST call) */
  applyLiveBalance(balance: number, buyingPower: number): void {
    if (!this.state.isConnected) return
    if (!Number.isFinite(balance) || !Number.isFinite(buyingPower)) return
    this.updateState({ balance, buyingPower, lastSync: new Date() })
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
      const secretKey = await secureStorage.get<string>(`wallet-secret-${wallet.id}`, true)
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
