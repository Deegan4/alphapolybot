/**
 * Secure Storage Utility
 * Provides encrypted local storage for sensitive data
 */

const STORAGE_PREFIX = 'alphapolybot_'

interface StorageOptions {
  encrypt?: boolean
  expiry?: number // milliseconds
}

interface StoredItem<T> {
  value: T
  timestamp: number
  expiry?: number
}

class SecureStorage {
  private encryptionKey: string | null = null

  /**
   * Initialize storage with optional encryption key
   */
  initialize(key?: string): void {
    this.encryptionKey = key || null
  }

  /**
   * Store a value in local storage
   */
  set<T>(key: string, value: T, options: StorageOptions = {}): void {
    const storageKey = STORAGE_PREFIX + key
    const item: StoredItem<T> = {
      value,
      timestamp: Date.now(),
      expiry: options.expiry,
    }

    const serialized = JSON.stringify(item)
    const toStore = options.encrypt && this.encryptionKey 
      ? this.encrypt(serialized) 
      : serialized

    try {
      localStorage.setItem(storageKey, toStore)
    } catch (error) {
      console.error('Failed to store item:', error)
      // Try to clear old items if storage is full
      this.clearExpired()
      localStorage.setItem(storageKey, toStore)
    }
  }

  /**
   * Retrieve a value from local storage
   */
  get<T>(key: string, encrypted = false): T | null {
    const storageKey = STORAGE_PREFIX + key

    try {
      const stored = localStorage.getItem(storageKey)
      if (!stored) return null

      const serialized = encrypted && this.encryptionKey 
        ? this.decrypt(stored) 
        : stored
      
      const item: StoredItem<T> = JSON.parse(serialized)

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
   * Clear expired items
   */
  clearExpired(): void {
    const keys = Object.keys(localStorage).filter(key => 
      key.startsWith(STORAGE_PREFIX)
    )

    keys.forEach(key => {
      try {
        const stored = localStorage.getItem(key)
        if (stored) {
          const item = JSON.parse(stored) as StoredItem<unknown>
          if (item.expiry && Date.now() - item.timestamp > item.expiry) {
            localStorage.removeItem(key)
          }
        }
      } catch {
        // If we can't parse it, remove it
        localStorage.removeItem(key)
      }
    })
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
   * Simple XOR encryption (for basic obfuscation)
   * Note: This is NOT cryptographically secure - use Web Crypto API for real encryption
   */
  private encrypt(text: string): string {
    if (!this.encryptionKey) return text
    
    const key = this.encryptionKey
    let result = ''
    
    for (let i = 0; i < text.length; i++) {
      result += String.fromCharCode(
        text.charCodeAt(i) ^ key.charCodeAt(i % key.length)
      )
    }
    
    return btoa(result)
  }

  private decrypt(encoded: string): string {
    if (!this.encryptionKey) return encoded
    
    const text = atob(encoded)
    const key = this.encryptionKey
    let result = ''
    
    for (let i = 0; i < text.length; i++) {
      result += String.fromCharCode(
        text.charCodeAt(i) ^ key.charCodeAt(i % key.length)
      )
    }
    
    return result
  }
}

// Export singleton instance
export const secureStorage = new SecureStorage()

// Also export class for testing
export { SecureStorage }
