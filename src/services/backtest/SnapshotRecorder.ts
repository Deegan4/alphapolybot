/**
 * SnapshotRecorder — records live market snapshots to IndexedDB for offline backtesting.
 *
 * Captures Gamma API market data + CLOB order book ask prices at configurable intervals.
 * Recorded snapshots power DipArb and ProjectFW backtests without needing PolyBacktest API.
 *
 * Storage: IndexedDB `alphapolybot` database, `marketSnapshots` object store.
 */
import type { RecordedSnapshot, Market } from '@/types'

const DB_NAME = 'alphapolybot'
const STORE_NAME = 'marketSnapshots'
const MAX_SNAPSHOTS = 50_000 // ~3 days at 1 snapshot/10s across 50 markets

export class SnapshotRecorder {
  private db: IDBDatabase | null = null
  private recording = false
  private interval: number | null = null

  async open(): Promise<void> {
    if (this.db) return
    return new Promise((resolve, reject) => {
      // Open at a version that includes our store — we use a separate open
      // that won't conflict with the main IndexedDBService version.
      // We detect if the store exists; if not, we bump version.
      const request = indexedDB.open(DB_NAME)
      request.onsuccess = () => {
        const db = request.result
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          // Need to create the store — close and reopen with version bump
          const newVersion = db.version + 1
          db.close()
          const upgradeReq = indexedDB.open(DB_NAME, newVersion)
          upgradeReq.onupgradeneeded = () => {
            const udb = upgradeReq.result
            if (!udb.objectStoreNames.contains(STORE_NAME)) {
              const store = udb.createObjectStore(STORE_NAME, { autoIncrement: true })
              store.createIndex('by-market', 'marketId', { unique: false })
              store.createIndex('by-timestamp', 'timestamp', { unique: false })
            }
          }
          upgradeReq.onsuccess = () => {
            this.db = upgradeReq.result
            resolve()
          }
          upgradeReq.onerror = () => reject(upgradeReq.error)
        } else {
          this.db = db
          resolve()
        }
      }
      request.onerror = () => reject(request.error)
    })
  }

  /** Record a single market snapshot */
  async record(market: Market, askPrices?: number[], bidPrices?: number[]): Promise<void> {
    if (!this.db) return

    const snapshot: RecordedSnapshot = {
      timestamp: new Date().toISOString(),
      marketId: market.id,
      slug: market.slug,
      question: market.question,
      outcomes: market.outcomes,
      outcomePrices: market.outcomePrices.map(Number),
      askPrices,
      bidPrices,
      volume24h: market.volume24hr,
      liquidity: market.liquidity,
      clobTokenIds: market.clobTokenIds,
      conditionId: market.conditionId,
      negRisk: market.negRisk,
    }

    return new Promise((resolve, reject) => {
      const tx = this.db!.transaction(STORE_NAME, 'readwrite')
      tx.objectStore(STORE_NAME).add(snapshot)
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
    })
  }

  /** Record multiple snapshots in a single transaction */
  async recordBatch(snapshots: RecordedSnapshot[]): Promise<void> {
    if (!this.db || snapshots.length === 0) return

    return new Promise((resolve, reject) => {
      const tx = this.db!.transaction(STORE_NAME, 'readwrite')
      const store = tx.objectStore(STORE_NAME)
      for (const s of snapshots) store.add(s)
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
    })
  }

  /** Get all snapshots for a specific market, ordered by timestamp */
  async getByMarket(marketId: string): Promise<RecordedSnapshot[]> {
    if (!this.db) return []
    return new Promise((resolve, reject) => {
      const tx = this.db!.transaction(STORE_NAME, 'readonly')
      const index = tx.objectStore(STORE_NAME).index('by-market')
      const request = index.getAll(marketId)
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
  }

  /** Get all snapshots in a time range */
  async getByTimeRange(startISO: string, endISO: string): Promise<RecordedSnapshot[]> {
    if (!this.db) return []
    return new Promise((resolve, reject) => {
      const tx = this.db!.transaction(STORE_NAME, 'readonly')
      const index = tx.objectStore(STORE_NAME).index('by-timestamp')
      const range = IDBKeyRange.bound(startISO, endISO)
      const request = index.getAll(range)
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
  }

  /** Get all unique market IDs that have recorded snapshots */
  async getRecordedMarketIds(): Promise<string[]> {
    if (!this.db) return []
    return new Promise((resolve, reject) => {
      const tx = this.db!.transaction(STORE_NAME, 'readonly')
      const index = tx.objectStore(STORE_NAME).index('by-market')
      const request = index.openKeyCursor(null, 'nextunique')
      const ids: string[] = []
      request.onsuccess = () => {
        const cursor = request.result
        if (cursor) {
          ids.push(cursor.key as string)
          cursor.continue()
        } else {
          resolve(ids)
        }
      }
      request.onerror = () => reject(request.error)
    })
  }

  /** Get total snapshot count */
  async count(): Promise<number> {
    if (!this.db) return 0
    return new Promise((resolve, reject) => {
      const tx = this.db!.transaction(STORE_NAME, 'readonly')
      const request = tx.objectStore(STORE_NAME).count()
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
  }

  /** Prune oldest snapshots when exceeding MAX_SNAPSHOTS */
  async prune(): Promise<number> {
    const total = await this.count()
    if (total <= MAX_SNAPSHOTS) return 0

    const toDelete = total - MAX_SNAPSHOTS
    return new Promise((resolve, reject) => {
      const tx = this.db!.transaction(STORE_NAME, 'readwrite')
      const store = tx.objectStore(STORE_NAME)
      const request = store.openCursor()
      let deleted = 0
      request.onsuccess = () => {
        const cursor = request.result
        if (cursor && deleted < toDelete) {
          cursor.delete()
          deleted++
          cursor.continue()
        }
      }
      tx.oncomplete = () => resolve(deleted)
      tx.onerror = () => reject(tx.error)
    })
  }

  /** Clear all recorded snapshots */
  async clear(): Promise<void> {
    if (!this.db) return
    return new Promise((resolve, reject) => {
      const tx = this.db!.transaction(STORE_NAME, 'readwrite')
      tx.objectStore(STORE_NAME).clear()
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
    })
  }

  get isRecording(): boolean { return this.recording }

  /** Start periodic recording — caller provides the data fetch function */
  startRecording(
    fetchSnapshots: () => Promise<RecordedSnapshot[]>,
    intervalMs = 10_000,
  ): void {
    if (this.recording) return
    this.recording = true
    this.interval = window.setInterval(async () => {
      try {
        const snapshots = await fetchSnapshots()
        await this.recordBatch(snapshots)
        await this.prune()
      } catch {
        // Non-critical — don't block bot execution
      }
    }, intervalMs)
  }

  stopRecording(): void {
    this.recording = false
    if (this.interval) {
      clearInterval(this.interval)
      this.interval = null
    }
  }
}

export const snapshotRecorder = new SnapshotRecorder()
