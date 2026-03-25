/**
 * LLM Interaction Store
 *
 * Persists full LLM prompt→response→outcome triples to IndexedDB.
 * This is the highest-value training signal: what the model saw,
 * what it predicted, and what actually happened.
 *
 * Stored interactions become training pairs for fine-tuning:
 *   system prompt + user prompt → assistant response (+ outcome label)
 */

export interface LLMInteraction {
  id: string
  timestamp: number

  // Request context
  provider: 'ollama'
  model: string
  promptType: 'prediction' | 'crypto' | 'signal-confirmation' | 'direction' | 'dependency'
  systemPrompt?: string
  userPrompt: string
  temperature: number

  // Market context snapshot
  marketId?: string
  marketQuestion?: string
  marketPrice?: number       // YES price at request time
  volume24h?: number
  liquidity?: number

  // Response
  rawResponse: string        // Unparsed model output
  parsedPrediction?: string  // 'yes' | 'no' | 'up' | 'down'
  parsedConfidence?: number  // 0-100
  parsedReasoning?: string
  responseTimeMs: number
  costUSD: number

  // Outcome (filled in later when market resolves or position closes)
  actualOutcome?: string     // 'yes' | 'no' | 'up' | 'down'
  resolvedAt?: number
  pnlUSD?: number
  wasCorrect?: boolean       // parsedPrediction === actualOutcome

  // Training metadata
  exported?: boolean         // true after included in a training export
}

/**
 * Lightweight wrapper around IndexedDB for LLM interaction persistence.
 * Uses the same idb library as IndexedDBService but manages its own store
 * to avoid circular dependencies and version bumps on the main DB.
 */
export class LLMInteractionStore {
  private buffer: LLMInteraction[] = []
  private flushTimer: ReturnType<typeof setInterval> | null = null
  private static readonly FLUSH_INTERVAL_MS = 10_000  // 10s batch writes
  private static readonly MAX_BUFFER = 50
  private static readonly MAX_STORED = 10_000  // Cap at 10k interactions

  constructor() {
    this.flushTimer = setInterval(() => this.flush(), LLMInteractionStore.FLUSH_INTERVAL_MS)
  }

  /**
   * Record an LLM interaction. Buffered and flushed periodically.
   */
  record(interaction: Omit<LLMInteraction, 'id' | 'timestamp'>): string {
    const id = crypto.randomUUID()
    const entry: LLMInteraction = {
      id,
      timestamp: Date.now(),
      ...interaction,
    }
    this.buffer.push(entry)

    if (this.buffer.length >= LLMInteractionStore.MAX_BUFFER) {
      this.flush()
    }

    // Dual-write to Supabase (fire-and-forget)
    import('@/services/storage/SupabaseService').then(({ supabaseService }) => {
      supabaseService.recordInteraction(entry)
    }).catch(() => { /* Supabase is best-effort */ })

    return id
  }

  /**
   * Update an interaction with outcome data (when market resolves).
   */
  async recordOutcome(interactionId: string, outcome: {
    actualOutcome: string
    pnlUSD?: number
  }): Promise<void> {
    // Check buffer first
    const buffered = this.buffer.find(i => i.id === interactionId)
    if (buffered) {
      buffered.actualOutcome = outcome.actualOutcome
      buffered.pnlUSD = outcome.pnlUSD
      buffered.resolvedAt = Date.now()
      buffered.wasCorrect = buffered.parsedPrediction === outcome.actualOutcome
      return
    }

    // Dual-write outcome to Supabase
    import('@/services/storage/SupabaseService').then(({ supabaseService }) => {
      supabaseService.recordOutcome(interactionId, outcome)
    }).catch(() => { /* best-effort */ })

    // Otherwise update in IndexedDB
    try {
      const { indexedDBService } = await import('@/services/storage')
      const db = (indexedDBService as unknown as { db: IDBDatabase | null }).db
      if (!db) return

      const tx = db.transaction('llmInteractions', 'readwrite')
      const store = tx.objectStore('llmInteractions')
      const existing = await wrapRequest<LLMInteraction>(store.get(interactionId))
      if (existing) {
        existing.actualOutcome = outcome.actualOutcome
        existing.pnlUSD = outcome.pnlUSD
        existing.resolvedAt = Date.now()
        existing.wasCorrect = existing.parsedPrediction === outcome.actualOutcome
        store.put(existing)
      }
    } catch {
      // Non-critical — outcome data is best-effort enrichment
    }
  }

  /**
   * Load all interactions (for export).
   */
  async loadAll(): Promise<LLMInteraction[]> {
    await this.flush()
    try {
      const { indexedDBService } = await import('@/services/storage')
      const db = (indexedDBService as unknown as { db: IDBDatabase | null }).db
      if (!db || !db.objectStoreNames.contains('llmInteractions')) return []

      const tx = db.transaction('llmInteractions', 'readonly')
      const store = tx.objectStore('llmInteractions')
      return await wrapRequest<LLMInteraction[]>(store.getAll())
    } catch {
      return []
    }
  }

  /**
   * Load interactions with outcome data (resolved predictions).
   */
  async loadResolved(): Promise<LLMInteraction[]> {
    const all = await this.loadAll()
    return all.filter(i => i.actualOutcome != null)
  }

  /**
   * Get count of stored interactions.
   */
  async count(): Promise<number> {
    try {
      const { indexedDBService } = await import('@/services/storage')
      const db = (indexedDBService as unknown as { db: IDBDatabase | null }).db
      if (!db || !db.objectStoreNames.contains('llmInteractions')) return this.buffer.length

      const tx = db.transaction('llmInteractions', 'readonly')
      const store = tx.objectStore('llmInteractions')
      const dbCount = await wrapRequest<number>(store.count())
      return dbCount + this.buffer.length
    } catch {
      return this.buffer.length
    }
  }

  /**
   * Mark interactions as exported (so we can track what's been used for training).
   */
  async markExported(ids: string[]): Promise<void> {
    try {
      const { indexedDBService } = await import('@/services/storage')
      const db = (indexedDBService as unknown as { db: IDBDatabase | null }).db
      if (!db) return

      const tx = db.transaction('llmInteractions', 'readwrite')
      const store = tx.objectStore('llmInteractions')
      for (const id of ids) {
        const existing = await wrapRequest<LLMInteraction>(store.get(id))
        if (existing) {
          existing.exported = true
          store.put(existing)
        }
      }
    } catch {
      // Non-critical
    }
  }

  /**
   * Flush buffered interactions to IndexedDB.
   */
  async flush(): Promise<void> {
    if (this.buffer.length === 0) return

    const batch = this.buffer.splice(0)
    try {
      const { indexedDBService } = await import('@/services/storage')
      const db = (indexedDBService as unknown as { db: IDBDatabase | null }).db
      if (!db) {
        // Put them back if DB not ready
        this.buffer.unshift(...batch)
        return
      }

      // Create the store if it doesn't exist (first run after upgrade)
      if (!db.objectStoreNames.contains('llmInteractions')) {
        // Can't create stores outside versionchange — items will be lost
        // This should only happen if IndexedDB version hasn't been bumped yet
        console.warn('[LLMInteractionStore] Store not found — interactions will be lost until DB upgrade')
        return
      }

      const tx = db.transaction('llmInteractions', 'readwrite')
      const store = tx.objectStore('llmInteractions')
      for (const item of batch) {
        store.put(item)
      }
    } catch {
      // Non-critical — don't re-buffer to avoid infinite growth
      console.warn('[LLMInteractionStore] Flush failed, dropped', batch.length, 'interactions')
    }
  }

  destroy(): void {
    if (this.flushTimer) {
      clearInterval(this.flushTimer)
      this.flushTimer = null
    }
    this.flush()
  }
}

/** Wrap IDBRequest in a Promise */
function wrapRequest<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

// Singleton
export const llmInteractionStore = new LLMInteractionStore()
