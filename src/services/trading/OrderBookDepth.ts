/**
 * Order Book Depth Analyzer
 *
 * Checks available liquidity at target price levels before submitting orders.
 * Prevents slippage disasters by capping order size to what the book can absorb.
 *
 * Used by TradingService.placeBet() to validate that sufficient liquidity exists
 * at the desired price level before committing capital.
 */

import { polymarketUSClient } from '@/services/api'
import type { OrderBook } from '@/types'

export interface DepthCheck {
  /** Whether sufficient liquidity exists at the target price */
  sufficient: boolean
  /** Max order size (in USDC) that can fill at the target price ± slippage */
  maxFillableUSD: number
  /** Total liquidity within slippage tolerance */
  availableLiquidity: number
  /** Estimated average fill price (weighted by book depth) */
  estimatedFillPrice: number
  /** Estimated slippage as a fraction (0.01 = 1%) */
  estimatedSlippage: number
  /** Best bid/ask price */
  bestPrice: number
}

export class OrderBookDepthAnalyzer {
  /**
   * Check if sufficient liquidity exists for a buy order.
   *
   * Walks the ask side of the order book to determine how much
   * can fill at the target price ± slippage tolerance.
   *
   * @param slug - The market slug
   * @param orderSizeUSD - Desired order size in USD
   * @param maxSlippage - Maximum acceptable slippage (0.02 = 2%)
   * @returns DepthCheck with liquidity analysis
   */
  async checkBuyDepth(
    slug: string,
    orderSizeUSD: number,
    maxSlippage = 0.02,
  ): Promise<DepthCheck> {
    const book = await polymarketUSClient.getOrderBook(slug)
    if (!book || book.asks.length === 0) {
      return {
        sufficient: false,
        maxFillableUSD: 0,
        availableLiquidity: 0,
        estimatedFillPrice: 0,
        estimatedSlippage: 1,
        bestPrice: 0,
      }
    }

    return this.analyzeDepth(book.asks, orderSizeUSD, maxSlippage, 'BUY')
  }

  /**
   * Check if sufficient liquidity exists for a sell order.
   * Walks the bid side of the order book.
   */
  async checkSellDepth(
    slug: string,
    orderSizeShares: number,
    maxSlippage = 0.02,
  ): Promise<DepthCheck> {
    const book = await polymarketUSClient.getOrderBook(slug)
    if (!book || book.bids.length === 0) {
      return {
        sufficient: false,
        maxFillableUSD: 0,
        availableLiquidity: 0,
        estimatedFillPrice: 0,
        estimatedSlippage: 1,
        bestPrice: 0,
      }
    }

    // For sells, order size is in shares, not USD
    return this.analyzeDepth(book.bids, orderSizeShares, maxSlippage, 'SELL')
  }

  /**
   * Get the maximum order size (in USDC) that can fill within slippage tolerance.
   * Useful for Kelly-sizing cap: min(kellySize, maxFillable).
   */
  async getMaxFillableSize(
    slug: string,
    side: 'BUY' | 'SELL',
    maxSlippage = 0.02,
  ): Promise<number> {
    const book = await polymarketUSClient.getOrderBook(slug)
    if (!book) return 0

    const levels = side === 'BUY' ? book.asks : book.bids
    if (levels.length === 0) return 0

    const bestPrice = levels[0].price
    const maxPrice = side === 'BUY'
      ? bestPrice * (1 + maxSlippage)
      : bestPrice * (1 - maxSlippage)

    let totalFillable = 0
    for (const level of levels) {
      if (side === 'BUY' && level.price > maxPrice) break
      if (side === 'SELL' && level.price < maxPrice) break
      totalFillable += level.price * level.size
    }

    return totalFillable
  }

  /**
   * Walk the order book levels to compute fill analysis.
   */
  private analyzeDepth(
    levels: Array<{ price: number; size: number }>,
    orderSize: number,
    maxSlippage: number,
    side: 'BUY' | 'SELL',
  ): DepthCheck {
    const bestPrice = levels[0].price
    const maxAcceptablePrice = side === 'BUY'
      ? bestPrice * (1 + maxSlippage)
      : bestPrice * (1 - maxSlippage)

    let filled = 0
    let totalCost = 0
    let totalLiquidity = 0

    for (const level of levels) {
      // Stop if price exceeds slippage tolerance
      if (side === 'BUY' && level.price > maxAcceptablePrice) break
      if (side === 'SELL' && level.price < maxAcceptablePrice) break

      const levelValueUSD = level.price * level.size
      totalLiquidity += levelValueUSD

      const remaining = orderSize - filled
      if (remaining <= 0) break

      const fillAtLevel = Math.min(
        side === 'BUY' ? levelValueUSD : level.size,
        remaining,
      )

      filled += fillAtLevel
      totalCost += side === 'BUY'
        ? fillAtLevel // already in USD for buys
        : fillAtLevel * level.price // shares × price for sells
    }

    const estimatedFillPrice = filled > 0
      ? (side === 'BUY' ? totalCost / (filled / bestPrice) : totalCost / filled)
      : 0

    const estimatedSlippage = bestPrice > 0
      ? Math.abs(estimatedFillPrice - bestPrice) / bestPrice
      : 1

    return {
      sufficient: filled >= orderSize * 0.95, // Allow 5% partial
      maxFillableUSD: totalLiquidity,
      availableLiquidity: totalLiquidity,
      estimatedFillPrice: Math.round(estimatedFillPrice * 10000) / 10000,
      estimatedSlippage: Math.round(estimatedSlippage * 10000) / 10000,
      bestPrice,
    }
  }
}

// Export singleton
export const orderBookDepth = new OrderBookDepthAnalyzer()
