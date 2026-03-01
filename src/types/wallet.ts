// ==========================================
// POLYMARKET — WALLET & AUTH TYPES
// ==========================================

export interface WalletState {
  /** Wallet address (signer EOA) */
  address: string | null
  /** Whether wallet and CLOB credentials are validated */
  isConnected: boolean
  isConnecting: boolean
  /** USD cash balance */
  balance: number
  /** Available buying power (balance minus open orders) */
  buyingPower: number
  /** Computed Polymarket proxy address */
  proxyAddress: string | null
  lastSync: Date | null
  error: string | null
}

/**
 * CLOB API credentials (HMAC-SHA256).
 * Derived at runtime from wallet private key via /auth/derive-api-key.
 */
export interface CLOBCredentials {
  key: string         // API key
  secret: string      // HMAC secret (base64)
  passphrase: string  // passphrase
}

/**
 * Multi-wallet registry entry (persisted in settingsStore).
 */
export interface WalletEntry {
  /** Unique wallet ID (crypto.randomUUID()) */
  id: string
  /** User-facing label (e.g., "Main", "Trading Bot #2") */
  label: string
  /** Wallet address (signer EOA) */
  address: string
}
