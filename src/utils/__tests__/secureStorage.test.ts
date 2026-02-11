import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { SecureStorage } from '../secureStorage'

/**
 * jsdom in Vitest sometimes doesn't expose localStorage as a proper global.
 * We use a Proxy-based mock so Object.keys(localStorage) returns data keys
 * (SecureStorage uses this pattern in keys() and clearExpired()).
 */
const store: Record<string, string> = {}

function clearStore() {
  for (const k of Object.keys(store)) delete store[k]
}

/**
 * Proxy-based localStorage mock.
 * - getItem/setItem/removeItem work normally
 * - Object.keys() returns the stored data keys (not method names)
 */
const localStorageProxy = new Proxy(store, {
  get(target, prop: string) {
    if (prop === 'getItem') return (key: string) => key in target ? target[key] : null
    if (prop === 'setItem') return (key: string, val: string) => { target[key] = val }
    if (prop === 'removeItem') return (key: string) => { delete target[key] }
    if (prop === 'key') return (i: number) => Object.keys(target)[i] ?? null
    if (prop === 'length') return Object.keys(target).length
    if (prop === 'clear') return () => clearStore()
    return target[prop]
  },
  ownKeys(target) {
    return Object.keys(target)
  },
  getOwnPropertyDescriptor(target, prop) {
    if (prop in target) {
      return { value: target[prop as string], enumerable: true, configurable: true }
    }
    return undefined
  },
})

// Polyfill globalThis.localStorage for the test environment
Object.defineProperty(globalThis, 'localStorage', {
  value: localStorageProxy,
  writable: true,
  configurable: true,
})

/**
 * Check if Web Crypto is available in this test environment.
 */
const hasWebCrypto = typeof globalThis.crypto?.subtle?.encrypt === 'function'

describe('SecureStorage', () => {
  let storage: SecureStorage

  beforeEach(() => {
    storage = new SecureStorage()
    clearStore()
  })

  afterEach(() => {
    clearStore()
  })

  // ==========================================
  // UNENCRYPTED STORAGE (no crypto needed)
  // ==========================================

  describe('unencrypted storage', () => {
    it('stores and retrieves a string', async () => {
      await storage.set('name', 'alice')
      const result = await storage.get<string>('name')
      expect(result).toBe('alice')
    })

    it('stores and retrieves an object', async () => {
      const data = { foo: 'bar', count: 42 }
      await storage.set('config', data)
      const result = await storage.get<typeof data>('config')
      expect(result).toEqual(data)
    })

    it('returns null for missing keys', async () => {
      const result = await storage.get<string>('nonexistent')
      expect(result).toBeNull()
    })

    it('removes items', async () => {
      await storage.set('temp', 'value')
      storage.remove('temp')
      const result = await storage.get<string>('temp')
      expect(result).toBeNull()
    })

    it('clears all items', async () => {
      await storage.set('a', 1)
      await storage.set('b', 2)
      storage.clear()
      expect(await storage.get('a')).toBeNull()
      expect(await storage.get('b')).toBeNull()
    })

    it('respects expiry', async () => {
      vi.useFakeTimers()
      await storage.set('temp', 'value', { expiry: 1000 })

      const fresh = await storage.get<string>('temp')
      expect(fresh).toBe('value')

      vi.advanceTimersByTime(1500)
      const expired = await storage.get<string>('temp')
      expect(expired).toBeNull()

      vi.useRealTimers()
    })

    it('lists all keys', async () => {
      await storage.set('alpha', 1)
      await storage.set('beta', 2)
      const keys = storage.keys()
      expect(keys).toContain('alpha')
      expect(keys).toContain('beta')
    })

    it('clearExpired removes only expired items', async () => {
      vi.useFakeTimers()
      await storage.set('expires-soon', 'temp', { expiry: 1000 })
      await storage.set('expires-later', 'keep', { expiry: 10000 })
      await storage.set('no-expiry', 'forever')

      vi.advanceTimersByTime(2000)
      storage.clearExpired()

      expect('alphapolybot_expires-soon' in store).toBe(false)
      expect('alphapolybot_expires-later' in store).toBe(true)
      expect('alphapolybot_no-expiry' in store).toBe(true)

      vi.useRealTimers()
    })
  })

  // ==========================================
  // INITIALIZATION
  // ==========================================

  describe('initialization', () => {
    it('initializes without encryption key', async () => {
      await storage.initialize()
      expect(storage.isEncryptionReady).toBe(false)
    })

    it.skipIf(!hasWebCrypto)('initializes with encryption key', async () => {
      await storage.initialize('test-passphrase')
      expect(storage.isEncryptionReady).toBe(true)
    })

    it.skipIf(!hasWebCrypto)('clears encryption when re-initialized without key', async () => {
      await storage.initialize('test-passphrase')
      expect(storage.isEncryptionReady).toBe(true)

      await storage.initialize()
      expect(storage.isEncryptionReady).toBe(false)
    })
  })

  // ==========================================
  // AES-GCM ENCRYPTED STORAGE
  // ==========================================

  describe.skipIf(!hasWebCrypto)('AES-GCM encrypted storage', () => {
    beforeEach(async () => {
      await storage.initialize('my-secret-passphrase')
    })

    it('encrypts and decrypts roundtrip', async () => {
      await storage.set('api-key', 'sk-or-v1-abc123', { encrypt: true })
      const result = await storage.get<string>('api-key', true)
      expect(result).toBe('sk-or-v1-abc123')
    })

    it('encrypts objects roundtrip', async () => {
      const creds = { key: 'abc', secret: 'xyz', passphrase: '123' }
      await storage.set('clob-creds', creds, { encrypt: true })
      const result = await storage.get<typeof creds>('clob-creds', true)
      expect(result).toEqual(creds)
    })

    it('stores ciphertext not plaintext in storage', async () => {
      await storage.set('secret', 'supersecret', { encrypt: true })
      const raw = store['alphapolybot_secret']
      expect(raw).toBeDefined()
      expect(raw).not.toContain('supersecret')
      // Should be base64
      expect(raw).toMatch(/^[A-Za-z0-9+/=]+$/)
    })

    it('produces different ciphertexts for same plaintext (random IV)', async () => {
      await storage.set('key1', 'same-value', { encrypt: true })
      const cipher1 = store['alphapolybot_key1']

      await storage.set('key2', 'same-value', { encrypt: true })
      const cipher2 = store['alphapolybot_key2']

      expect(cipher1).toBeDefined()
      expect(cipher2).toBeDefined()
      expect(cipher1).not.toBe(cipher2)
    })

    it('fails to decrypt with wrong passphrase', async () => {
      await storage.set('secret', 'sensitive-data', { encrypt: true })

      const otherStorage = new SecureStorage()
      await otherStorage.initialize('wrong-passphrase')

      const result = await otherStorage.get<string>('secret', true)
      expect(result).toBeNull()
    })

    it('fails on tampered ciphertext', async () => {
      await storage.set('secret', 'sensitive-data', { encrypt: true })

      const raw = store['alphapolybot_secret']!
      const tampered = raw.slice(0, -4) + 'XXXX'
      store['alphapolybot_secret'] = tampered

      const result = await storage.get<string>('secret', true)
      expect(result).toBeNull()
    })

    it('stores unencrypted when encrypt=false even with key', async () => {
      await storage.set('public', 'visible', { encrypt: false })
      const raw = store['alphapolybot_public']
      expect(raw).toContain('visible')

      const result = await storage.get<string>('public', false)
      expect(result).toBe('visible')
    })

    it('respects expiry on encrypted values', async () => {
      vi.useFakeTimers()
      await storage.set('temp-secret', 'data', { encrypt: true, expiry: 1000 })

      const fresh = await storage.get<string>('temp-secret', true)
      expect(fresh).toBe('data')

      vi.advanceTimersByTime(1500)
      const expired = await storage.get<string>('temp-secret', true)
      expect(expired).toBeNull()

      vi.useRealTimers()
    })
  })
})
