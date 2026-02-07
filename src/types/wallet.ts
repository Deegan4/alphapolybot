// ==========================================
// WALLET & BLOCKCHAIN TYPES
// ==========================================

export interface WalletState {
  address: string | null
  balance: number
  usdcBalance: number
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
  rpcUrl: import.meta.env.VITE_POLYGON_RPC_URL || 'https://polygon-rpc.com',
  rpcFallback: import.meta.env.VITE_POLYGON_RPC_FALLBACK || 'https://rpc-mainnet.matic.network',
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
  EXCHANGE: import.meta.env.VITE_POLYMARKET_EXCHANGE_ADDRESS || '0x4bFB41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E',
  
  // Conditional Token Framework (CTF) - for selling positions
  CTF: import.meta.env.VITE_POLYMARKET_CTF_ADDRESS || '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045',
  
  // USDC Token on Polygon
  USDC: import.meta.env.VITE_USDC_ADDRESS || '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174',
  
  // Neg Risk CTF Exchange
  NEG_RISK_CTF_EXCHANGE: '0xC5d563A36AE78145C45a50134d48A1215220f80a',
  
  // Neg Risk Exchange
  NEG_RISK_EXCHANGE: '0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296',
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
]

export const EXCHANGE_ABI = [
  'function fillOrder((uint256 salt, address maker, address signer, address taker, uint256 tokenId, uint256 makerAmount, uint256 takerAmount, uint256 expiration, uint256 nonce, uint256 feeRateBps, uint8 side, uint8 signatureType, bytes signature) order, uint256 fillAmount) external',
]
