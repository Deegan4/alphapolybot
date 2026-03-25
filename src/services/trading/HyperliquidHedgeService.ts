/**
 * HyperliquidHedgeService — Delta hedging for unpaired Polymarket exposure.
 *
 * When a strategy (e.g., Gabagool) fills one side of a dual-side position
 * but the other side hasn't filled yet, this service opens a hedge on
 * Hyperliquid to neutralize directional risk.
 *
 * Example flow:
 *   1. Gabagool fills YES BTC-UP → now long BTC direction
 *   2. HyperliquidHedgeService.openHedge('BTC', 'short', sizeUSD) → shorts BTC on HL
 *   3. Gabagool fills NO BTC-UP → paired, directional risk eliminated
 *   4. HyperliquidHedgeService.closeHedge(hedgeId) → closes HL short
 *
 * Integration with GabagoolStrategy:
 *   When onFill() detects a one-sided fill and imbalance > maxImbalance:
 *     const hedgeId = await hyperliquidHedgeService.openHedge('BTC', oppositeSide, fillSizeUSD)
 *   When the paired fill arrives:
 *     await hyperliquidHedgeService.closeHedge(hedgeId)
 *
 * Integration with LiquidationMomentumStrategy (v2):
 *   After placing a Polymarket directional bet, hedge with opposite HL position.
 *   Close hedge when Polymarket position resolves or is sold.
 *
 * Settings needed (add to settingsStore):
 *   hyperliquidHedgeEnabled: boolean (default false)
 *   hyperliquidMaxHedgeUSD: number (default 10)
 *   hyperliquidHedgeCooldownMs: number (default 5000)
 */

import { ethers } from 'ethers'
import { activityLogger } from './ActivityLogger'
import { useSettingsStore } from '@/stores/settingsStore'

// ==========================================
// TYPES
// ==========================================

export interface HedgePosition {
  id: string
  asset: string
  side: 'long' | 'short'
  sizeUSD: number
  entryPrice: number
  openedAt: number
  closedAt?: number
  status: 'open' | 'closing' | 'closed' | 'failed'
  associatedMarketId?: string  // Polymarket market this hedges
  pnl?: number
}

export interface HedgeResult {
  success: boolean
  hedgeId?: string
  error?: string
}

type HedgeCallback = (hedge: HedgePosition) => void

// Hyperliquid asset indices (mainnet)
const ASSET_INDEX: Record<string, number> = {
  BTC: 0,
  ETH: 1,
  SOL: 4,
  XRP: 11,
}

const HYPERLIQUID_API = 'https://api.hyperliquid.xyz'

// ==========================================
// SERVICE
// ==========================================

export class HyperliquidHedgeService {
  private hedges = new Map<string, HedgePosition>()
  private wallet: ethers.Wallet | null = null
  private lastHedgeTime = 0
  private hedgeCounter = 0
  private onCloseCallbacks = new Set<HedgeCallback>()

  /**
   * Initialize with a wallet for signing Hyperliquid orders.
   * Uses the same wallet as WalletService (shared private key).
   */
  initialize(wallet: ethers.Wallet | ethers.HDNodeWallet): void {
    this.wallet = wallet instanceof ethers.Wallet
      ? wallet
      : new ethers.Wallet(wallet.privateKey)
    console.log('[HLHedge] Initialized with wallet')
  }

  isReady(): boolean {
    return this.wallet !== null
  }

  /**
   * Open a hedge position on Hyperliquid.
   *
   * @param asset - 'BTC', 'ETH', 'SOL', 'XRP'
   * @param side - 'long' or 'short' (opposite of your Polymarket exposure)
   * @param sizeUSD - Position size in USD
   * @param associatedMarketId - Optional Polymarket market ID for tracking
   */
  async openHedge(
    asset: string,
    side: 'long' | 'short',
    sizeUSD: number,
    associatedMarketId?: string,
  ): Promise<HedgeResult> {
    if (!this.wallet) {
      return { success: false, error: 'Not initialized — call initialize() first' }
    }

    const settings = useSettingsStore.getState()
    // Check if hedging is enabled (field may not exist yet in settingsStore)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const hedgeEnabled = (settings as any).hyperliquidHedgeEnabled ?? false
    if (!hedgeEnabled) {
      return { success: false, error: 'Hyperliquid hedging disabled in settings' }
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const maxHedge = (settings as any).hyperliquidMaxHedgeUSD ?? 10
    if (sizeUSD > maxHedge) {
      return { success: false, error: `Size $${sizeUSD} exceeds max hedge $${maxHedge}` }
    }

    // Cooldown check
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const cooldown = (settings as any).hyperliquidHedgeCooldownMs ?? 5000
    if (Date.now() - this.lastHedgeTime < cooldown) {
      return { success: false, error: 'Hedge cooldown active' }
    }

    const assetIndex = ASSET_INDEX[asset.toUpperCase()]
    if (assetIndex === undefined) {
      return { success: false, error: `Unknown asset: ${asset}` }
    }

    const hedgeId = `hedge-${asset}-${++this.hedgeCounter}-${Date.now()}`

    const hedge: HedgePosition = {
      id: hedgeId,
      asset,
      side,
      sizeUSD,
      entryPrice: 0,
      openedAt: Date.now(),
      status: 'open',
      associatedMarketId,
    }

    this.hedges.set(hedgeId, hedge)

    try {
      // Get current mid price for size calculation
      const midPrice = await this.getMidPrice(asset)
      if (!midPrice) {
        hedge.status = 'failed'
        return { success: false, error: `Could not get ${asset} price` }
      }

      hedge.entryPrice = midPrice
      const sizeInAsset = sizeUSD / midPrice

      // Place IOC market order on Hyperliquid
      const isBuy = side === 'long'
      // Slippage: 0.1% for IOC
      const price = isBuy ? midPrice * 1.001 : midPrice * 0.999

      const success = await this.placeOrder(assetIndex, isBuy, price, sizeInAsset)

      if (success) {
        this.lastHedgeTime = Date.now()
        this.log(`HEDGE OPENED: ${side} ${asset} $${sizeUSD.toFixed(2)} @ ${midPrice.toFixed(2)}`)
        activityLogger.logTrade(`HL Hedge: ${side} ${asset} $${sizeUSD.toFixed(2)}`)
        return { success: true, hedgeId }
      } else {
        hedge.status = 'failed'
        return { success: false, error: 'Order placement failed' }
      }
    } catch (err) {
      hedge.status = 'failed'
      const msg = err instanceof Error ? err.message : String(err)
      this.log(`Hedge open failed: ${msg}`)
      return { success: false, error: msg }
    }
  }

  /**
   * Close an existing hedge position.
   */
  async closeHedge(hedgeId: string): Promise<HedgeResult> {
    const hedge = this.hedges.get(hedgeId)
    if (!hedge) return { success: false, error: `Hedge ${hedgeId} not found` }
    if (hedge.status !== 'open') return { success: false, error: `Hedge ${hedgeId} is ${hedge.status}` }

    hedge.status = 'closing'

    try {
      const assetIndex = ASSET_INDEX[hedge.asset.toUpperCase()]
      if (assetIndex === undefined) return { success: false, error: 'Unknown asset' }

      const midPrice = await this.getMidPrice(hedge.asset)
      if (!midPrice) return { success: false, error: 'Could not get price' }

      const sizeInAsset = hedge.sizeUSD / hedge.entryPrice
      // Close = opposite direction
      const isBuy = hedge.side === 'short'
      const price = isBuy ? midPrice * 1.001 : midPrice * 0.999

      const success = await this.placeOrder(assetIndex, isBuy, price, sizeInAsset)

      if (success) {
        hedge.status = 'closed'
        hedge.closedAt = Date.now()
        // Approximate PnL
        const priceDelta = midPrice - hedge.entryPrice
        hedge.pnl = hedge.side === 'long' ? priceDelta * sizeInAsset : -priceDelta * sizeInAsset

        this.log(`HEDGE CLOSED: ${hedge.asset} PnL ~$${hedge.pnl.toFixed(2)}`)
        activityLogger.logTrade(`HL Hedge closed: ${hedge.asset} PnL ~$${hedge.pnl.toFixed(2)}`)

        for (const cb of this.onCloseCallbacks) {
          try { cb(hedge) } catch { /* ignore */ }
        }

        return { success: true, hedgeId }
      } else {
        hedge.status = 'open' // revert
        return { success: false, error: 'Close order failed' }
      }
    } catch (err) {
      hedge.status = 'open' // revert
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    }
  }

  // ==========================================
  // HYPERLIQUID API
  // ==========================================

  private async placeOrder(
    assetIndex: number,
    isBuy: boolean,
    price: number,
    size: number,
  ): Promise<boolean> {
    if (!this.wallet) return false

    try {
      // Build the order action
      const action = {
        type: 'order',
        orders: [{
          a: assetIndex,
          b: isBuy,
          p: price.toPrecision(6),
          s: size.toPrecision(4),
          r: false, // not reduce-only
          t: { limit: { tif: 'Ioc' } },
        }],
        grouping: 'na',
      }

      const nonce = Date.now()
      const actionStr = JSON.stringify(action)

      // Sign with EIP-712 (Hyperliquid's signing scheme)
      const messageHash = ethers.solidityPackedKeccak256(
        ['string', 'uint256'],
        [actionStr, nonce],
      )
      const signature = await this.wallet.signMessage(ethers.getBytes(messageHash))

      const response = await fetch(`${HYPERLIQUID_API}/exchange`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action,
          nonce,
          signature,
          vaultAddress: null,
        }),
      })

      if (!response.ok) {
        const body = await response.text().catch(() => '')
        console.warn(`[HLHedge] Order failed: HTTP ${response.status} ${body}`)
        return false
      }

      const data = await response.json()
      // Hyperliquid returns { status: 'ok', response: { type: 'order', data: {...} } }
      return data?.status === 'ok'
    } catch (err) {
      console.warn('[HLHedge] Order error:', err instanceof Error ? err.message : err)
      return false
    }
  }

  private async getMidPrice(asset: string): Promise<number | null> {
    try {
      const response = await fetch(`${HYPERLIQUID_API}/info`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'allMids' }),
      })

      if (!response.ok) return null

      const mids = await response.json() as Record<string, string>
      const price = parseFloat(mids[asset.toUpperCase()])
      return isNaN(price) ? null : price
    } catch {
      return null
    }
  }

  // ==========================================
  // PUBLIC API
  // ==========================================

  getActiveHedges(): HedgePosition[] {
    return [...this.hedges.values()].filter(h => h.status === 'open')
  }

  getTotalExposure(): number {
    return this.getActiveHedges().reduce((sum, h) => sum + h.sizeUSD, 0)
  }

  onHedgeClosed(callback: HedgeCallback): () => void {
    this.onCloseCallbacks.add(callback)
    return () => this.onCloseCallbacks.delete(callback)
  }

  private log(msg: string): void {
    console.log(`[HLHedge] ${msg}`)
  }
}

// ==========================================
// SINGLETON EXPORT
// ==========================================

export const hyperliquidHedgeService = new HyperliquidHedgeService()
