/**
 * Device Key
 *
 * Owns the AES-256-GCM key used to encrypt everything this app puts in
 * localStorage (wallet signing secrets, exchange API credentials, settings).
 *
 * The key is generated with `extractable: false` and kept in IndexedDB as a
 * live CryptoKey object. That matters: the raw key bytes never exist in JS,
 * so they cannot be read out of storage, serialized into a bug report, or
 * exfiltrated — only used, in this origin, through crypto.subtle. It also
 * means there is no passphrase baked into the bundle pretending to be a
 * secret. Note the limit of that guarantee: script running *in the page*
 * can still ask for decryptions. This raises the cost of stolen storage,
 * it does not defend against XSS — that's what the CSP is for.
 *
 * Falls back to no encryption (with a loud warning) when Web Crypto or
 * IndexedDB is unavailable, e.g. an insecure context. Storage keeps working;
 * it just stays plaintext, as it was before.
 */

const DB_NAME = 'alphapolybot-keyring'
const DB_VERSION = 1
const STORE = 'keys'
const KEY_ID = 'device-aes-gcm-v1'

let keyPromise: Promise<CryptoKey | null> | null = null
let warned = false

function warnOnce(reason: string): void {
  if (warned) return
  warned = true
  console.warn(
    `[DeviceKey] Encryption unavailable (${reason}). Credentials will be stored in ` +
    `plaintext localStorage. Serve the app over HTTPS or localhost to enable encryption.`
  )
}

function cryptoAvailable(): boolean {
  return (
    typeof globalThis.crypto !== 'undefined' &&
    typeof globalThis.crypto.subtle !== 'undefined' &&
    typeof globalThis.indexedDB !== 'undefined'
  )
}

function openKeyring(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) {
        req.result.createObjectStore(STORE)
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error ?? new Error('indexedDB.open failed'))
  })
}

function idbGet(db: IDBDatabase, key: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const req = db.transaction(STORE, 'readonly').objectStore(STORE).get(key)
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error ?? new Error('idb get failed'))
  })
}

function idbPut(db: IDBDatabase, key: string, value: unknown): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite')
    tx.objectStore(STORE).put(value, key)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error ?? new Error('idb put failed'))
  })
}

async function loadOrCreate(): Promise<CryptoKey | null> {
  if (!cryptoAvailable()) {
    warnOnce('no crypto.subtle or indexedDB')
    return null
  }

  let db: IDBDatabase
  try {
    db = await openKeyring()
  } catch (error) {
    warnOnce(`keyring unavailable: ${error instanceof Error ? error.message : error}`)
    return null
  }

  try {
    const existing = await idbGet(db, KEY_ID)
    // Guard the type: a CryptoKey survives structured clone, anything else is junk.
    if (existing && typeof existing === 'object' && 'algorithm' in existing) {
      return existing as CryptoKey
    }

    const key = await crypto.subtle.generateKey(
      { name: 'AES-GCM', length: 256 },
      false, // non-extractable — raw bytes never reach JS
      ['encrypt', 'decrypt']
    )
    await idbPut(db, KEY_ID, key)
    console.log('[DeviceKey] Generated new non-extractable device key')
    return key
  } catch (error) {
    warnOnce(`key setup failed: ${error instanceof Error ? error.message : error}`)
    return null
  } finally {
    db.close()
  }
}

/**
 * Resolve this device's encryption key, generating it on first use.
 * Cached — concurrent callers share one generation, so we never race
 * two keys into the keyring and lose data encrypted under the loser.
 */
export function getDeviceKey(): Promise<CryptoKey | null> {
  if (!keyPromise) keyPromise = loadOrCreate()
  return keyPromise
}

/** Encrypt to base64(iv[12] ‖ ciphertext ‖ authTag[16]). */
export async function encryptWithKey(key: CryptoKey, text: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    new TextEncoder().encode(text)
  )

  const combined = new Uint8Array(iv.length + ciphertext.byteLength)
  combined.set(iv, 0)
  combined.set(new Uint8Array(ciphertext), iv.length)

  // Chunked to avoid blowing the argument limit on large payloads (the
  // settings blob is a few KB, and String.fromCharCode(...big) throws).
  let binary = ''
  const CHUNK = 0x8000
  for (let i = 0; i < combined.length; i += CHUNK) {
    binary += String.fromCharCode(...combined.subarray(i, i + CHUNK))
  }
  return btoa(binary)
}

/** Decrypt base64(iv ‖ ciphertext). Throws on tampering — AES-GCM is authenticated. */
export async function decryptWithKey(key: CryptoKey, encoded: string): Promise<string> {
  const combined = Uint8Array.from(atob(encoded), (c) => c.charCodeAt(0))
  const decrypted = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: combined.slice(0, 12) },
    key,
    combined.slice(12)
  )
  return new TextDecoder().decode(decrypted)
}

/**
 * Heuristic: is this stored string plaintext JSON from before encryption
 * existed? Ciphertext is base64 and never starts with `{`.
 */
export function looksLikePlaintextJSON(stored: string): boolean {
  return stored.trimStart().startsWith('{')
}

/** Test seam — drops the cached key so each test starts clean. */
export function __resetDeviceKeyCache(): void {
  keyPromise = null
  warned = false
}
