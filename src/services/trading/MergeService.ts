/**
 * Merge Service — on-chain conditional token merging for Polymarket.
 *
 * After a dual-side hedge fills both YES and NO legs, this service
 * merges the conditional tokens back into USDC.e on-chain, recovering
 * capital immediately instead of waiting for market resolution.
 *
 * Merging is a best-effort optimization:
 * - For 5-min crypto markets, positions resolve in 5 min anyway
 * - For longer markets, merging unlocks capital for re-deployment
 * - If merge fails (no gas, RPC down), positions still resolve normally
 *
 * Architecture:
 *   MergeService.merge(conditionId, amount) →
 *     ConditionalTokens.mergePositions(USDC.e, 0x0, conditionId, [1,2], amount)
 *   Burns 1 YES + 1 NO → returns 1 USDC.e per unit
 *
 * Requires: MATIC for gas (~$0.001 on Polygon)
 */

import { ethers } from 'ethers'
import { activityLogger } from './ActivityLogger'

// ==========================================
// CONTRACT ADDRESSES (Polygon mainnet)
// ==========================================

/** Gnosis ConditionalTokens Framework contract on Polygon */
const CTF_ADDRESS = import.meta.env.VITE_POLYMARKET_CTF_ADDRESS || '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045'

/** USDC.e (bridged) on Polygon — the collateral token */
const USDC_E_ADDRESS = import.meta.env.VITE_USDC_ADDRESS || '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174'

/** Default Polygon RPC — PublicNode free endpoint (no API key required) */
const POLYGON_RPC = import.meta.env.VITE_POLYGON_RPC_URL || 'https://polygon-bor-rpc.publicnode.com'

// ==========================================
// MINIMAL ABI (only what we need)
// ==========================================

const CTF_MERGE_ABI = [
  'function mergePositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] partition, uint256 amount)',
  'function balanceOf(address account, uint256 positionId) view returns (uint256)',
]

// ==========================================
// TYPES
// ==========================================

export interface MergeResult {
  success: boolean
  txHash?: string
  amountMerged?: number  // in USDC.e units (6 decimals)
  error?: string
}

// ==========================================
// SERVICE
// ==========================================

export class MergeService {
  private provider: ethers.JsonRpcProvider | null = null
  private connectedWallet: ethers.Wallet | null = null
  private ctfContract: ethers.Contract | null = null

  /**
   * Initialize with a wallet that has signing capability.
   * Connects the wallet to a Polygon provider for on-chain TX.
   */
  initialize(wallet: ethers.Wallet | ethers.HDNodeWallet): void {
    try {
      this.provider = new ethers.JsonRpcProvider(POLYGON_RPC)
      // Connect the wallet to the provider (wallet may be provider-less)
      this.connectedWallet = (wallet instanceof ethers.Wallet)
        ? wallet.connect(this.provider)
        : new ethers.Wallet(wallet.privateKey, this.provider)

      this.ctfContract = new ethers.Contract(CTF_ADDRESS, CTF_MERGE_ABI, this.connectedWallet)
      console.log(`[MergeService] Initialized with CTF at ${CTF_ADDRESS}`)
    } catch (err) {
      console.warn('[MergeService] Failed to initialize:', err instanceof Error ? err.message : err)
    }
  }

  /** Check if the service is ready for on-chain operations */
  isReady(): boolean {
    return this.connectedWallet !== null && this.ctfContract !== null
  }

  /**
   * Merge conditional tokens back to USDC.e.
   *
   * Burns `amount` of both YES (positionId=1) and NO (positionId=2) tokens
   * for the given conditionId, receiving `amount` USDC.e back.
   *
   * @param conditionId - The market's condition ID (bytes32 hex string)
   * @param amount - Amount to merge in USDC.e base units (6 decimals).
   *                 E.g., 2_000_000 = $2.00
   */
  async merge(conditionId: string, amount: bigint): Promise<MergeResult> {
    if (!this.ctfContract || !this.connectedWallet) {
      return { success: false, error: 'MergeService not initialized — call initialize() first' }
    }

    if (!conditionId || conditionId === '0x' || conditionId.length < 10) {
      return { success: false, error: `Invalid conditionId: ${conditionId}` }
    }

    if (amount <= 0n) {
      return { success: false, error: 'Amount must be positive' }
    }

    try {
      console.log(`[MergeService] Merging ${amount} units for condition ${conditionId.slice(0, 10)}...`)

      // Binary market partition: [1, 2] (YES=1, NO=2)
      const partition = [1, 2]
      const parentCollectionId = ethers.ZeroHash // top-level condition

      const tx = await this.ctfContract.mergePositions(
        USDC_E_ADDRESS,
        parentCollectionId,
        conditionId,
        partition,
        amount,
      )

      console.log(`[MergeService] TX submitted: ${tx.hash}`)
      const receipt = await tx.wait()

      if (receipt.status === 1) {
        const amountUSDC = Number(amount) / 1e6
        console.log(`[MergeService] Merge complete: ${amountUSDC.toFixed(2)} USDC.e recovered`)
        activityLogger.logTrade(`Merged ${amountUSDC.toFixed(2)} USDC.e from condition ${conditionId.slice(0, 10)}...`)

        return {
          success: true,
          txHash: tx.hash,
          amountMerged: amountUSDC,
        }
      }

      return { success: false, error: 'Transaction reverted', txHash: tx.hash }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)

      // Common failure modes — bail immediately on non-transient errors:
      if (msg.includes('401') || msg.includes('403') || msg.includes('Unauthorized') ||
          msg.includes('API key disabled') || msg.includes('tenant disabled') ||
          msg.includes('authenticate your request')) {
        console.warn('[MergeService] RPC auth error — check VITE_POLYGON_RPC_URL or switch provider')
        return { success: false, error: 'RPC auth error (not transient)' }
      }
      if (msg.includes('insufficient funds')) {
        console.warn('[MergeService] No MATIC for gas — merge skipped (positions will resolve normally)')
        return { success: false, error: 'Insufficient MATIC for gas' }
      }
      if (msg.includes('ERC1155: burn amount exceeds balance')) {
        console.warn('[MergeService] Token balance insufficient for merge')
        return { success: false, error: 'Insufficient token balance for merge' }
      }

      console.warn(`[MergeService] Merge failed: ${msg}`)
      return { success: false, error: msg }
    }
  }

  /**
   * Compute the merge amount from filled hedge prices and sizes.
   *
   * For a dual-side hedge, the mergeable amount is the minimum of
   * YES and NO token balances (you need equal amounts to merge).
   *
   * @param yesSize - YES tokens held (in contract shares, not USDC)
   * @param noSize - NO tokens held (in contract shares, not USDC)
   * @returns Amount in USDC.e base units (6 decimals) that can be merged
   */
  computeMergeAmount(yesSize: number, noSize: number): bigint {
    // Merge requires equal YES and NO — take the minimum
    const mergeableShares = Math.min(yesSize, noSize)
    if (mergeableShares <= 0) return 0n

    // Convert to USDC.e base units (6 decimals)
    // 1 share pair (1 YES + 1 NO) merges into 1 USDC.e
    return ethers.parseUnits(mergeableShares.toFixed(6), 6)
  }
}

// ==========================================
// SINGLETON EXPORT
// ==========================================

export const mergeService = new MergeService()
