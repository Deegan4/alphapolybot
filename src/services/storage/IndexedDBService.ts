import { openDB, type IDBPDatabase } from 'idb'
import type { ActivityItem, ArbRound, PendingGtcOrder } from '@/types'
import type { TrackedPosition } from '@/services/trading/PositionLifecycleManager'
import type { TradeRecord } from '@/services/trading/TradeLogger'

// ==========================================
// DATABASE SCHEMA
// ==========================================

const DB_NAME = 'alphapolybot'
const DB_VERSION = 4

interface AlphaPolyBotDB {
  activities: {
    key: string
    value: StoredActivity
    indexes: { 'by-type': string; 'by-timestamp': number }
  }
  positions: {
    key: string
    value: StoredPosition
    indexes: { 'by-marketId': string; 'by-strategy': string }
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
        upgrade(db) {
          // Activities store
          if (!db.objectStoreNames.contains('activities')) {
            const activityStore = db.createObjectStore('activities', { keyPath: 'id' })
            activityStore.createIndex('by-type', 'type')
            activityStore.createIndex('by-timestamp', 'timestamp')
          }

          // Positions store (tracked positions for crash recovery)
          if (!db.objectStoreNames.contains('positions')) {
            const positionStore = db.createObjectStore('positions', { keyPath: 'tokenId' })
            positionStore.createIndex('by-marketId', 'marketId')
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

      // Auto-cleanup old activities in background
      this.cleanupOldActivities().catch(err =>
        console.warn('[IndexedDB] Cleanup failed:', err)
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
  async removePosition(tokenId: string): Promise<void> {
    if (!this.db) return

    try {
      await this.db.delete('positions', tokenId)
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
        .map(({ id, _storedAt, ...round }) => round)
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

  /**
   * Delete activities older than 30 days
   */
  async cleanupOldActivities(): Promise<number> {
    if (!this.db) return 0

    const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000
    let deleted = 0

    try {
      const tx = this.db.transaction('activities', 'readwrite')
      const index = tx.store.index('by-timestamp')

      // Walk through activities ordered by timestamp
      let cursor = await index.openCursor()
      while (cursor) {
        if (cursor.value.timestamp < thirtyDaysAgo) {
          await cursor.delete()
          deleted++
        } else {
          // Since index is ordered, once we pass the threshold we're done
          break
        }
        cursor = await cursor.continue()
      }

      await tx.done

      if (deleted > 0) {
        console.log(`[IndexedDB] Cleaned up ${deleted} activities older than 30 days`)
      }
    } catch (error) {
      console.warn('[IndexedDB] Cleanup error:', error)
    }

    return deleted
  }

  /**
   * Get storage statistics
   */
  async getStats(): Promise<{
    activities: number
    positions: number
    arbRounds: number
    gtcOrders: number
  }> {
    if (!this.db) return { activities: 0, positions: 0, arbRounds: 0, gtcOrders: 0 }

    try {
      const hasGtc = this.db.objectStoreNames.contains('gtcOrders')
      const [activities, positions, arbRounds, gtcOrders] = await Promise.all([
        this.db.count('activities'),
        this.db.count('positions'),
        this.db.count('arbRounds'),
        hasGtc ? this.db.count('gtcOrders') : Promise.resolve(0),
      ])
      return { activities, positions, arbRounds, gtcOrders }
    } catch {
      return { activities: 0, positions: 0, arbRounds: 0, gtcOrders: 0 }
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
