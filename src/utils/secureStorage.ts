/**
 * Secure Storage Utility
 * Provides AES-GCM encrypted local storage for sensitive data (API keys, credentials)
 *
 * Uses Web Crypto API (SubtleCrypto) for real encryption:
 * - AES-GCM with 256-bit keys (authenticated encryption — detects tampering)
 * - PBKDF2 key derivation from passphrase
 * - Random 12-byte IV per encryption (prevents ciphertext analysis)
 *
 * Note: encrypt/decrypt are async (Web Crypto requirement).
 * set() and get() are async. Callers must await.
 */

import {
  getDeviceKey,
  encryptWithKey,
  decryptWithKey,
  looksLikePlaintextJSON,
} from './deviceKey'

const STORAGE_PREFIX = 'alphapolybot_'
const SALT = 'alphapolybot-v2-salt' // Static salt — acceptable for localStorage obfuscation

interface StorageOptions {
  encrypt?: boolean
  expiry?: number // milliseconds
}

interface StoredItem<T> {
  value: T
  timestamp: number
  expiry?: number
  v?: 2 // Version tag to distinguish AES-GCM from legacy XOR
}

class SecureStorage {
  private cryptoKey: CryptoKey | null = null
  private rawKey: string | null = null

  /**
   * Initialize storage with optional encryption passphrase.
   * Derives an AES-256-GCM key via PBKDF2.
   */
  async initialize(passphrase?: string): Promise<void> {
    this.rawKey = passphrase || null
    if (!passphrase) {
      this.cryptoKey = null
      return
    }

    // Derive AES-256 key from passphrase via PBKDF2
    const encoder = new TextEncoder()
    const keyMaterial = await crypto.subtle.importKey(
      'raw',
      encoder.encode(passphrase),
      'PBKDF2',
      false,
      ['deriveKey']
    )

    this.cryptoKey = await crypto.subtle.deriveKey(
      {
        name: 'PBKDF2',
        salt: encoder.encode(SALT),
        iterations: 100_000,
        hash: 'SHA-256',
      },
      keyMaterial,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    )
  }

  /**
   * Initialize with this device's non-extractable key from the keyring.
   *
   * This is what the app calls at startup. Without it `cryptoKey` stays null
   * and every `set(..., { encrypt: true })` silently writes plaintext — which
   * is exactly the bug this exists to close. Returns whether encryption is
   * actually available; false means the caller is storing in the clear.
   */
  async initializeDeviceKey(): Promise<boolean> {
    const key = await getDeviceKey()
    if (!key) return false
    this.cryptoKey = key
    this.rawKey = null // device key path has no passphrase, so no legacy XOR
    return true
  }

  /**
   * Store a value in local storage (optionally encrypted with AES-GCM)
   */
  async set<T>(key: string, value: T, options: StorageOptions = {}): Promise<void> {
    const storageKey = STORAGE_PREFIX + key
    const item: StoredItem<T> = {
      value,
      timestamp: Date.now(),
      expiry: options.expiry,
      v: 2,
    }

    const serialized = JSON.stringify(item)
    const toStore = options.encrypt && this.cryptoKey
      ? await this.encrypt(serialized)
      : serialized

    try {
      localStorage.setItem(storageKey, toStore)
    } catch (error) {
      console.error('Failed to store item:', error)
      // Try to clear old items if storage is full
      await this.clearExpired()
      localStorage.setItem(storageKey, toStore)
    }
  }

  /**
   * Retrieve a value from local storage (optionally decrypted)
   * Handles both legacy XOR and new AES-GCM formats transparently.
   */
  async get<T>(key: string, encrypted = false): Promise<T | null> {
    const storageKey = STORAGE_PREFIX + key

    try {
      const stored = localStorage.getItem(storageKey)
      if (!stored) return null

      // Detect the format rather than trusting the caller's `encrypted` flag —
      // entries written before encryption was wired up are plaintext, and a
      // wrong flag used to mean either a crash or a silent miss.
      let serialized: string
      let migrateFrom: 'plaintext' | 'xor' | null = null

      if (looksLikePlaintextJSON(stored)) {
        serialized = stored
        if (this.cryptoKey) migrateFrom = 'plaintext'
      } else if (this.cryptoKey) {
        try {
          serialized = await this.decrypt(stored)
        } catch {
          // Not AES-GCM — try legacy XOR (only possible on the passphrase path)
          serialized = this.decryptLegacyXOR(stored)
          migrateFrom = 'xor'
        }
      } else {
        // Ciphertext but no key: the keyring is unavailable this session.
        // Report the miss instead of handing back unparseable bytes.
        console.warn(`[SecureStorage] "${key}" is encrypted but no device key is available`)
        return null
      }

      const item: StoredItem<T> = JSON.parse(serialized)

      if (migrateFrom) {
        await this.set(key, item.value, { encrypt: true, expiry: item.expiry })
        console.log(`[SecureStorage] Migrated "${key}" from ${migrateFrom} to AES-GCM`)
      }

      // Check expiry
      if (item.expiry && Date.now() - item.timestamp > item.expiry) {
        this.remove(key)
        return null
      }

      return item.value
    } catch (error) {
      console.error('Failed to retrieve item:', error)
      return null
    }
  }

  /**
   * Remove a value from local storage
   */
  remove(key: string): void {
    const storageKey = STORAGE_PREFIX + key
    localStorage.removeItem(storageKey)
  }

  /**
   * Clear all stored data
   */
  clear(): void {
    const keys = Object.keys(localStorage).filter(key =>
      key.startsWith(STORAGE_PREFIX)
    )
    keys.forEach(key => localStorage.removeItem(key))
  }

  /**
   * Clear expired items.
   *
   * Only removes entries it can actually read and prove are expired. An entry
   * it cannot parse is left alone — with encryption on, "unparseable" is the
   * normal state of every ciphertext, and the old behaviour of deleting those
   * would have wiped the wallet secrets this store exists to hold.
   */
  async clearExpired(): Promise<void> {
    const keys = Object.keys(localStorage).filter(key =>
      key.startsWith(STORAGE_PREFIX)
    )

    for (const key of keys) {
      const stored = localStorage.getItem(key)
      if (!stored) continue

      let serialized: string
      if (looksLikePlaintextJSON(stored)) {
        serialized = stored
      } else if (this.cryptoKey) {
        try {
          serialized = await this.decrypt(stored)
        } catch {
          continue // can't read it — never guess, never delete
        }
      } else {
        continue
      }

      try {
        const item = JSON.parse(serialized) as StoredItem<unknown>
        if (item.expiry && Date.now() - item.timestamp > item.expiry) {
          localStorage.removeItem(key)
        }
      } catch {
        continue
      }
    }
  }

  /**
   * Get all keys with prefix
   */
  keys(): string[] {
    return Object.keys(localStorage)
      .filter(key => key.startsWith(STORAGE_PREFIX))
      .map(key => key.replace(STORAGE_PREFIX, ''))
  }

  /**
   * Check if encryption is available (initialized with a passphrase)
   */
  get isEncryptionReady(): boolean {
    return this.cryptoKey !== null
  }

  // ==========================================
  // AES-GCM ENCRYPTION (Web Crypto API)
  // ==========================================

  /**
   * Encrypt plaintext with AES-256-GCM.
   * Format: base64(IV_12bytes + ciphertext + authTag_16bytes)
   */
  private async encrypt(text: string): Promise<string> {
    if (!this.cryptoKey) return text
    return encryptWithKey(this.cryptoKey, text)
  }

  /**
   * Decrypt AES-256-GCM ciphertext.
   * Throws on tampered/invalid data (authenticated encryption).
   */
  private async decrypt(encoded: string): Promise<string> {
    if (!this.cryptoKey) return encoded
    return decryptWithKey(this.cryptoKey, encoded)
  }

  // ==========================================
  // LEGACY XOR DECRYPTION (migration only)
  // ==========================================

  /**
   * Decrypt legacy XOR-encoded data (from v1).
   * Used only for transparent migration to AES-GCM.
   * Will be removed in a future version.
   */
  private decryptLegacyXOR(encoded: string): string {
    if (!this.rawKey) return encoded

    try {
      const text = atob(encoded)
      const key = this.rawKey
      let result = ''

      for (let i = 0; i < text.length; i++) {
        result += String.fromCharCode(
          text.charCodeAt(i) ^ key.charCodeAt(i % key.length)
        )
      }

      // Validate that result is valid JSON (sanity check)
      JSON.parse(result)
      return result
    } catch {
      // Not valid XOR-encoded data — rethrow to caller
      throw new Error('Not legacy XOR format')
    }
  }
}

// Export singleton instance
export const secureStorage = new SecureStorage()

// Also export class for testing
export { SecureStorage }
