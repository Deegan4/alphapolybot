import { ethers } from 'ethers'
import { 
  POLYGON_NETWORK, 
  CONTRACT_ADDRESSES, 
  USDC_ABI, 
  CTF_ABI,
  type WalletState,
  type TokenApprovals,
  type TransactionResult,
} from '@/types'
import { CLOBClient, clobClient, dataClient } from '@/services/api'

/**
 * Wallet Service
 * Handles wallet connection, balance tracking, and token approvals
 */
export class WalletService {
  private wallet: ethers.Wallet | null = null
  private provider: ethers.JsonRpcProvider | null = null
  private state: WalletState = {
    address: null,
    proxyAddress: null,
    balance: 0,
    usdcBalance: 0,
    usdcBridgedBalance: 0,
    usdcNativeBalance: 0,
    isConnected: false,
    isConnecting: false,
    chainId: null,
    lastSync: null,
    approvals: { usdc: false, ctf: false, usdcNegRisk: false, ctfNegRisk: false, usdcNegRiskAdapter: false, ctfNegRiskAdapter: false },
    error: null,
  }

  private listeners: Set<(state: WalletState) => void> = new Set()

  /**
   * Subscribe to state changes
   */
  subscribe(listener: (state: WalletState) => void): () => void {
    this.listeners.add(listener)
    listener(this.state) // Send current state immediately
    return () => this.listeners.delete(listener)
  }

  /**
   * Notify all listeners of state change
   */
  private notifyListeners(): void {
    this.listeners.forEach(listener => listener(this.state))
  }

  /**
   * Update state
   */
  private updateState(updates: Partial<WalletState>): void {
    this.state = { ...this.state, ...updates }
    this.notifyListeners()
  }

  /**
   * Get current state
   */
  getState(): WalletState {
    return this.state
  }

  /**
   * Get wallet instance
   */
  getWallet(): ethers.Wallet | null {
    return this.wallet
  }

  /**
   * Get provider instance
   */
  getProvider(): ethers.JsonRpcProvider | null {
    return this.provider
  }

  /**
   * Set the Polymarket proxy (funder) address manually.
   * NOTE: connect() now auto-computes the correct proxy via CREATE2.
   * This method is kept for backward compatibility but the computed
   * proxy will override it during connect() if there's a mismatch.
   */
  setProxyAddress(proxy: string | null): void {
    const normalized = proxy?.trim() || null
    this.updateState({ proxyAddress: normalized })

    if (normalized) {
      clobClient.setFunder(normalized)
      console.log(`[WalletService] Proxy address set (manual): ${normalized}`)
    } else {
      clobClient.setFunder(null)
      console.log('[WalletService] Proxy address cleared — using EOA directly')
    }
  }

  /**
   * Connect wallet using seed phrase OR raw private key (hex)
   */
  async connect(secret: string): Promise<boolean> {
    this.updateState({ isConnecting: true, error: null })

    try {
      // Create provider with fallback
      this.provider = await this.createProvider()

      // Detect input type: hex private key vs. mnemonic seed phrase
      const trimmed = secret.trim()
      const isHexKey = /^(0x)?[0-9a-fA-F]{64}$/.test(trimmed)

      if (isHexKey) {
        // Raw private key (with or without 0x prefix)
        const key = trimmed.startsWith('0x') ? trimmed : `0x${trimmed}`
        this.wallet = new ethers.Wallet(key, this.provider)
        console.log('[WalletService] Connected via private key')
      } else if (ethers.Mnemonic.isValidMnemonic(trimmed)) {
        // BIP-39 mnemonic seed phrase
        const hdNode = ethers.HDNodeWallet.fromPhrase(trimmed)
        this.wallet = hdNode.connect(this.provider)
        console.log('[WalletService] Connected via seed phrase')
      } else {
        throw new Error('Invalid input — enter a 12/24 word seed phrase or a 64-character hex private key')
      }
      
      const address = await this.wallet.getAddress()
      
      // Verify network
      const network = await this.provider.getNetwork()
      if (Number(network.chainId) !== POLYGON_NETWORK.chainId) {
        throw new Error(`Wrong network. Expected Polygon (${POLYGON_NETWORK.chainId}), got ${network.chainId}`)
      }

      // ─── Compute the deterministic Polymarket proxy wallet address ───
      // Polymarket's on-chain verifyPolyProxySignature() checks that the
      // order's `maker` field matches the CREATE2-derived proxy address for
      // the signer EOA. If these don't match → "invalid signature".
      //
      // We compute it deterministically from the signer's address using the
      // same CREATE2 formula as the on-chain PolyProxyLib.
      const computedProxy = CLOBClient.computePolyProxyAddress(address)
      console.log(`[WalletService] Computed proxy for signer ${address}: ${computedProxy}`)

      // Verify the computed proxy is actually deployed on-chain
      let proxyAddress: string | null = null
      const code = await this.provider.getCode(computedProxy)
      if (code !== '0x') {
        proxyAddress = computedProxy
        console.log(`[WalletService] Proxy wallet confirmed on-chain: ${proxyAddress}`)
      } else {
        console.warn(`[WalletService] Computed proxy ${computedProxy} is NOT deployed — using EOA mode`)
      }

      // Warn if user had a different proxy stored (common source of "invalid signature")
      const storedProxy = this.state.proxyAddress
      if (storedProxy && proxyAddress && storedProxy.toLowerCase() !== proxyAddress.toLowerCase()) {
        console.warn(
          `[WalletService] ⚠️ PROXY MISMATCH DETECTED!\n` +
          `  Stored proxy:   ${storedProxy}\n` +
          `  Computed proxy: ${proxyAddress}\n` +
          `  Using computed proxy (CREATE2-derived) — stored value was incorrect.`,
        )
      }

      // Initialize API clients with wallet + proxy info
      clobClient.setWallet(this.wallet)
      if (proxyAddress) {
        clobClient.setFunder(proxyAddress)
      }
      dataClient.setWalletAddress(proxyAddress || address)

      // Load CLOB API credentials — ALWAYS try deriveApiKey() first.
      // deriveApiKey() registers our signer→proxy mapping on the CLOB server
      // and returns credentials bound to THIS wallet's signer key.
      // Builder Codes from polymarket.com are bound to THAT site's signer,
      // causing "invalid signature" on order placement if the keys don't match.
      const derivedCreds = await clobClient.deriveApiKey()
      if (derivedCreds) {
        console.log('[WalletService] CLOB API credentials derived from wallet (signer→proxy mapping registered)')
      } else {
        // Derivation failed — fall back to manually-entered Builder Codes
        const { useSettingsStore } = await import('@/stores/settingsStore')
        const { clobApiKey, clobSecret, clobPassphrase } = useSettingsStore.getState()

        if (clobApiKey && clobSecret && clobPassphrase) {
          clobClient.setCredentials({ key: clobApiKey, secret: clobSecret, passphrase: clobPassphrase })
          console.log('[WalletService] CLOB API credentials loaded from settings (Builder Codes)')
          console.warn(
            '[WalletService] WARNING: Builder Codes from polymarket.com are tied to that site\'s signer key. ' +
            'Order signing will fail with "invalid signature" if this wallet\'s private key differs from ' +
            'the one used on polymarket.com. Use Settings → API Keys → "Derive from Wallet" instead.',
          )
        } else {
          console.warn('[WalletService] No CLOB API credentials available — add Builder Codes in Settings → API Keys, or check wallet connection')
        }
      }

      this.updateState({
        address,
        proxyAddress: proxyAddress || null,
        isConnected: true,
        isConnecting: false,
        chainId: Number(network.chainId),
      })

      // Fetch initial data (small delay between calls to avoid RPC rate limiting)
      await this.syncBalances()
      await new Promise(r => setTimeout(r, 500))
      await this.checkApprovals()

      // Validate that credentials actually work (catches signer mismatch early)
      if (clobClient.hasCredentials()) {
        const validation = await clobClient.validateCredentials()
        if (!validation.valid) {
          console.error(`[WalletService] CLOB credential validation FAILED: ${validation.error}`)
        } else {
          console.log('[WalletService] CLOB credentials validated successfully')
          // Refresh the CLOB's cached balance from on-chain so pre-flight checks
          // see actual funds instead of stale $0 (the CLOB caches aggressively).
          await clobClient.updateBalanceAllowance()
        }
      }

      return true
    } catch (error) {
      console.error('Failed to connect wallet:', error)
      this.updateState({
        isConnecting: false,
        isConnected: false,
        error: error instanceof Error ? error.message : 'Failed to connect wallet',
      })
      return false
    }
  }

  /**
   * Disconnect wallet
   */
  disconnect(): void {
    this.wallet = null
    this.provider = null
    clobClient.setFunder(null)
    this.updateState({
      address: null,
      proxyAddress: null,
      balance: 0,
      usdcBalance: 0,
      usdcBridgedBalance: 0,
      usdcNativeBalance: 0,
      isConnected: false,
      isConnecting: false,
      chainId: null,
      lastSync: null,
      approvals: { usdc: false, ctf: false, usdcNegRisk: false, ctfNegRisk: false, usdcNegRiskAdapter: false, ctfNegRiskAdapter: false },
      error: null,
    })
  }

  /**
   * Create provider with fallback
   */
  private async createProvider(): Promise<ethers.JsonRpcProvider> {
    const urls = [
      POLYGON_NETWORK.rpcUrl,
      POLYGON_NETWORK.rpcFallback,
    ].filter(Boolean) as string[]

    for (const url of urls) {
      // ethers.js v6 parses URLs itself and rejects relative paths like "/api/..."
      // as "unsupported protocol". Prepend origin so it sees http://localhost:PORT/...
      const fullUrl = url.startsWith('/') ? `${window.location.origin}${url}` : url
      try {
        const provider = new ethers.JsonRpcProvider(fullUrl)
        const network = await provider.getNetwork() // Test connection

        // The Polygon gas station plugin may cause errors during tx sending,
        // but ethers v6 Network has no removePlugin() API. Handle errors at tx time.
        if (network.getPlugin('org.ethers.plugins.network.FetchUrlFeeDataPlugin')) {
          console.log('[WalletService] Note: Polygon gas station plugin is active')
        }

        console.log(`Connected to RPC: ${fullUrl}`)
        return provider
      } catch (error) {
        console.warn(`Failed to connect to ${fullUrl}:`, error instanceof Error ? error.message : error)
      }
    }

    throw new Error(`Failed to connect to any RPC endpoint. Tried: ${urls.join(', ')}`)
  }

  /**
   * Sync wallet balances (MATIC + USDC)
   * Checks both bridged USDC.e and native USDC contracts,
   * using whichever has a non-zero balance (or the sum of both).
   */
  async syncBalances(): Promise<void> {
    if (!this.wallet || !this.provider) {
      console.warn('[WalletService] syncBalances skipped — wallet or provider not initialized')
      return
    }

    try {
      const eoaAddress = await this.wallet.getAddress()
      const proxyAddress = this.state.proxyAddress

      // The "fund source" is the proxy if set, otherwise the EOA
      const fundAddress = proxyAddress || eoaAddress

      // Get MATIC (POL) balance from EOA (needed for gas regardless)
      const maticBalance = await this.provider.getBalance(eoaAddress)
      const balance = parseFloat(ethers.formatEther(maticBalance))

      // Get USDC balance from bridged contract (USDC.e) — check FUND address
      const usdcBridged = new ethers.Contract(
        CONTRACT_ADDRESSES.USDC,
        USDC_ABI,
        this.provider
      )
      const bridgedRaw = await usdcBridged.balanceOf(fundAddress)
      const bridgedDecimals = await usdcBridged.decimals()
      const bridgedBalance = parseFloat(ethers.formatUnits(bridgedRaw, bridgedDecimals))

      // Get USDC balance from native contract — check FUND address
      let nativeBalance = 0
      try {
        const usdcNative = new ethers.Contract(
          CONTRACT_ADDRESSES.USDC_NATIVE,
          USDC_ABI,
          this.provider
        )
        const nativeRaw = await usdcNative.balanceOf(fundAddress)
        const nativeDecimals = await usdcNative.decimals()
        nativeBalance = parseFloat(ethers.formatUnits(nativeRaw, nativeDecimals))
      } catch {
        // Native USDC contract call failed — not critical
      }

      // Total USDC = bridged + native
      const usdcBalance = bridgedBalance + nativeBalance

      // Warn if funds are in native USDC (not usable by Polymarket exchange)
      if (nativeBalance > 0 && bridgedBalance < 1) {
        console.warn(
          `[WalletService] ⚠ Your $${nativeBalance.toFixed(2)} USDC is in the native contract (0x3c49…3359) ` +
          `which Polymarket cannot use. The exchange requires bridged USDC.e (0x2791…4174). ` +
          `Swap native USDC → USDC.e on a DEX (e.g. Uniswap, 1inch) to trade.`
        )
      }

      const label = proxyAddress ? `proxy ${proxyAddress.slice(0, 10)}…` : 'EOA'
      console.log(`[WalletService] Balances synced (${label}) — MATIC: ${balance.toFixed(4)}, USDC.e: $${bridgedBalance.toFixed(2)}, USDC: $${nativeBalance.toFixed(2)}, Total USDC: $${usdcBalance.toFixed(2)}`)

      this.updateState({
        balance,
        usdcBalance,
        usdcBridgedBalance: bridgedBalance,
        usdcNativeBalance: nativeBalance,
        lastSync: new Date(),
      })
    } catch (error) {
      console.error('[WalletService] Failed to sync balances:', error instanceof Error ? error.message : error)
    }
  }

  /**
   * Check token approvals (with retry for rate-limited RPCs)
   */
  async checkApprovals(retries = 2): Promise<TokenApprovals> {
    if (!this.wallet || !this.provider) {
      return { usdc: false, ctf: false, usdcNegRisk: false, ctfNegRisk: false, usdcNegRiskAdapter: false, ctfNegRiskAdapter: false }
    }

    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        // Small delay between RPC bursts to avoid rate limiting on public endpoints
        if (attempt > 0) {
          await new Promise(r => setTimeout(r, 1500 * attempt))
          console.log(`[WalletService] Retrying approval check (attempt ${attempt + 1}/${retries + 1})...`)
        }

        const address = await this.wallet.getAddress()

        // Check USDC approval (standard exchange)
        const usdcContract = new ethers.Contract(
          CONTRACT_ADDRESSES.USDC,
          USDC_ABI,
          this.provider
        )
        const usdcAllowance = await usdcContract.allowance(address, CONTRACT_ADDRESSES.EXCHANGE)
        const usdcApproved = usdcAllowance > 0n

        // Check CTF approval for standard exchange (selling positions)
        const ctfContract = new ethers.Contract(
          CONTRACT_ADDRESSES.CTF,
          CTF_ABI,
          this.provider
        )
        const ctfApproved = await ctfContract.isApprovedForAll(address, CONTRACT_ADDRESSES.EXCHANGE)

        // Check USDC approval for NegRisk exchange
        const usdcNegRiskAllowance = await usdcContract.allowance(address, CONTRACT_ADDRESSES.NEG_RISK_CTF_EXCHANGE)
        const usdcNegRiskApproved = usdcNegRiskAllowance > 0n

        // Check CTF approval for NegRisk exchange
        const ctfNegRiskApproved = await ctfContract.isApprovedForAll(address, CONTRACT_ADDRESSES.NEG_RISK_CTF_EXCHANGE)

        // Check USDC + CTF approval for NegRisk Adapter (third contract required for NegRisk trades)
        const usdcNegRiskAdapterAllowance = await usdcContract.allowance(address, CONTRACT_ADDRESSES.NEG_RISK_EXCHANGE)
        const usdcNegRiskAdapterApproved = usdcNegRiskAdapterAllowance > 0n
        const ctfNegRiskAdapterApproved = await ctfContract.isApprovedForAll(address, CONTRACT_ADDRESSES.NEG_RISK_EXCHANGE)

        const approvals: TokenApprovals = {
          usdc: usdcApproved,
          ctf: ctfApproved,
          usdcNegRisk: usdcNegRiskApproved,
          ctfNegRisk: ctfNegRiskApproved,
          usdcNegRiskAdapter: usdcNegRiskAdapterApproved,
          ctfNegRiskAdapter: ctfNegRiskAdapterApproved,
        }

        console.log(
          `[WalletService] Approvals checked — USDC: ${usdcApproved ? '✓' : '✗'}, CTF: ${ctfApproved ? '✓' : '✗'}, ` +
          `USDC-NegRisk: ${usdcNegRiskApproved ? '✓' : '✗'}, CTF-NegRisk: ${ctfNegRiskApproved ? '✓' : '✗'}, ` +
          `USDC-NegRiskAdapter: ${usdcNegRiskAdapterApproved ? '✓' : '✗'}, CTF-NegRiskAdapter: ${ctfNegRiskAdapterApproved ? '✓' : '✗'}`
        )
        this.updateState({ approvals })
        return approvals
      } catch (error) {
        const isRpcError = error instanceof Error && (
          error.message.includes('missing revert data') ||
          error.message.includes('CALL_EXCEPTION') ||
          error.message.includes('network') ||
          error.message.includes('timeout')
        )

        if (isRpcError && attempt < retries) {
          console.warn(`[WalletService] RPC call failed (attempt ${attempt + 1}), will retry...`)
          continue
        }

        console.error('[WalletService] Failed to check approvals:', error instanceof Error ? error.message : error)
        return { usdc: false, ctf: false, usdcNegRisk: false, ctfNegRisk: false, usdcNegRiskAdapter: false, ctfNegRiskAdapter: false }
      }
    }

    return { usdc: false, ctf: false, usdcNegRisk: false, ctfNegRisk: false, usdcNegRiskAdapter: false, ctfNegRiskAdapter: false }
  }

  /**
   * Approve USDC spending
   */
  async approveUSDC(amount?: bigint): Promise<TransactionResult> {
    if (!this.wallet) {
      return { success: false, error: 'Wallet not connected' }
    }

    try {
      const usdcContract = new ethers.Contract(
        CONTRACT_ADDRESSES.USDC,
        USDC_ABI,
        this.wallet
      )

      // Use max approval if no amount specified
      const approvalAmount = amount || ethers.MaxUint256

      const tx = await usdcContract.approve(CONTRACT_ADDRESSES.EXCHANGE, approvalAmount)
      const receipt = await tx.wait()

      // Update approvals
      await this.checkApprovals()

      return {
        success: true,
        txHash: receipt.hash,
        blockNumber: receipt.blockNumber,
        gasUsed: receipt.gasUsed,
      }
    } catch (error) {
      console.error('USDC approval failed:', error)
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Approval failed',
      }
    }
  }

  /**
   * Approve CTF (Conditional Token Framework) for selling
   */
  async approveCTF(): Promise<TransactionResult> {
    if (!this.wallet) {
      return { success: false, error: 'Wallet not connected' }
    }

    try {
      const ctfContract = new ethers.Contract(
        CONTRACT_ADDRESSES.CTF,
        CTF_ABI,
        this.wallet
      )

      const tx = await ctfContract.setApprovalForAll(CONTRACT_ADDRESSES.EXCHANGE, true)
      const receipt = await tx.wait()

      // Update approvals
      await this.checkApprovals()

      return {
        success: true,
        txHash: receipt.hash,
        blockNumber: receipt.blockNumber,
        gasUsed: receipt.gasUsed,
      }
    } catch (error) {
      console.error('CTF approval failed:', error)
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Approval failed',
      }
    }
  }

  // Gas constants for approval transactions on Polygon
  // approve() ~46K gas, setApprovalForAll() ~55K gas — padded for safety
  private static readonly APPROVE_GAS_LIMIT = 60_000n
  private static readonly SET_APPROVAL_GAS_LIMIT = 80_000n
  private static readonly GAS_BUFFER_MULTIPLIER = 150n // 1.5x as bigint (150 / 100)

  /**
   * Ensure all necessary approvals are in place.
   * Returns { success, error? } with actionable detail on failure.
   * @param dryRun If true, skip actual approval transactions
   */
  async ensureApprovals(dryRun = false): Promise<{ success: boolean; error?: string }> {
    // In dry run mode, always return success without making transactions
    if (dryRun) {
      console.log('[DRY RUN] Skipping token approvals - simulating success')
      this.updateState({
        approvals: { usdc: true, ctf: true, usdcNegRisk: true, ctfNegRisk: true, usdcNegRiskAdapter: true, ctfNegRiskAdapter: true }
      })
      return { success: true }
    }

    // Check which approvals are needed first
    const approvals = await this.checkApprovals()
    const needUsdc = !approvals.usdc
    const needCtf = !approvals.ctf
    const needUsdcNegRisk = !approvals.usdcNegRisk
    const needCtfNegRisk = !approvals.ctfNegRisk
    const needUsdcNegRiskAdapter = !approvals.usdcNegRiskAdapter
    const needCtfNegRiskAdapter = !approvals.ctfNegRiskAdapter

    // Nothing to do — already approved
    if (!needUsdc && !needCtf && !needUsdcNegRisk && !needCtfNegRisk && !needUsdcNegRiskAdapter && !needCtfNegRiskAdapter) {
      return { success: true }
    }

    // Pre-flight: estimate gas cost for pending approvals
    if (this.provider && this.wallet) {
      const address = await this.wallet.getAddress()
      const maticBal = await this.provider.getBalance(address)

      // Calculate total gas needed for all pending approvals
      let totalGas = 0n
      if (needUsdc) totalGas += WalletService.APPROVE_GAS_LIMIT
      if (needCtf) totalGas += WalletService.SET_APPROVAL_GAS_LIMIT
      if (needUsdcNegRisk) totalGas += WalletService.APPROVE_GAS_LIMIT
      if (needCtfNegRisk) totalGas += WalletService.SET_APPROVAL_GAS_LIMIT
      if (needUsdcNegRiskAdapter) totalGas += WalletService.APPROVE_GAS_LIMIT
      if (needCtfNegRiskAdapter) totalGas += WalletService.SET_APPROVAL_GAS_LIMIT

      try {
        const feeData = await this.provider.getFeeData()
        const gasPrice = feeData.gasPrice ?? feeData.maxFeePerGas ?? 30_000_000_000n // 30 gwei fallback

        // Required = gasPrice × totalGas × 1.5 buffer
        const requiredWei = (gasPrice * totalGas * WalletService.GAS_BUFFER_MULTIPLIER) / 100n

        if (maticBal < requiredWei) {
          const have = parseFloat(ethers.formatEther(maticBal)).toFixed(6)
          const need = parseFloat(ethers.formatEther(requiredWei)).toFixed(6)
          const errorMsg = `Insufficient MATIC for gas: have ${have}, need ~${need} MATIC`

          console.error(`[WalletService] ${errorMsg}`)

          // Fire-and-forget: log to ActivityLogger for audit trail + notifications
          import('@/services/trading/ActivityLogger').then(({ activityLogger }) => {
            activityLogger.logError(errorMsg)
          }).catch(() => {})

          return { success: false, error: errorMsg }
        }
      } catch {
        // Fee data fetch failed — fall back to simple zero check
        if (maticBal === 0n) {
          const errorMsg = 'No MATIC for gas — send POL/MATIC to your wallet first'
          console.error(`[WalletService] ${errorMsg}`)

          import('@/services/trading/ActivityLogger').then(({ activityLogger }) => {
            activityLogger.logError(errorMsg)
          }).catch(() => {})

          return { success: false, error: errorMsg }
        }
      }
    }

    if (needUsdc) {
      console.log('Approving USDC...')
      const result = await this.approveUSDC()
      if (!result.success) {
        const errorMsg = `USDC approval failed: ${result.error ?? 'unknown error'}`
        console.error(errorMsg)

        import('@/services/trading/ActivityLogger').then(({ activityLogger }) => {
          activityLogger.logError(errorMsg)
        }).catch(() => {})

        return { success: false, error: errorMsg }
      }
    }

    if (needCtf) {
      console.log('Approving CTF...')
      const result = await this.approveCTF()
      if (!result.success) {
        const errorMsg = `CTF approval failed: ${result.error ?? 'unknown error'}`
        console.error(errorMsg)

        import('@/services/trading/ActivityLogger').then(({ activityLogger }) => {
          activityLogger.logError(errorMsg)
        }).catch(() => {})

        return { success: false, error: errorMsg }
      }
    }

    // NegRisk exchange approvals (needed for most Polymarket markets)
    if (needUsdcNegRisk) {
      console.log('Approving USDC for NegRisk exchange...')
      const result = await this.approveTokenForSpender(CONTRACT_ADDRESSES.USDC, CONTRACT_ADDRESSES.NEG_RISK_CTF_EXCHANGE)
      if (!result.success) {
        const errorMsg = `USDC NegRisk approval failed: ${result.error ?? 'unknown error'}`
        console.error(errorMsg)
        import('@/services/trading/ActivityLogger').then(({ activityLogger }) => {
          activityLogger.logError(errorMsg)
        }).catch(() => {})
        return { success: false, error: errorMsg }
      }
    }

    if (needCtfNegRisk) {
      console.log('Approving CTF for NegRisk exchange...')
      const result = await this.approveOperatorForAll(CONTRACT_ADDRESSES.CTF, CONTRACT_ADDRESSES.NEG_RISK_CTF_EXCHANGE)
      if (!result.success) {
        const errorMsg = `CTF NegRisk approval failed: ${result.error ?? 'unknown error'}`
        console.error(errorMsg)
        import('@/services/trading/ActivityLogger').then(({ activityLogger }) => {
          activityLogger.logError(errorMsg)
        }).catch(() => {})
        return { success: false, error: errorMsg }
      }
    }

    // NegRisk Adapter approvals (third contract required for NegRisk market trades)
    if (needUsdcNegRiskAdapter) {
      console.log('Approving USDC for NegRisk Adapter...')
      const result = await this.approveTokenForSpender(CONTRACT_ADDRESSES.USDC, CONTRACT_ADDRESSES.NEG_RISK_EXCHANGE)
      if (!result.success) {
        const errorMsg = `USDC NegRisk Adapter approval failed: ${result.error ?? 'unknown error'}`
        console.error(errorMsg)
        import('@/services/trading/ActivityLogger').then(({ activityLogger }) => {
          activityLogger.logError(errorMsg)
        }).catch(() => {})
        return { success: false, error: errorMsg }
      }
    }

    if (needCtfNegRiskAdapter) {
      console.log('Approving CTF for NegRisk Adapter...')
      const result = await this.approveOperatorForAll(CONTRACT_ADDRESSES.CTF, CONTRACT_ADDRESSES.NEG_RISK_EXCHANGE)
      if (!result.success) {
        const errorMsg = `CTF NegRisk Adapter approval failed: ${result.error ?? 'unknown error'}`
        console.error(errorMsg)
        import('@/services/trading/ActivityLogger').then(({ activityLogger }) => {
          activityLogger.logError(errorMsg)
        }).catch(() => {})
        return { success: false, error: errorMsg }
      }
    }

    return { success: true }
  }

  /**
   * Generic ERC-20 approve for any spender
   */
  private async approveTokenForSpender(tokenAddress: string, spender: string): Promise<TransactionResult> {
    if (!this.wallet) return { success: false, error: 'Wallet not connected' }
    try {
      const contract = new ethers.Contract(tokenAddress, USDC_ABI, this.wallet)
      const tx = await contract.approve(spender, ethers.MaxUint256)
      const receipt = await tx.wait()
      await this.checkApprovals()
      return { success: true, txHash: receipt.hash, blockNumber: receipt.blockNumber, gasUsed: receipt.gasUsed }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Approval failed' }
    }
  }

  /**
   * Generic setApprovalForAll for any operator
   */
  private async approveOperatorForAll(tokenAddress: string, operator: string): Promise<TransactionResult> {
    if (!this.wallet) return { success: false, error: 'Wallet not connected' }
    try {
      const contract = new ethers.Contract(tokenAddress, CTF_ABI, this.wallet)
      const tx = await contract.setApprovalForAll(operator, true)
      const receipt = await tx.wait()
      await this.checkApprovals()
      return { success: true, txHash: receipt.hash, blockNumber: receipt.blockNumber, gasUsed: receipt.gasUsed }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Approval failed' }
    }
  }

  /**
   * Get CTF token balance for a specific position
   */
  async getPositionBalance(tokenId: string): Promise<number> {
    if (!this.wallet || !this.provider) return 0

    try {
      const address = await this.wallet.getAddress()
      const ctfContract = new ethers.Contract(
        CONTRACT_ADDRESSES.CTF,
        CTF_ABI,
        this.provider
      )

      const balance = await ctfContract.balanceOf(address, tokenId)
      return parseFloat(ethers.formatUnits(balance, 6))
    } catch (error) {
      console.error('Failed to get position balance:', error)
      return 0
    }
  }

  /**
   * Merge CTF tokens (YES + NO) back to USDC
   *
   * After a two-leg arb trade buys both outcomes, merging converts them
   * back to USDC immediately — locking in profit without waiting for
   * market resolution.
   *
   * CTF.mergePositions(collateralToken, parentCollectionId, conditionId, partition, amount):
   *   - collateralToken = USDC address
   *   - parentCollectionId = bytes32(0) for top-level markets
   *   - conditionId = market condition identifier
   *   - partition = [1, 2] for binary YES/NO markets (outcome slot indices)
   *   - amount = number of complete sets to merge (in USDC decimals, 6)
   */
  async mergePositions(conditionId: string, amount: number): Promise<TransactionResult> {
    if (!this.wallet) {
      return { success: false, error: 'Wallet not connected' }
    }

    try {
      const ctfContract = new ethers.Contract(
        CONTRACT_ADDRESSES.CTF,
        CTF_ABI,
        this.wallet
      )

      // Convert to 6-decimal USDC units (both YES and NO tokens use USDC decimals)
      const mergeAmount = ethers.parseUnits(amount.toString(), 6)

      // Binary market partition: outcome slots 1 (YES) and 2 (NO)
      const partition = [1, 2]

      // parentCollectionId = bytes32(0) for top-level condition
      const parentCollectionId = ethers.ZeroHash

      console.log(`[WalletService] Merging ${amount} complete sets for condition ${conditionId}`)

      const tx = await ctfContract.mergePositions(
        CONTRACT_ADDRESSES.USDC,
        parentCollectionId,
        conditionId,
        partition,
        mergeAmount
      )

      const receipt = await tx.wait()

      console.log(`[WalletService] Merge successful — tx: ${receipt.hash}`)

      return {
        success: true,
        txHash: receipt.hash,
        blockNumber: receipt.blockNumber,
        gasUsed: receipt.gasUsed,
      }
    } catch (error) {
      console.error('[WalletService] Merge positions failed:', error)
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Merge failed',
      }
    }
  }
}

// Export singleton instance
export const walletService = new WalletService()
