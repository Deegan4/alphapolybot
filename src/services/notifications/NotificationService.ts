import { activityLogger } from '@/services/trading/ActivityLogger'
import { useSettingsStore } from '@/stores/settingsStore'
import { useNotificationStore } from '@/stores/notificationStore'
import type { ActivityType } from '@/types'
import type { NotificationType } from '@/types'

/**
 * Maps ActivityLogger types → notification types
 * Only these activity types trigger notifications (skip scan/analysis/info/system)
 */
const NOTIFY_MAP: Partial<Record<ActivityType, NotificationType>> = {
  trade: 'trade',
  sell: 'success',
  error: 'error',
  warning: 'warning',
}

/**
 * NotificationService - bridges ActivityLogger → toasts, browser notifications, sound
 */
export class NotificationService {
  private unsubscribeLogger: (() => void) | null = null
  private audioContext: AudioContext | null = null

  initialize(): void {
    this.unsubscribeLogger = activityLogger.subscribe((activity) => {
      const notifType = NOTIFY_MAP[activity.type]
      if (!notifType) return // skip uninteresting types

      const settings = useSettingsStore.getState()

      // 1. In-app toast (always, if notifications enabled)
      if (settings.enableNotifications) {
        useNotificationStore.getState().addNotification({
          type: notifType,
          title: this.titleFor(activity.type),
          message: activity.message,
          autoClose: true,
          duration: activity.type === 'error' ? 8000 : 4000,
        })
      }

      // 2. Browser notification
      if (settings.enableNotifications && typeof Notification !== 'undefined') {
        this.sendBrowserNotification(notifType, activity.message)
      }

      // 3. Sound alert
      if (settings.enableSoundAlerts) {
        this.playSound(activity.type)
      }

      // 4. Telegram alert (fire-and-forget)
      const shouldAlert =
        (activity.type === 'trade' || activity.type === 'sell') && settings.alertOnTrade ||
        (activity.type === 'error' || activity.type === 'warning') && settings.alertOnError
      if (shouldAlert && settings.telegramBotToken && settings.telegramChatId) {
        this.sendTelegram(settings.telegramBotToken, settings.telegramChatId, `[${activity.type.toUpperCase()}] ${activity.message}`).catch(() => {})
      }

      // 5. Discord alert (fire-and-forget)
      if (shouldAlert && settings.discordWebhookUrl) {
        this.sendDiscord(settings.discordWebhookUrl, `**${activity.type.toUpperCase()}** — ${activity.message}`).catch(() => {})
      }
    })

    console.log('[NotificationService] Initialized')
  }

  /**
   * Request browser notification permission (call from UI)
   */
  async requestPermission(): Promise<NotificationPermission> {
    if (typeof Notification === 'undefined') return 'denied'
    if (Notification.permission === 'granted') return 'granted'
    return Notification.requestPermission()
  }

  private titleFor(type: ActivityType): string {
    switch (type) {
      case 'trade': return 'Trade Executed'
      case 'sell': return 'Position Closed'
      case 'error': return 'Error'
      case 'warning': return 'Warning'
      default: return 'Notification'
    }
  }

  private sendBrowserNotification(type: NotificationType, message: string): void {
    if (typeof Notification === 'undefined') return
    if (Notification.permission !== 'granted') {
      // Lazy permission request on first notification attempt
      this.requestPermission()
      return
    }

    try {
      new Notification(`AlphaPolyBot: ${this.titleFor(type as ActivityType)}`, {
        body: message,
        icon: '/vite.svg',
        tag: 'alphapolybot', // collapse multiple
      })
    } catch {
      // Browser may block in some contexts - silently ignore
    }
  }

  /**
   * Web Audio API beep - no audio files needed
   */
  playSound(type: ActivityType): void {
    try {
      if (!this.audioContext) {
        this.audioContext = new AudioContext()
      }

      const ctx = this.audioContext
      const oscillator = ctx.createOscillator()
      const gain = ctx.createGain()

      oscillator.connect(gain)
      gain.connect(ctx.destination)

      // Trade/sell = high beep, error/warning = low beep
      const isPositive = type === 'trade' || type === 'sell'
      oscillator.frequency.value = isPositive ? 800 : 300
      oscillator.type = 'sine'

      gain.gain.value = 0.1 // quiet
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.3)

      oscillator.start(ctx.currentTime)
      oscillator.stop(ctx.currentTime + 0.3)
    } catch {
      // AudioContext may not be available - silently ignore
    }
  }

  /**
   * Send a message via Telegram Bot API
   */
  async sendTelegram(botToken: string, chatId: string, text: string): Promise<boolean> {
    try {
      const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' }),
      })
      return res.ok
    } catch (err) {
      console.warn('[NotificationService] Telegram send failed:', err)
      activityLogger.logWarning(`Telegram notification failed: ${err instanceof Error ? err.message : 'unknown'}`)
      return false
    }
  }

  /**
   * Send a message via Discord webhook
   */
  async sendDiscord(webhookUrl: string, content: string): Promise<boolean> {
    try {
      const res = await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content }),
      })
      return res.ok || res.status === 204
    } catch (err) {
      console.warn('[NotificationService] Discord send failed:', err)
      activityLogger.logWarning(`Discord notification failed: ${err instanceof Error ? err.message : 'unknown'}`)
      return false
    }
  }

  destroy(): void {
    if (this.unsubscribeLogger) {
      this.unsubscribeLogger()
      this.unsubscribeLogger = null
    }
    if (this.audioContext) {
      this.audioContext.close()
      this.audioContext = null
    }
  }
}

export const notificationService = new NotificationService()
