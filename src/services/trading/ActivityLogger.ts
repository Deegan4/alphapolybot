import type { ActivityItem, ActivityType } from '@/types'

type ActivityCallback = (activity: ActivityItem) => void

/**
 * Activity Logger Service
 * Centralized logging for all bot activities
 */
export class ActivityLogger {
  private activities: ActivityItem[] = []
  private maxActivities = 500
  private callbacks = new Set<ActivityCallback>()

  /**
   * Log an activity
   */
  log(
    type: ActivityType,
    message: string,
    data?: Record<string, unknown>
  ): ActivityItem {
    const activity: ActivityItem = {
      id: crypto.randomUUID(),
      timestamp: new Date(),
      type,
      message,
      data,
    }

    this.activities.unshift(activity)

    // Keep activities limited
    if (this.activities.length > this.maxActivities) {
      this.activities = this.activities.slice(0, this.maxActivities)
    }

    // Notify subscribers
    this.notifySubscribers(activity)

    // Also log to console in debug mode
    if (import.meta.env.VITE_DEBUG_MODE === 'true') {
      const logMethod = type === 'error' ? console.error : 
                       type === 'warning' ? console.warn : console.log
      logMethod(`[${type.toUpperCase()}] ${message}`, data || '')
    }

    return activity
  }

  /**
   * Log a scan activity
   */
  logScan(message: string, data?: Record<string, unknown>): void {
    this.log('scan', message, data)
  }

  /**
   * Log an analysis activity
   */
  logAnalysis(message: string, data?: Record<string, unknown>): void {
    this.log('analysis', message, data)
  }

  /**
   * Log a trade activity
   */
  logTrade(message: string, data?: Record<string, unknown>): void {
    this.log('trade', message, data)
  }

  /**
   * Log a sell activity
   */
  logSell(message: string, data?: Record<string, unknown>): void {
    this.log('sell', message, data)
  }

  /**
   * Log an error
   */
  logError(message: string, error?: Error | unknown): void {
    const data: Record<string, unknown> = {}
    
    if (error instanceof Error) {
      data.error = error.message
      data.stack = error.stack
    } else if (error) {
      data.error = String(error)
    }

    this.log('error', message, data)
  }

  /**
   * Log an info message
   */
  logInfo(message: string, data?: Record<string, unknown>): void {
    this.log('info', message, data)
  }

  /**
   * Log a warning
   */
  logWarning(message: string, data?: Record<string, unknown>): void {
    this.log('warning', message, data)
  }

  /**
   * Log a system message
   */
  logSystem(message: string, data?: Record<string, unknown>): void {
    this.log('system', message, data)
  }

  /**
   * Get all activities
   */
  getActivities(options: {
    type?: ActivityType
    limit?: number
    since?: Date
  } = {}): ActivityItem[] {
    let result = this.activities

    if (options.type) {
      result = result.filter(a => a.type === options.type)
    }

    if (options.since) {
      result = result.filter(a => a.timestamp >= options.since!)
    }

    if (options.limit) {
      result = result.slice(0, options.limit)
    }

    return result
  }

  /**
   * Get recent errors
   */
  getRecentErrors(limit = 10): ActivityItem[] {
    return this.getActivities({ type: 'error', limit })
  }

  /**
   * Get trade activities
   */
  getTradeActivities(limit = 50): ActivityItem[] {
    return this.activities
      .filter(a => a.type === 'trade' || a.type === 'sell')
      .slice(0, limit)
  }

  /**
   * Subscribe to new activities
   */
  subscribe(callback: ActivityCallback): () => void {
    this.callbacks.add(callback)
    return () => this.callbacks.delete(callback)
  }

  /**
   * Clear all activities
   */
  clear(): void {
    this.activities = []
  }

  /**
   * Export activities as JSON
   */
  export(): string {
    return JSON.stringify(this.activities, null, 2)
  }

  /**
   * Get activity statistics
   */
  getStats(): {
    total: number
    byType: Record<ActivityType, number>
    errors24h: number
    trades24h: number
  } {
    const now = Date.now()
    const oneDayAgo = new Date(now - 24 * 60 * 60 * 1000)

    const byType: Record<ActivityType, number> = {
      scan: 0,
      analysis: 0,
      trade: 0,
      sell: 0,
      error: 0,
      info: 0,
      warning: 0,
      system: 0,
    }

    let errors24h = 0
    let trades24h = 0

    for (const activity of this.activities) {
      byType[activity.type]++

      if (activity.timestamp >= oneDayAgo) {
        if (activity.type === 'error') errors24h++
        if (activity.type === 'trade' || activity.type === 'sell') trades24h++
      }
    }

    return {
      total: this.activities.length,
      byType,
      errors24h,
      trades24h,
    }
  }

  private notifySubscribers(activity: ActivityItem): void {
    for (const callback of this.callbacks) {
      try {
        callback(activity)
      } catch (error) {
        console.error('Activity callback error:', error)
      }
    }
  }
}

// Export singleton instance
export const activityLogger = new ActivityLogger()
