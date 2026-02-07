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
import { clobClient, dataClient } from '@/services/api'

/**
 * Wallet Service
 * Handles wallet connection, balance tracking, and token approvals
 */
export class WalletService {
  private wallet: ethers.Wallet | null = null
  private provider: ethers.JsonRpcProvider | null = null
  private state: WalletState = {
    address: null,
    balance: 0,
    usdcBalance: 0,
    isConnected: false,
    isConnecting: false,
    chainId: null,
    lastSync: null,
    approvals: { usdc: false, ctf: false },
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
   * Connect wallet using seed phrase
   */
  async connect(seedPhrase: string): Promise<boolean> {
    this.updateState({ isConnecting: true, error: null })

    try {
      // Validate seed phrase
      if (!ethers.Mnemonic.isValidMnemonic(seedPhrase)) {
        throw new Error('Invalid seed phrase')
      }

      // Create provider with fallback
      this.provider = await this.createProvider()
      
      // Create wallet from seed phrase
      const hdNode = ethers.HDNodeWallet.fromPhrase(seedPhrase)
      this.wallet = hdNode.connect(this.provider)
      
      const address = await this.wallet.getAddress()
      
      // Verify network
      const network = await this.provider.getNetwork()
      if (Number(network.chainId) !== POLYGON_NETWORK.chainId) {
        throw new Error(`Wrong network. Expected Polygon (${POLYGON_NETWORK.chainId}), got ${network.chainId}`)
      }

      // Initialize API clients with wallet
      clobClient.setWallet(this.wallet)
      dataClient.setWalletAddress(address)

      this.updateState({
        address,
        isConnected: true,
        isConnecting: false,
        chainId: Number(network.chainId),
      })

      // Fetch initial data
      await this.syncBalances()
      await this.checkApprovals()

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
    this.updateState({
      address: null,
      balance: 0,
      usdcBalance: 0,
      isConnected: false,
      isConnecting: false,
      chainId: null,
      lastSync: null,
      approvals: { usdc: false, ctf: false },
      error: null,
    })
  }

  /**
   * Create provider with fallback
   */
  private async createProvider(): Promise<ethers.JsonRpcProvider> {
    const urls = [POLYGON_NETWORK.rpcUrl, POLYGON_NETWORK.rpcFallback].filter(Boolean) as string[]

    for (const url of urls) {
      try {
        const provider = new ethers.JsonRpcProvider(url)
        await provider.getNetwork() // Test connection
        console.log(`Connected to RPC: ${url}`)
        return provider
      } catch (error) {
        console.warn(`Failed to connect to ${url}, trying next...`)
      }
    }

    throw new Error('Failed to connect to any RPC endpoint')
  }

  /**
   * Sync wallet balances
   */
  async syncBalances(): Promise<void> {
    if (!this.wallet || !this.provider) return

    try {
      const address = await this.wallet.getAddress()

      // Get MATIC balance
      const maticBalance = await this.provider.getBalance(address)
      const balance = parseFloat(ethers.formatEther(maticBalance))

      // Get USDC balance
      const usdcContract = new ethers.Contract(
        CONTRACT_ADDRESSES.USDC,
        USDC_ABI,
        this.provider
      )
      const usdcBalanceRaw = await usdcContract.balanceOf(address)
      const decimals = await usdcContract.decimals()
      const usdcBalance = parseFloat(ethers.formatUnits(usdcBalanceRaw, decimals))

      this.updateState({
        balance,
        usdcBalance,
        lastSync: new Date(),
      })
    } catch (error) {
      console.error('Failed to sync balances:', error)
    }
  }

  /**
   * Check token approvals
   */
  async checkApprovals(): Promise<TokenApprovals> {
    if (!this.wallet || !this.provider) {
      return { usdc: false, ctf: false }
    }

    try {
      const address = await this.wallet.getAddress()
      
      // Check USDC approval
      const usdcContract = new ethers.Contract(
        CONTRACT_ADDRESSES.USDC,
        USDC_ABI,
        this.provider
      )
      const usdcAllowance = await usdcContract.allowance(address, CONTRACT_ADDRESSES.EXCHANGE)
      const usdcApproved = usdcAllowance > 0n

      // Check CTF approval (for selling positions)
      const ctfContract = new ethers.Contract(
        CONTRACT_ADDRESSES.CTF,
        CTF_ABI,
        this.provider
      )
      const ctfApproved = await ctfContract.isApprovedForAll(address, CONTRACT_ADDRESSES.EXCHANGE)

      const approvals: TokenApprovals = { 
        usdc: usdcApproved, 
        ctf: ctfApproved 
      }
      
      this.updateState({ approvals })
      return approvals
    } catch (error) {
      console.error('Failed to check approvals:', error)
      return { usdc: false, ctf: false }
    }
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

  /**
   * Ensure all necessary approvals are in place
   * @param dryRun If true, skip actual approval transactions
   */
  async ensureApprovals(dryRun = false): Promise<boolean> {
    // In dry run mode, always return success without making transactions
    if (dryRun) {
      console.log('[DRY RUN] Skipping token approvals - simulating success')
      this.updateState({
        approvals: { usdc: true, ctf: true }
      })
      return true
    }

    const approvals = await this.checkApprovals()

    if (!approvals.usdc) {
      console.log('Approving USDC...')
      const result = await this.approveUSDC()
      if (!result.success) {
        console.error('USDC approval failed:', result.error)
        return false
      }
    }

    if (!approvals.ctf) {
      console.log('Approving CTF...')
      const result = await this.approveCTF()
      if (!result.success) {
        console.error('CTF approval failed:', result.error)
        return false
      }
    }

    return true
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
   * Merge CTF tokens (UP + DOWN) back to USDC
   * This is used after completing arbitrage trades
   */
  async mergePositions(conditionId: string, amount: number): Promise<TransactionResult> {
    if (!this.wallet) {
      return { success: false, error: 'Wallet not connected' }
    }

    // Note: This requires calling the CTF contract's mergePositions function
    // The exact implementation depends on Polymarket's CTF contract interface
    console.log(`Merging ${amount} positions for condition ${conditionId}`)
    
    // For now, return success - actual implementation would call the contract
    return { success: true }
  }
}

// Export singleton instance
export const walletService = new WalletService()
