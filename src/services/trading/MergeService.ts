/**
 * Merge Service — conditional token merging for Polymarket.
 *
 * After accumulating both YES and NO shares, this service merges the
 * conditional tokens back into USDC.e, recovering capital immediately
 * instead of waiting for market resolution.
 *
 * Two execution paths:
 *   1. **Relayer** (preferred) — gasless merge via Polymarket Relayer API.
 *      Signs the merge off-chain, relayer submits on-chain and pays gas.
 *   2. **Direct on-chain** (fallback) — wallet signs + submits TX on Polygon.
 *      Requires MATIC for gas (~$0.001).
 *
 * Architecture:
 *   merge(conditionId, amount) →
 *     relayer available? → POST /merge via relayer (gasless)
 *     no relayer?        → CTF.mergePositions on-chain (pays gas)
 *   Burns 1 YES + 1 NO → returns 1 USDC.e per unit
 */

import { ethers } from 'ethers'
import { activityLogger } from './ActivityLogger'
import { useSettingsStore } from '@/stores/settingsStore'

// ==========================================
// CONTRACT ADDRESSES (Polygon mainnet)
// ==========================================

/** Gnosis ConditionalTokens Framework contract on Polygon */
const CTF_ADDRESS = import.meta.env.VITE_POLYMARKET_CTF_ADDRESS || '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045'

/** USDC.e (bridged) on Polygon — the collateral token */
const USDC_E_ADDRESS = import.meta.env.VITE_USDC_ADDRESS || '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174'

/** Default Polygon RPC — PublicNode free endpoint (no API key required) */
const POLYGON_RPC = import.meta.env.VITE_POLYGON_RPC_URL || 'https://polygon-bor-rpc.publicnode.com'

/** Polymarket Relayer API base URL (proxied via Vite in dev) */
const RELAYER_BASE_URL = import.meta.env.VITE_RELAYER_API_URL || '/api/clob'

/** Relayer signer address (public, not secret) */
const RELAYER_ADDRESS = '0xe19b8c817510f87d4413ebc6d45f9b42b77ede33'

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
  via?: 'relayer' | 'direct'  // which path was used
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

  /** Check if the relayer API key is configured (sync Zustand read) */
  private getRelayerApiKey(): string {
    return useSettingsStore.getState().relayerApiKey || ''
  }

  /**
   * Merge conditional tokens back to USDC.e.
   *
   * Tries relayer first (gasless), falls back to direct on-chain if
   * relayer is not configured or fails.
   *
   * @param conditionId - The market's condition ID (bytes32 hex string)
   * @param amount - Amount to merge in USDC.e base units (6 decimals).
   *                 E.g., 2_000_000 = $2.00
   */
  async merge(conditionId: string, amount: bigint): Promise<MergeResult> {
    if (!conditionId || conditionId === '0x' || conditionId.length < 10) {
      return { success: false, error: `Invalid conditionId: ${conditionId}` }
    }

    if (amount <= 0n) {
      return { success: false, error: 'Amount must be positive' }
    }

    // Try relayer first (gasless)
    const relayerKey = this.getRelayerApiKey()
    if (relayerKey) {
      const relayerResult = await this.mergeViaRelayer(conditionId, amount, relayerKey)
      if (relayerResult.success) return relayerResult

      // Relayer failed — fall through to direct if available
      console.warn(`[MergeService] Relayer failed (${relayerResult.error}), trying direct on-chain...`)
    }

    // Fallback: direct on-chain merge
    return this.mergeDirectOnChain(conditionId, amount)
  }

  /**
   * Gasless merge via Polymarket Relayer API.
   *
   * The relayer submits the merge transaction on-chain and pays gas.
   * We just need to authenticate with our API key.
   */
  private async mergeViaRelayer(conditionId: string, amount: bigint, apiKey: string): Promise<MergeResult> {
    try {
      const amountStr = amount.toString()
      console.log(`[MergeService] Relayer merge: ${amountStr} units for ${conditionId.slice(0, 10)}...`)

      const response = await fetch(`${RELAYER_BASE_URL}/merge`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'RELAYER_API_KEY': apiKey,
          'RELAYER_API_KEY_ADDRESS': RELAYER_ADDRESS,
        },
        body: JSON.stringify({
          conditionId,
          amount: amountStr,
          collateralAddress: USDC_E_ADDRESS,
          ctfAddress: CTF_ADDRESS,
        }),
      })

      if (!response.ok) {
        const body = await response.text().catch(() => '')
        if (response.status === 401 || response.status === 403) {
          return { success: false, error: `Relayer auth failed (${response.status}): ${body}`, via: 'relayer' }
        }
        return { success: false, error: `Relayer HTTP ${response.status}: ${body}`, via: 'relayer' }
      }

      const data = await response.json()
      const txHash = data.txHash || data.hash || data.transactionHash || ''
      const amountUSDC = Number(amount) / 1e6

      console.log(`[MergeService] Relayer merge submitted: ${txHash}`)
      activityLogger.logTrade(`Merged ${amountUSDC.toFixed(2)} USDC.e via relayer (gasless) from ${conditionId.slice(0, 10)}...`)

      return {
        success: true,
        txHash,
        amountMerged: amountUSDC,
        via: 'relayer',
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.warn(`[MergeService] Relayer merge failed: ${msg}`)
      return { success: false, error: msg, via: 'relayer' }
    }
  }

  /**
   * Direct on-chain merge (original flow). Requires wallet + MATIC for gas.
   */
  private async mergeDirectOnChain(conditionId: string, amount: bigint): Promise<MergeResult> {
    if (!this.ctfContract || !this.connectedWallet) {
      return { success: false, error: 'MergeService not initialized — call initialize() first', via: 'direct' }
    }

    try {
      console.log(`[MergeService] Direct merge: ${amount} units for ${conditionId.slice(0, 10)}...`)

      const partition = [1, 2]
      const parentCollectionId = ethers.ZeroHash

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
          via: 'direct',
        }
      }

      return { success: false, error: 'Transaction reverted', txHash: tx.hash, via: 'direct' }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)

      if (msg.includes('401') || msg.includes('403') || msg.includes('Unauthorized') ||
          msg.includes('API key disabled') || msg.includes('tenant disabled') ||
          msg.includes('authenticate your request')) {
        console.warn('[MergeService] RPC auth error — check VITE_POLYGON_RPC_URL or switch provider')
        return { success: false, error: 'RPC auth error (not transient)', via: 'direct' }
      }
      if (msg.includes('insufficient funds')) {
        console.warn('[MergeService] No MATIC for gas — merge skipped (positions will resolve normally)')
        return { success: false, error: 'Insufficient MATIC for gas', via: 'direct' }
      }
      if (msg.includes('ERC1155: burn amount exceeds balance')) {
        console.warn('[MergeService] Token balance insufficient for merge')
        return { success: false, error: 'Insufficient token balance for merge', via: 'direct' }
      }

      console.warn(`[MergeService] Merge failed: ${msg}`)
      return { success: false, error: msg, via: 'direct' }
    }
  }

  /**
   * Compute the merge amount from filled hedge prices and sizes.
   *
   * @param yesSize - YES tokens held (in contract shares, not USDC)
   * @param noSize - NO tokens held (in contract shares, not USDC)
   * @returns Amount in USDC.e base units (6 decimals) that can be merged
   */
  computeMergeAmount(yesSize: number, noSize: number): bigint {
    const mergeableShares = Math.min(yesSize, noSize)
    if (mergeableShares <= 0) return 0n

    return ethers.parseUnits(mergeableShares.toFixed(6), 6)
  }
}

// ==========================================
// SINGLETON EXPORT
// ==========================================

export const mergeService = new MergeService()
