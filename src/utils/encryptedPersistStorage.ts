/**
 * Encrypted Persist Storage
 *
 * A Zustand `persist` storage adapter that encrypts the whole persisted blob
 * with this device's non-extractable key before it touches localStorage.
 *
 * The settings store persists exchange credentials — pmUsSecretKey (order
 * signing), coinbaseSecret (spot trading), openRouterApiKey — which were
 * previously written as readable JSON under `alphapolybot-settings`.
 *
 * Reads migrate transparently: a plaintext blob left by an earlier version is
 * parsed as-is and re-written encrypted, so upgrading never loses settings.
 * If the keyring is unavailable, writes stay plaintext rather than dropping
 * the user's configuration — deviceKey warns once when that happens.
 *
 * Note this is async, so the store hydrates a tick after creation. Callers
 * that read credentials during startup must await hydration first (see
 * `awaitSettingsHydration` in the settings store).
 */

import type { PersistStorage, StorageValue } from 'zustand/middleware'
import {
  getDeviceKey,
  encryptWithKey,
  decryptWithKey,
  looksLikePlaintextJSON,
} from './deviceKey'

export function createEncryptedPersistStorage<T>(): PersistStorage<T> {
  return {
    getItem: async (name: string): Promise<StorageValue<T> | null> => {
      const raw = localStorage.getItem(name)
      if (raw == null) return null

      // Legacy plaintext from before encryption existed — read it, then
      // immediately re-persist encrypted so the cleartext copy is replaced.
      if (looksLikePlaintextJSON(raw)) {
        try {
          const parsed = JSON.parse(raw) as StorageValue<T>
          const key = await getDeviceKey()
          if (key) {
            localStorage.setItem(name, await encryptWithKey(key, raw))
            console.log(`[EncryptedStore] Migrated "${name}" to AES-GCM`)
          }
          return parsed
        } catch (error) {
          console.error(`[EncryptedStore] Corrupt plaintext state in "${name}":`, error)
          return null
        }
      }

      const key = await getDeviceKey()
      if (!key) {
        console.warn(`[EncryptedStore] "${name}" is encrypted but no device key is available`)
        return null
      }

      try {
        return JSON.parse(await decryptWithKey(key, raw)) as StorageValue<T>
      } catch (error) {
        // Wrong key or tampered ciphertext. Returning null falls back to
        // defaults (dryRun: true) rather than throwing during hydration.
        console.error(`[EncryptedStore] Failed to decrypt "${name}":`, error)
        return null
      }
    },

    setItem: async (name: string, value: StorageValue<T>): Promise<void> => {
      const json = JSON.stringify(value)
      const key = await getDeviceKey()
      localStorage.setItem(name, key ? await encryptWithKey(key, json) : json)
    },

    removeItem: (name: string): void => {
      localStorage.removeItem(name)
    },
  }
}
