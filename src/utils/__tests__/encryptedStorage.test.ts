import { describe, it, expect, beforeEach, vi } from 'vitest'
import { webcrypto } from 'node:crypto'

/**
 * Covers the credential-at-rest path: the device key, the Zustand persist
 * adapter that encrypts the settings blob, and the migration of plaintext
 * left behind by earlier versions.
 *
 * jsdom ships neither crypto.subtle nor indexedDB, so both are supplied here:
 * Node's webcrypto is the real implementation, and the keyring is a minimal
 * in-memory IndexedDB stand-in (structured clone of a CryptoKey is exactly
 * what the browser does, and holding the object works the same way).
 */

// ---------- localStorage ----------
const store: Record<string, string> = {}
const localStorageMock = {
  getItem: (k: string) => (k in store ? store[k] : null),
  setItem: (k: string, v: string) => { store[k] = v },
  removeItem: (k: string) => { delete store[k] },
  clear: () => { for (const k of Object.keys(store)) delete store[k] },
}

// ---------- indexedDB (keyring only) ----------
const keyring: Record<string, unknown> = {}

function makeRequest<T>(result: T) {
  const req: Record<string, unknown> = { result, onsuccess: null, onerror: null }
  queueMicrotask(() => (req.onsuccess as (() => void) | null)?.())
  return req
}

const indexedDBMock = {
  open: () => {
    const db = {
      objectStoreNames: { contains: () => true },
      createObjectStore: () => undefined,
      close: () => undefined,
      transaction: () => ({
        objectStore: () => ({
          get: (key: string) => makeRequest(keyring[key]),
          put: (value: unknown, key: string) => { keyring[key] = value; return makeRequest(undefined) },
        }),
        set oncomplete(fn: () => void) { queueMicrotask(fn) },
        get oncomplete() { return null },
        onerror: null,
        error: null,
      }),
    }
    const req: Record<string, unknown> = { result: db, onsuccess: null, onerror: null, onupgradeneeded: null }
    queueMicrotask(() => (req.onsuccess as (() => void) | null)?.())
    return req
  },
}

vi.stubGlobal('localStorage', localStorageMock)
vi.stubGlobal('crypto', webcrypto)
vi.stubGlobal('indexedDB', indexedDBMock)

const { getDeviceKey, encryptWithKey, decryptWithKey, looksLikePlaintextJSON, __resetDeviceKeyCache } =
  await import('../deviceKey')
const { createEncryptedPersistStorage } = await import('../encryptedPersistStorage')

describe('deviceKey', () => {
  beforeEach(() => {
    localStorageMock.clear()
    for (const k of Object.keys(keyring)) delete keyring[k]
    __resetDeviceKeyCache()
  })

  it('generates a non-extractable AES-GCM key', async () => {
    const key = await getDeviceKey()
    expect(key).not.toBeNull()
    expect(key!.algorithm.name).toBe('AES-GCM')
    expect(key!.extractable).toBe(false)
  })

  it('refuses to export the key material', async () => {
    const key = await getDeviceKey()
    await expect(crypto.subtle.exportKey('raw', key!)).rejects.toThrow()
  })

  it('reuses the persisted key across cache resets', async () => {
    const first = await getDeviceKey()
    __resetDeviceKeyCache()
    const second = await getDeviceKey()
    expect(second).toBe(first)
  })

  it('serves one shared key to concurrent callers', async () => {
    const [a, b, c] = await Promise.all([getDeviceKey(), getDeviceKey(), getDeviceKey()])
    expect(a).toBe(b)
    expect(b).toBe(c)
  })

  it('round-trips a value', async () => {
    const key = await getDeviceKey()
    const encrypted = await encryptWithKey(key!, 'pmUsSecretKey-abc123')
    expect(encrypted).not.toContain('pmUsSecretKey')
    expect(await decryptWithKey(key!, encrypted)).toBe('pmUsSecretKey-abc123')
  })

  it('uses a fresh IV per encryption', async () => {
    const key = await getDeviceKey()
    const a = await encryptWithKey(key!, 'same input')
    const b = await encryptWithKey(key!, 'same input')
    expect(a).not.toBe(b)
  })

  it('rejects tampered ciphertext', async () => {
    const key = await getDeviceKey()
    const encrypted = await encryptWithKey(key!, 'sensitive')
    const bytes = Uint8Array.from(atob(encrypted), (c) => c.charCodeAt(0))
    bytes[bytes.length - 1] ^= 0xff
    const tampered = btoa(String.fromCharCode(...bytes))
    await expect(decryptWithKey(key!, tampered)).rejects.toThrow()
  })

  it('handles payloads larger than the argument limit', async () => {
    const key = await getDeviceKey()
    const big = 'x'.repeat(200_000)
    expect(await decryptWithKey(key!, await encryptWithKey(key!, big))).toBe(big)
  })

  it('distinguishes plaintext JSON from ciphertext', () => {
    expect(looksLikePlaintextJSON('{"state":{}}')).toBe(true)
    expect(looksLikePlaintextJSON('  {"state":{}}')).toBe(true)
    expect(looksLikePlaintextJSON('dGhpcyBpcyBiYXNlNjQ=')).toBe(false)
  })
})

describe('encryptedPersistStorage', () => {
  beforeEach(() => {
    localStorageMock.clear()
    for (const k of Object.keys(keyring)) delete keyring[k]
    __resetDeviceKeyCache()
  })

  it('writes ciphertext, not the secret', async () => {
    const storage = createEncryptedPersistStorage<{ coinbaseSecret: string }>()
    await storage.setItem('alphapolybot-settings', {
      state: { coinbaseSecret: 'super-secret-value' },
      version: 31,
    })

    const raw = localStorage.getItem('alphapolybot-settings')!
    expect(raw).not.toContain('super-secret-value')
    expect(raw).not.toContain('coinbaseSecret')
    expect(looksLikePlaintextJSON(raw)).toBe(false)
  })

  it('round-trips state through storage', async () => {
    const storage = createEncryptedPersistStorage<{ coinbaseSecret: string }>()
    await storage.setItem('k', { state: { coinbaseSecret: 'abc' }, version: 31 })
    const read = await storage.getItem('k')
    expect(read).toEqual({ state: { coinbaseSecret: 'abc' }, version: 31 })
  })

  it('reads legacy plaintext and re-persists it encrypted', async () => {
    const legacy = JSON.stringify({ state: { coinbaseSecret: 'legacy-secret' }, version: 31 })
    localStorage.setItem('alphapolybot-settings', legacy)

    const storage = createEncryptedPersistStorage<{ coinbaseSecret: string }>()
    const read = await storage.getItem('alphapolybot-settings')

    // Settings survive the upgrade...
    expect(read!.state.coinbaseSecret).toBe('legacy-secret')
    // ...and the cleartext copy is gone.
    const raw = localStorage.getItem('alphapolybot-settings')!
    expect(raw).not.toContain('legacy-secret')
    expect(looksLikePlaintextJSON(raw)).toBe(false)
    expect((await storage.getItem('alphapolybot-settings'))!.state.coinbaseSecret).toBe('legacy-secret')
  })

  it('returns null rather than throwing on corrupt ciphertext', async () => {
    localStorage.setItem('k', 'bm90LXZhbGlkLWNpcGhlcnRleHQ=')
    const storage = createEncryptedPersistStorage<{ x: number }>()
    expect(await storage.getItem('k')).toBeNull()
  })

  it('returns null for a missing key', async () => {
    const storage = createEncryptedPersistStorage<{ x: number }>()
    expect(await storage.getItem('absent')).toBeNull()
  })

  it('removes items', async () => {
    const storage = createEncryptedPersistStorage<{ x: number }>()
    await storage.setItem('k', { state: { x: 1 }, version: 1 })
    storage.removeItem('k')
    expect(localStorage.getItem('k')).toBeNull()
  })
})
