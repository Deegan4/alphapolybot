import { openDB, type IDBPDatabase } from 'idb'
import type { ActivityItem, ArbRound, PendingGtcOrder } from '@/types'
import type { TrackedPosition } from '@/services/trading/PositionLifecycleManager'
import type { TradeRecord } from '@/services/trading/TradeLogger'

// ==========================================
// DATABASE SCHEMA
// ==========================================

const DB_NAME = 'alphapolybot'
const DB_VERSION = 5

interface AlphaPolyBotDB {
  activities: {
    key: string
    value: StoredActivity
    indexes: { 'by-type': string; 'by-timestamp': number }
  }
  positions: {
    key: string
    value: StoredPosition
    indexes: { 'by-strategy': string }
  }
  arbRounds: {
    key: string
    value: StoredArbRound
    indexes: { 'by-timestamp': number }
  }
  gtcOrders: {
    key: string
    value: StoredGtcOrder
    indexes: { 'by-strategy': string; 'by-expiresAt': number }
  }
  tradeRecords: {
    key: string
    value: TradeRecord
    indexes: { 'by-timestamp': number; 'by-strategy': string }
  }
  calibrationData: {
    key: string
    value: { marketId: string; predictedProb: number; predictedOutcome: string; timestamp: number; actualOutcome?: string; resolvedAt?: number }
    indexes: { 'by-timestamp': number }
  }
}

// Stored types — extend the runtime types with serializable fields
interface StoredActivity {
  id: string
  timestamp: number // stored as epoch ms (Date not serializable in IDB)
  type: string
  message: string
  data?: Record<string, unknown>
  marketId?: string
  orderId?: string
}

interface StoredPosition extends TrackedPosition {
  _storedAt: number // when this was persisted
}

interface StoredArbRound extends ArbRound {
  id: string
  _storedAt: number
}

interface StoredGtcOrder extends PendingGtcOrder {
  _storedAt: number
}

// ==========================================
// SERVICE
// ==========================================

/**
 * IndexedDB Service
 *
 * Persists activities, tracked positions, and arb rounds so that
 * a page refresh doesn't lose the bot's operational history.
 *
 * Uses the `idb` library for clean async/await over raw IndexedDB.
 * Auto-cleans activities older than 30 days to prevent unbounded growth.
 */
export class IndexedDBService {
  private db: IDBPDatabase<AlphaPolyBotDB> | null = null
  private initPromise: Promise<void> | null = null

  /**
   * Initialize — open or create the database
   * Safe to call multiple times (idempotent via initPromise)
   */
  async initialize(): Promise<void> {
    if (this.initPromise) return this.initPromise

    this.initPromise = this.openDatabase()
    return this.initPromise
  }

  private async openDatabase(): Promise<void> {
    try {
      this.db = await openDB<AlphaPolyBotDB>(DB_NAME, DB_VERSION, {
        upgrade(db, oldVersion) {
          // Activities store
          if (!db.objectStoreNames.contains('activities')) {
            const activityStore = db.createObjectStore('activities', { keyPath: 'id' })
            activityStore.createIndex('by-type', 'type')
            activityStore.createIndex('by-timestamp', 'timestamp')
          }

          // Positions store — v5 migrates keyPath from tokenId to marketSlug
          if (oldVersion < 5 && db.objectStoreNames.contains('positions')) {
            // Can't alter keyPath — must delete and recreate
            db.deleteObjectStore('positions')
          }
          if (!db.objectStoreNames.contains('positions')) {
            const positionStore = db.createObjectStore('positions', { keyPath: 'marketSlug' })
            positionStore.createIndex('by-strategy', 'strategy')
          }

          // Arb rounds store
          if (!db.objectStoreNames.contains('arbRounds')) {
            const arbStore = db.createObjectStore('arbRounds', { keyPath: 'id' })
            arbStore.createIndex('by-timestamp', '_storedAt')
          }

          // GTD pending orders store (v2)
          if (!db.objectStoreNames.contains('gtcOrders')) {
            const gtcStore = db.createObjectStore('gtcOrders', { keyPath: 'orderId' })
            gtcStore.createIndex('by-strategy', 'strategy')
            gtcStore.createIndex('by-expiresAt', 'expiresAt')
          }

          // Trade records store (v4 — backtest framework)
          if (!db.objectStoreNames.contains('tradeRecords')) {
            const tradeStore = db.createObjectStore('tradeRecords', { keyPath: 'id' })
            tradeStore.createIndex('by-timestamp', 'timestamp')
            tradeStore.createIndex('by-strategy', 'strategy')
          }

          // Calibration data store (v4 — LLM confidence calibration)
          if (!db.objectStoreNames.contains('calibrationData')) {
            const calStore = db.createObjectStore('calibrationData', { keyPath: 'marketId' })
            calStore.createIndex('by-timestamp', 'timestamp')
          }
        },
      })

      console.log('[IndexedDB] Database opened successfully')

      // Auto-prune all stores on startup (background, non-blocking)
      this.pruneAll().catch(err =>
        console.warn('[IndexedDB] Auto-prune failed:', err)
      )
    } catch (error) {
      console.error('[IndexedDB] Failed to open database:', error)
      // Don't throw — storage is non-critical. The bot should work without it.
      this.db = null
    }
  }

  // ==========================================
  // ACTIVITIES
  // ==========================================

  /**
   * Store an activity (fire-and-forget from ActivityLogger)
   */
  async storeActivity(activity: ActivityItem): Promise<void> {
    if (!this.db) return

    try {
      const stored: StoredActivity = {
        id: activity.id,
        timestamp: activity.timestamp.getTime(),
        type: activity.type,
        message: activity.message,
        data: activity.data,
        marketId: activity.marketId,
        orderId: activity.orderId,
      }

      await this.db.put('activities', stored)
    } catch (error) {
      console.warn('[IndexedDB] Failed to store activity:', error)
    }
  }

  /**
   * Load activities from storage (for hydrating ActivityLogger on init)
   */
  async loadActivities(limit = 500): Promise<ActivityItem[]> {
    if (!this.db) return []

    try {
      const stored = await this.db.getAllFromIndex(
        'activities',
        'by-timestamp'
      )

      // Return most recent first, up to limit
      return stored
        .reverse()
        .slice(0, limit)
        .map(s => ({
          id: s.id,
          timestamp: new Date(s.timestamp),
          type: s.type as ActivityItem['type'],
          message: s.message,
          data: s.data,
          marketId: s.marketId,
          orderId: s.orderId,
        }))
    } catch (error) {
      console.warn('[IndexedDB] Failed to load activities:', error)
      return []
    }
  }

  // ==========================================
  // POSITIONS (crash recovery)
  // ==========================================

  /**
   * Store a tracked position
   */
  async storePosition(position: TrackedPosition): Promise<void> {
    if (!this.db) return

    try {
      const stored: StoredPosition = {
        ...position,
        _storedAt: Date.now(),
      }
      await this.db.put('positions', stored)
    } catch (error) {
      console.warn('[IndexedDB] Failed to store position:', error)
    }
  }

  /**
   * Remove a position from storage (after sell/close)
   */
  async removePosition(slug: string): Promise<void> {
    if (!this.db) return

    try {
      await this.db.delete('positions', slug)
    } catch (error) {
      console.warn('[IndexedDB] Failed to remove position:', error)
    }
  }

  /**
   * Load all tracked positions (for crash recovery)
   */
  async loadPositions(): Promise<TrackedPosition[]> {
    if (!this.db) return []

    try {
      const stored = await this.db.getAll('positions')
      // Strip the _storedAt field before returning
      return stored.map(({ _storedAt, ...pos }) => pos)
    } catch (error) {
      console.warn('[IndexedDB] Failed to load positions:', error)
      return []
    }
  }

  /**
   * Clear all stored positions
   */
  async clearPositions(): Promise<void> {
    if (!this.db) return

    try {
      await this.db.clear('positions')
    } catch (error) {
      console.warn('[IndexedDB] Failed to clear positions:', error)
    }
  }

  // ==========================================
  // ARB ROUNDS
  // ==========================================

  /**
   * Store an arb round
   */
  async storeArbRound(round: ArbRound): Promise<void> {
    if (!this.db) return

    try {
      const stored: StoredArbRound = {
        ...round,
        id: `arb-${round.marketId}-${Date.now()}`,
        _storedAt: Date.now(),
      }
      await this.db.put('arbRounds', stored)
    } catch (error) {
      console.warn('[IndexedDB] Failed to store arb round:', error)
    }
  }

  /**
   * Load arb rounds
   */
  async loadArbRounds(limit = 100): Promise<ArbRound[]> {
    if (!this.db) return []

    try {
      const stored = await this.db.getAllFromIndex('arbRounds', 'by-timestamp')
      return stored
        .reverse()
        .slice(0, limit)
        .map(({ id: _id, _storedAt, ...round }) => round)
    } catch (error) {
      console.warn('[IndexedDB] Failed to load arb rounds:', error)
      return []
    }
  }

  // ==========================================
  // GTC ORDERS (pending GTD limit orders)
  // ==========================================

  async storeGtcOrder(order: PendingGtcOrder): Promise<void> {
    if (!this.db) return
    if (!this.db.objectStoreNames.contains('gtcOrders')) return

    try {
      const stored: StoredGtcOrder = { ...order, _storedAt: Date.now() }
      await this.db.put('gtcOrders', stored)
    } catch (error) {
      console.warn('[IndexedDB] Failed to store GTC order:', error)
    }
  }

  async removeGtcOrder(orderId: string): Promise<void> {
    if (!this.db) return
    if (!this.db.objectStoreNames.contains('gtcOrders')) return

    try {
      await this.db.delete('gtcOrders', orderId)
    } catch (error) {
      console.warn('[IndexedDB] Failed to remove GTC order:', error)
    }
  }

  async loadGtcOrders(): Promise<PendingGtcOrder[]> {
    if (!this.db) return []

    // Guard: the 'gtcOrders' store was added in DB v2.
    // If a stale v1 DB is open (e.g. blocked upgrade), skip gracefully.
    if (!this.db.objectStoreNames.contains('gtcOrders')) {
      console.warn('[IndexedDB] gtcOrders store not found — DB may need version upgrade (close other tabs)')
      return []
    }

    try {
      const stored = await this.db.getAll('gtcOrders')
      return stored.map(({ _storedAt, ...order }) => order)
    } catch (error) {
      console.warn('[IndexedDB] Failed to load GTC orders:', error)
      return []
    }
  }

  // ==========================================
  // TRADE RECORDS (backtest framework)
  // ==========================================

  async storeTradeRecord(record: TradeRecord): Promise<void> {
    if (!this.db) return
    if (!this.db.objectStoreNames.contains('tradeRecords')) return
    try {
      await this.db.put('tradeRecords', record)
    } catch (error) {
      console.warn('[IndexedDB] Failed to store trade record:', error)
    }
  }

  async loadTradeRecords(limit = 5000): Promise<TradeRecord[]> {
    if (!this.db) return []
    if (!this.db.objectStoreNames.contains('tradeRecords')) return []
    try {
      const stored = await this.db.getAllFromIndex('tradeRecords', 'by-timestamp')
      return stored.reverse().slice(0, limit)
    } catch (error) {
      console.warn('[IndexedDB] Failed to load trade records:', error)
      return []
    }
  }

  // ==========================================
  // CALIBRATION DATA (LLM confidence tracking)
  // ==========================================

  async storeCalibrationData(predictions: Array<{ marketId: string; predictedProb: number; predictedOutcome: string; timestamp: number; actualOutcome?: string; resolvedAt?: number }>): Promise<void> {
    if (!this.db) return
    if (!this.db.objectStoreNames.contains('calibrationData')) return
    try {
      const tx = this.db.transaction('calibrationData', 'readwrite')
      for (const pred of predictions) {
        await tx.store.put(pred)
      }
      await tx.done
    } catch (error) {
      console.warn('[IndexedDB] Failed to store calibration data:', error)
    }
  }

  async loadCalibrationData(): Promise<Array<{ marketId: string; predictedProb: number; predictedOutcome: string; timestamp: number; actualOutcome?: string; resolvedAt?: number }>> {
    if (!this.db) return []
    if (!this.db.objectStoreNames.contains('calibrationData')) return []
    try {
      return await this.db.getAll('calibrationData')
    } catch (error) {
      console.warn('[IndexedDB] Failed to load calibration data:', error)
      return []
    }
  }

  // ==========================================
  // MAINTENANCE
  // ==========================================

  // ==========================================
  // AUTO-PRUNING — TTL and cap-based cleanup
  // ==========================================

  // Retention limits
  private static readonly ACTIVITY_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000  // 30 days
  private static readonly ARB_ROUNDS_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000 // 7 days
  private static readonly TRADE_RECORDS_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000 // 90 days
  private static readonly CALIBRATION_MAX_AGE_MS = 60 * 24 * 60 * 60 * 1000  // 60 days
  private static readonly GTC_ORDERS_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000    // 7 days (filled/expired)
  private static readonly POSITIONS_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000    // 14 days (stale orphans)

  /**
   * Run all auto-pruning tasks. Safe to call frequently — each method is
   * cursor-based and stops early once it passes the age threshold.
   * Returns total records deleted across all stores.
   */
  async pruneAll(): Promise<number> {
    let total = 0
    total += await this.cleanupOldActivities()
    total += await this.cleanupOldArbRounds()
    total += await this.cleanupOldTradeRecords()
    total += await this.cleanupOldCalibrationData()
    total += await this.cleanupOldGtcOrders()
    total += await this.cleanupStalePositions()
    if (total > 0) {
      console.log(`[IndexedDB] Auto-prune complete: ${total} total records removed`)
    }
    return total
  }

  /**
   * Delete activities older than 30 days
   */
  async cleanupOldActivities(): Promise<number> {
    return this.pruneByTimestampIndex(
      'activities', 'by-timestamp', 'timestamp',
      IndexedDBService.ACTIVITY_MAX_AGE_MS, 'activities'
    )
  }

  /**
   * Delete arb rounds older than 7 days
   */
  async cleanupOldArbRounds(): Promise<number> {
    return this.pruneByTimestampIndex(
      'arbRounds', 'by-timestamp', '_storedAt',
      IndexedDBService.ARB_ROUNDS_MAX_AGE_MS, 'arb rounds'
    )
  }

  /**
   * Delete trade records older than 90 days
   */
  async cleanupOldTradeRecords(): Promise<number> {
    if (!this.db?.objectStoreNames.contains('tradeRecords')) return 0
    return this.pruneByTimestampIndex(
      'tradeRecords', 'by-timestamp', 'timestamp',
      IndexedDBService.TRADE_RECORDS_MAX_AGE_MS, 'trade records'
    )
  }

  /**
   * Delete calibration predictions older than 60 days
   */
  async cleanupOldCalibrationData(): Promise<number> {
    if (!this.db?.objectStoreNames.contains('calibrationData')) return 0
    return this.pruneByTimestampIndex(
      'calibrationData', 'by-timestamp', 'timestamp',
      IndexedDBService.CALIBRATION_MAX_AGE_MS, 'calibration entries'
    )
  }

  /**
   * Delete filled/expired GTC orders older than 7 days.
   * Only removes orders stored >7 days ago (safe for active orders).
   */
  async cleanupOldGtcOrders(): Promise<number> {
    if (!this.db?.objectStoreNames.contains('gtcOrders')) return 0
    const cutoff = Date.now() - IndexedDBService.GTC_ORDERS_MAX_AGE_MS
    let deleted = 0

    try {
      const tx = this.db!.transaction('gtcOrders', 'readwrite')
      let cursor = await tx.store.openCursor()
      while (cursor) {
        const storedAt = (cursor.value as StoredGtcOrder)._storedAt
        if (storedAt && storedAt < cutoff) {
          await cursor.delete()
          deleted++
        }
        cursor = await cursor.continue()
      }
      await tx.done
      if (deleted > 0) console.log(`[IndexedDB] Pruned ${deleted} old GTC orders`)
    } catch (error) {
      console.warn('[IndexedDB] GTC order cleanup error:', error)
    }
    return deleted
  }

  /**
   * Delete orphaned positions older than 14 days.
   * Positions should be removed when closed, but crashes can leave orphans.
   */
  async cleanupStalePositions(): Promise<number> {
    if (!this.db) return 0
    const cutoff = Date.now() - IndexedDBService.POSITIONS_MAX_AGE_MS
    let deleted = 0

    try {
      const tx = this.db.transaction('positions', 'readwrite')
      let cursor = await tx.store.openCursor()
      while (cursor) {
        const storedAt = (cursor.value as StoredPosition)._storedAt
        if (storedAt && storedAt < cutoff) {
          await cursor.delete()
          deleted++
        }
        cursor = await cursor.continue()
      }
      await tx.done
      if (deleted > 0) console.log(`[IndexedDB] Pruned ${deleted} stale positions (>14 days old)`)
    } catch (error) {
      console.warn('[IndexedDB] Position cleanup error:', error)
    }
    return deleted
  }

  /**
   * Generic cursor-based pruning: walks an index in order and deletes
   * records whose timestamp field is older than maxAgeMs.
   */
  private async pruneByTimestampIndex(
    storeName: 'activities' | 'arbRounds' | 'tradeRecords' | 'calibrationData',
    indexName: string,
    _timestampField: string,
    maxAgeMs: number,
    label: string,
  ): Promise<number> {
    if (!this.db) return 0

    const cutoff = Date.now() - maxAgeMs
    let deleted = 0

    try {
      const tx = this.db.transaction(storeName, 'readwrite')
      const index = tx.store.index(indexName)

      let cursor = await index.openCursor()
      while (cursor) {
        // The index is ordered by timestamp — values are the raw epoch numbers
        const ts = cursor.key as number
        if (ts < cutoff) {
          await cursor.delete()
          deleted++
        } else {
          break // past cutoff, all remaining are newer
        }
        cursor = await cursor.continue()
      }

      await tx.done

      if (deleted > 0) {
        console.log(`[IndexedDB] Pruned ${deleted} ${label} older than ${Math.round(maxAgeMs / 86_400_000)}d`)
      }
    } catch (error) {
      console.warn(`[IndexedDB] ${label} cleanup error:`, error)
    }

    return deleted
  }

  /**
   * Get storage statistics for all 6 stores
   */
  async getStats(): Promise<{
    activities: number
    positions: number
    arbRounds: number
    gtcOrders: number
    tradeRecords: number
    calibrationData: number
  }> {
    if (!this.db) return { activities: 0, positions: 0, arbRounds: 0, gtcOrders: 0, tradeRecords: 0, calibrationData: 0 }

    try {
      const has = (name: string) => this.db!.objectStoreNames.contains(name as never)
      const [activities, positions, arbRounds, gtcOrders, tradeRecords, calibrationData] = await Promise.all([
        this.db.count('activities'),
        this.db.count('positions'),
        this.db.count('arbRounds'),
        has('gtcOrders') ? this.db.count('gtcOrders') : Promise.resolve(0),
        has('tradeRecords') ? this.db.count('tradeRecords') : Promise.resolve(0),
        has('calibrationData') ? this.db.count('calibrationData') : Promise.resolve(0),
      ])
      return { activities, positions, arbRounds, gtcOrders, tradeRecords, calibrationData }
    } catch {
      return { activities: 0, positions: 0, arbRounds: 0, gtcOrders: 0, tradeRecords: 0, calibrationData: 0 }
    }
  }

  /**
   * Close the database connection
   */
  close(): void {
    if (this.db) {
      this.db.close()
      this.db = null
      this.initPromise = null
    }
  }
}

// Export singleton instance
export const indexedDBService = new IndexedDBService()
