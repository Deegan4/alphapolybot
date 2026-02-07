/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_WALLET_SEED_PHRASE: string
  readonly VITE_OPENROUTER_API_KEY: string
  readonly VITE_POLYMARKET_CHAIN_ID: string
  readonly VITE_POLYMARKET_EXCHANGE_ADDRESS: string
  readonly VITE_POLYMARKET_CTF_ADDRESS: string
  readonly VITE_USDC_ADDRESS: string
  readonly VITE_POLYGON_RPC_URL: string
  readonly VITE_POLYGON_RPC_FALLBACK: string
  readonly VITE_GAMMA_API_URL: string
  readonly VITE_CLOB_API_URL: string
  readonly VITE_DATA_API_URL: string
  readonly VITE_WS_URL: string
  readonly VITE_APP_VERSION: string
  readonly VITE_ENVIRONMENT: string
  readonly VITE_DEBUG_MODE: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
