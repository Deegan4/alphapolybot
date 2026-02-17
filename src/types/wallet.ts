// ==========================================
// POLYMARKET US — WALLET & AUTH TYPES
// ==========================================

export interface WalletState {
  /** PM US API Key ID (UUID from developer portal) */
  keyId: string | null
  /** Whether credentials have been validated */
  isConnected: boolean
  isConnecting: boolean
  /** USD cash balance */
  balance: number
  /** Available buying power (balance minus open orders) */
  buyingPower: number
  lastSync: Date | null
  error: string | null
}

/**
 * Polymarket US Ed25519 API credentials.
 * Created at polymarket.us/developer.
 */
export interface PMUSCredentials {
  keyId: string      // UUID — X-PM-Access-Key header
  secretKey: string  // Base64-encoded Ed25519 private key
}

/**
 * Multi-wallet registry entry (persisted in settingsStore).
 * Secret key is stored separately in secureStorage, never in Zustand.
 */
export interface WalletEntry {
  /** Unique wallet ID (crypto.randomUUID()) */
  id: string
  /** User-facing label (e.g., "Main", "Trading Bot #2") */
  label: string
  /** PM US API Key ID (UUID) — maps to credentials */
  keyId: string
}
