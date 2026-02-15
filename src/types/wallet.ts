// ==========================================
// WALLET & BLOCKCHAIN TYPES
// ==========================================

export interface WalletState {
  /** EOA address (derived from private key / seed phrase) — signs orders */
  address: string | null
  /** Polymarket proxy address (Gnosis Safe) — holds funds, receives trades */
  proxyAddress: string | null
  balance: number
  usdcBalance: number
  /** USDC.e (bridged) balance — this is what Polymarket's exchange uses */
  usdcBridgedBalance: number
  /** Native USDC balance — NOT usable on Polymarket exchange */
  usdcNativeBalance: number
  isConnected: boolean
  isConnecting: boolean
  chainId: number | null
  lastSync: Date | null
  approvals: TokenApprovals
  error: string | null
}

export interface TokenApprovals {
  usdc: boolean
  ctf: boolean
  usdcNegRisk: boolean
  ctfNegRisk: boolean
  /** USDC approval for NegRisk Adapter (0xd91E…) — required for NegRisk market trades */
  usdcNegRiskAdapter: boolean
  /** CTF approval for NegRisk Adapter (0xd91E…) — required for NegRisk market trades */
  ctfNegRiskAdapter: boolean
}

export interface WalletConnection {
  address: string
  chainId: number
  sessionId: string
  expiresAt: number
}

export interface TransactionRequest {
  to: string
  data?: string
  value?: bigint
  gasLimit?: bigint
  gasPrice?: bigint
  nonce?: number
}

export interface TransactionResult {
  success: boolean
  txHash?: string
  error?: string
  blockNumber?: number
  gasUsed?: bigint
}

// ==========================================
// NETWORK CONFIGURATION
// ==========================================

export interface NetworkConfig {
  chainId: number
  name: string
  rpcUrl: string
  rpcFallback?: string
  blockExplorer: string
  nativeCurrency: {
    name: string
    symbol: string
    decimals: number
  }
}

export const POLYGON_NETWORK: NetworkConfig = {
  chainId: 137,
  name: 'Polygon Mainnet',
  rpcUrl: import.meta.env.VITE_POLYGON_RPC_URL || '/api/polygon-rpc',
  rpcFallback: import.meta.env.VITE_POLYGON_RPC_FALLBACK || '/api/polygon-rpc2',
  blockExplorer: 'https://polygonscan.com',
  nativeCurrency: {
    name: 'MATIC',
    symbol: 'MATIC',
    decimals: 18,
  },
}

// ==========================================
// CONTRACT ADDRESSES
// ==========================================

export const CONTRACT_ADDRESSES = {
  // Polymarket Exchange (CLOB)
  EXCHANGE: import.meta.env.VITE_POLYMARKET_EXCHANGE_ADDRESS || '0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E',
  
  // Conditional Token Framework (CTF) - for selling positions
  CTF: import.meta.env.VITE_POLYMARKET_CTF_ADDRESS || '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045',
  
  // USDC.e (Bridged) on Polygon — legacy, 6 decimals
  USDC: import.meta.env.VITE_USDC_ADDRESS || '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174',

  // USDC (Native) on Polygon — newer Circle-issued, 6 decimals
  USDC_NATIVE: import.meta.env.VITE_USDC_NATIVE_ADDRESS || '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359',

  // Neg Risk CTF Exchange
  NEG_RISK_CTF_EXCHANGE: import.meta.env.VITE_NEG_RISK_CTF_EXCHANGE || '0xC5d563A36AE78145C45a50134d48A1215220f80a',

  // Neg Risk Exchange
  NEG_RISK_EXCHANGE: import.meta.env.VITE_NEG_RISK_EXCHANGE || '0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296',
}

// ==========================================
// ABI FRAGMENTS
// ==========================================

export const USDC_ABI = [
  'function approve(address spender, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function balanceOf(address account) view returns (uint256)',
  'function decimals() view returns (uint8)',
]

export const CTF_ABI = [
  'function setApprovalForAll(address operator, bool approved)',
  'function isApprovedForAll(address account, address operator) view returns (bool)',
  'function balanceOf(address account, uint256 id) view returns (uint256)',
  'function balanceOfBatch(address[] accounts, uint256[] ids) view returns (uint256[])',
  // mergePositions: Burns equal amounts of all outcome tokens to redeem collateral (USDC)
  // parentCollectionId is bytes32(0) for top-level markets
  // conditionId identifies the market, amount is the number of complete sets to merge
  'function mergePositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] partition, uint256 amount)',
  // redeemPositions: After market resolution, converts winning outcome tokens to USDC.
  // Burns all outcome tokens — winning tokens return collateral, losing tokens are worthless.
  // No amount param — redeems the caller's full balance automatically.
  'function redeemPositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] partition)',
]

export const EXCHANGE_ABI = [
  'function fillOrder((uint256 salt, address maker, address signer, address taker, uint256 tokenId, uint256 makerAmount, uint256 takerAmount, uint256 expiration, uint256 nonce, uint256 feeRateBps, uint8 side, uint8 signatureType, bytes signature) order, uint256 fillAmount) external',
]
