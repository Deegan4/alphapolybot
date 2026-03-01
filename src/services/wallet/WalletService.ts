/**
 * WalletService — Polymarket International Credential Manager
 *
 * Manages wallet connection to the international CLOB.
 * Auth flow: Wallet credential (seed phrase or private key) → ethers Wallet → derive HMAC API keys via CLOB.
 */

import type { WalletState } from '@/types'
import { polymarketClient } from '@/services/api'
import { clobClient } from '@/services/api/CLOBClient'
import { ethers } from 'ethers'

export class WalletService {
  private state: WalletState = {
    address: null,
    isConnected: false,
    isConnecting: false,
    balance: 0,
    buyingPower: 0,
    proxyAddress: null,
    lastSync: null,
    error: null,
  }

  private wallet: ethers.HDNodeWallet | ethers.Wallet | null = null
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
   * Connect using a wallet seed phrase.
   * Derives CLOB API credentials from the wallet's private key.
   */
  async connect(seedPhrase: string): Promise<boolean> {
    this.updateState({ isConnecting: true, error: null })

    try {
      // Validate mnemonic word count before ethers (gives clear error vs cryptic "invalid mnemonic length")
      const words = seedPhrase.trim().split(/\s+/)
      if (words.length !== 12 && words.length !== 24) {
        throw new Error(`Seed phrase must be 12 or 24 words (got ${words.length}).`)
      }

      // Create wallet from seed phrase
      const wallet = ethers.Wallet.fromPhrase(seedPhrase)
      this.wallet = wallet
      const address = await wallet.getAddress()

      // Compute proxy address
      const proxyAddress = clobClient.computeProxyAddress(address)

      // Initialize CLOB client with wallet
      const result = await polymarketClient.initFromWallet(wallet)
      if (!result.valid) {
        throw new Error(result.error || 'Failed to authenticate with CLOB')
      }

      console.log(`[WalletService] Connected: ${address.slice(0, 8)}... proxy: ${proxyAddress.slice(0, 8)}...`)

      // Fetch initial balances
      const balances = await polymarketClient.getBalances()

      this.updateState({
        address,
        proxyAddress,
        isConnected: true,
        isConnecting: false,
        balance: balances.balance,
        buyingPower: balances.buyingPower,
        lastSync: new Date(),
      })

      return true
    } catch (error) {
      console.error('[WalletService] Failed to connect:', error)
      this.wallet = null
      this.updateState({
        isConnecting: false,
        isConnected: false,
        error: error instanceof Error ? error.message : 'Failed to connect',
      })
      return false
    }
  }

  /**
   * Connect using an already-instantiated ethers Wallet.
   * Used when wallet is created from private key rather than seed phrase.
   */
  async connectWallet(wallet: ethers.HDNodeWallet | ethers.Wallet): Promise<boolean> {
    this.updateState({ isConnecting: true, error: null })

    try {
      this.wallet = wallet
      const address = await wallet.getAddress()
      const proxyAddress = clobClient.computeProxyAddress(address)

      const result = await polymarketClient.initFromWallet(wallet)
      if (!result.valid) {
        throw new Error(result.error || 'Failed to authenticate with CLOB')
      }

      const balances = await polymarketClient.getBalances()

      this.updateState({
        address,
        proxyAddress,
        isConnected: true,
        isConnecting: false,
        balance: balances.balance,
        buyingPower: balances.buyingPower,
        lastSync: new Date(),
      })

      return true
    } catch (error) {
      console.error('[WalletService] Failed to connect:', error)
      this.wallet = null
      this.updateState({
        isConnecting: false,
        isConnected: false,
        error: error instanceof Error ? error.message : 'Failed to connect',
      })
      return false
    }
  }

  /** Returns true if the input looks like a hex private key (64 hex chars, with or without 0x prefix). */
  static isPrivateKey(input: string): boolean {
    const trimmed = input.trim()
    return /^0x[0-9a-fA-F]{64}$/.test(trimmed) || /^[0-9a-fA-F]{64}$/.test(trimmed)
  }

  /**
   * Connect using a raw hex private key.
   * Creates an ethers Wallet and delegates to connectWallet().
   */
  async connectFromPrivateKey(key: string): Promise<boolean> {
    const trimmed = key.trim()
    const hexKey = trimmed.startsWith('0x') ? trimmed : `0x${trimmed}`

    if (!/^0x[0-9a-fA-F]{64}$/.test(hexKey)) {
      this.updateState({ isConnecting: false, error: 'Invalid private key — expected 64 hex characters' })
      return false
    }

    const wallet = new ethers.Wallet(hexKey)
    return this.connectWallet(wallet)
  }

  /**
   * Smart auto-detect: accepts either a seed phrase (12/24 words) or a private key (hex).
   * Routes to the appropriate connection method.
   */
  async connectAuto(input: string): Promise<boolean> {
    const trimmed = input.trim()
    if (!trimmed) {
      this.updateState({ isConnecting: false, error: 'Wallet credential is required' })
      return false
    }

    if (WalletService.isPrivateKey(trimmed)) {
      return this.connectFromPrivateKey(trimmed)
    }

    return this.connect(trimmed)
  }

  disconnect(): void {
    this.wallet = null
    this.updateState({
      address: null,
      proxyAddress: null,
      isConnected: false,
      isConnecting: false,
      balance: 0,
      buyingPower: 0,
      lastSync: null,
      error: null,
    })
  }

  /** Sync balances from CLOB API */
  async syncBalances(): Promise<void> {
    if (!this.state.isConnected || !polymarketClient.hasCredentials()) {
      return
    }

    try {
      const balances = await polymarketClient.getBalances()
      this.updateState({
        balance: balances.balance,
        buyingPower: balances.buyingPower,
        lastSync: new Date(),
      })
    } catch (error) {
      console.error('[WalletService] Failed to sync balances:', error instanceof Error ? error.message : error)
    }
  }

  getWallet(): ethers.HDNodeWallet | ethers.Wallet | null {
    return this.wallet
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
