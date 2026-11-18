/// <reference types="vite/client" />

interface ImportMetaEnv {
  // LLM
  readonly VITE_OPENROUTER_API_KEY: string
  readonly VITE_OPENROUTER_BASE_URL: string
  // Polymarket US base URL overrides (optional; see .env.example)
  readonly VITE_GATEWAY_URL: string
  readonly VITE_API_URL: string
  // External data feeds
  readonly VITE_BINANCE_API_URL: string
  readonly VITE_BINANCE_WS_URL: string
  readonly VITE_COINGECKO_API_URL: string
  readonly VITE_RTDS_WS_URL: string
  readonly VITE_GAS_STATION_URL: string
  // Coinbase (Mean Reversion) and PolyBacktest (BTC Up/Down history)
  readonly VITE_COINBASE_API_KEY: string
  readonly VITE_COINBASE_SECRET: string
  readonly VITE_POLYBACKTEST_API_KEY: string
  readonly VITE_POLYBACKTEST_API_URL: string
  // App
  readonly VITE_APP_VERSION: string
  readonly VITE_ENVIRONMENT: string
  readonly VITE_DEBUG_MODE: string
  readonly VITE_STRICT_CSP_DEV: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
