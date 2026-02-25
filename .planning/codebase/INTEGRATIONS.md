# External Integrations

**Analysis Date:** 2026-02-25

## APIs & External Services

**Prediction Markets:**
- **Polymarket CLOB (International)** - Order placement, order book, balance/allowance queries
  - SDK/Client: Custom `CLOBClient` (ethers.js-based, no official SDK)
  - Files: `src/services/api/CLOBClient.ts`
  - Auth: HMAC-SHA256 signature (key/secret/passphrase derived from wallet via ethers)
  - Endpoint: https://clob.polymarket.com

- **Polymarket Gamma API** - Market discovery, metadata, search, events
  - SDK/Client: Custom `GammaClient`
  - Files: `src/services/api/GammaClient.ts`
  - Auth: None (public API)
  - Endpoint: https://gamma-api.polymarket.com

- **Polymarket Data API** - Position tracking, trade history, portfolio analytics
  - SDK/Client: Custom `DataClient`
  - Files: `src/services/api/DataClient.ts`
  - Auth: None (public API)
  - Endpoint: https://data-api.polymarket.com

- **PolyBacktest API** - Historical BTC Up/Down market snapshots, backtesting data
  - SDK/Client: Custom `PolyBacktestClient`
  - Files: `src/services/api/PolyBacktestClient.ts`
  - Auth: `X-API-Key` header
  - Env var: `VITE_POLYBACKTEST_API_KEY` (optional; can be set in UI)
  - Endpoint: https://api.polybacktest.com
  - Rate limits: 60 req/min

**Cryptocurrency Pricing:**
- **Binance REST API** - Spot price data, OHLCV data
  - SDK/Client: Custom HTTP requests via `PriceOracleService`
  - Files: `src/services/api/PriceOracleService.ts`
  - Auth: None (public endpoints)
  - Endpoint: https://api.binance.us (via `/api/binance` proxy in dev)
  - Usage: BTC, ETH, SOL, XRP pair queries

- **Binance WebSocket** - Real-time mini ticker streams (BTC, ETH, SOL, XRP)
  - SDK/Client: Native WebSocket with custom `BinanceWSService`
  - Files: `src/services/realtime/BinanceWSService.ts`
  - Auth: None (public streams)
  - Endpoint: wss://stream.binance.us:9443 (via `/ws/binance` proxy in dev)
  - Streams: `btcusdt@miniTicker`, `ethusdt@miniTicker`, `solusdt@miniTicker`, `xrpusdt@miniTicker`
  - Cache TTL: 5 seconds
  - Note: Custom Vite plugin (`binanceWsProxy()`) bridges WebSocket with auto-reconnect

- **CoinGecko API** - Fallback cryptocurrency pricing
  - SDK/Client: Custom HTTP requests via `PriceOracleService`
  - Files: `src/services/api/PriceOracleService.ts`
  - Auth: None (public API, rate-limited)
  - Endpoint: https://api.coingecko.com/api/v3 (via `/api/coingecko` proxy in dev)
  - Fallback for: BTC, ETH, SOL, XRP when Binance unavailable
  - Rate limits: ~50 req/min for public API

**LLM & AI Analysis:**
- **OpenRouter** - AI-powered market prediction and signal confirmation
  - SDK/Client: Custom `OpenRouterService`
  - Files: `src/services/llm/OpenRouterService.ts`
  - Auth: Bearer token in `Authorization` header
  - Env var: `VITE_OPENROUTER_API_KEY` (required, sk-or-v1-*)
  - Endpoint: https://openrouter.ai/api/v1
  - Models: Configurable (default: meta-llama/llama-3.1-70b-instruct, supports premium models)
  - Features:
    - Market analysis with optional web search
    - Crypto-specific analysis with Binance data
    - Signal confirmation for BTC Up/Down trades
    - Cross-market dependency classification
  - Budget tracking: Three separate daily budgets (prediction, crossMarket, premium)
  - Circuit breaker: 402 (insufficient credits) triggers 30-minute cooldown
  - Cost tracking: Per-call cost logged and summed to daily budgets

**Blockchain & Wallet:**
- **Polymarket CLOB L2 Authentication** - HMAC-based order signing
  - SDK/Client: ethers.js 6.7.0 (no official Polymarket SDK)
  - Files: `src/services/wallet/WalletService.ts`, `src/services/api/CLOBClient.ts`
  - Auth: EIP-712 signature (Polygon chain ID 137)
  - Process: Wallet seed phrase → ethers HD wallet → derive HMAC key/secret/passphrase via CLOB API → place orders

- **Polygon RPC** - Primary blockchain interaction (future use, currently in vite proxy)
  - Endpoint: https://polygon-bor-rpc.publicnode.com/ (primary)
  - Fallback: https://1rpc.io/matic
  - Note: Proxied via Netlify, not actively used in current trading logic

**Crypto Trading (Optional):**
- **Coinbase Advanced Trade API** - Spot trading and balance queries (if integrated)
  - SDK/Client: @coinbase/cdp-sdk 1.44.1
  - Files: Not explicitly used in core trading; present as dependency
  - Auth: API key/secret (if used)
  - Note: May be included for future integrations or alternative exchange support

## Data Storage

**Databases:**
- **IndexedDB (Browser-based)**
  - Client: `idb` 8.0.3 library for promise-based async access
  - Files: `src/services/storage/IndexedDBService.ts`
  - DB name: `alphapolybot`
  - Version: 5
  - Schema:
    - `activities` - Trading activity logs (indexed by type, timestamp)
    - `positions` - Tracked market positions (indexed by strategy)
    - `arbRounds` - Arbitrage execution rounds (indexed by timestamp)
    - `gtcOrders` - Pending good-til-cancel orders (indexed by strategy, expiration)
    - `tradeRecords` - Historical trade logs (indexed by timestamp, strategy)
    - `calibrationData` - BTC Up/Down calibration data for accuracy tracking
  - Persistence: Survives page reload, cleared on browser cache wipe
  - No backend database required (fully client-side)

**File Storage:**
- Local filesystem only (Netlify deployment handles static assets)
- Wallet seed phrase and API keys stored in-memory or localStorage (user responsibility)

**Caching:**
- **In-memory (session):**
  - Analysis history cache (OpenRouterService, last 200 records)
  - Price oracle 5-second cache (BTC, ETH, SOL, XRP)
  - Token ID resolver cache (slug → CLOB token IDs)
  - RTDS service price cache (real-time streaming updates)
- **Browser localStorage (persistent):**
  - Settings store (zustand persist middleware) - `alphapolybot-settings`
  - Wallet state store - `alphapolybot-wallet`
  - Balance history store - `alphapolybot-balance-history`
  - Legacy OpenRouter API key (fallback) - `OPENROUTER_API_KEY`

## Authentication & Identity

**Auth Provider:**
- Custom (no OAuth/SSO)

**Implementation:**
- **Wallet-based auth:** Seed phrase (12/24 words) or private key → ethers.js → Polygon chain address
- **CLOB credentials:** Address → derive HMAC key/secret/passphrase via Polymarket CLOB API
- **Order signing:** HMAC-SHA256 signature for every CLOB order (EIP-712 domain: Polygon chain 137)
- **No backend:** All auth is client-side; user manages wallet seed phrase
- Files: `src/services/wallet/WalletService.ts`, `src/stores/walletStore.ts`, `src/services/api/CLOBClient.ts`

**Secrets Management:**
- Environment variables: `VITE_OPENROUTER_API_KEY`, `VITE_WALLET_SEED_PHRASE` (optional in .env)
- Secure storage: Seeds/keys NOT persisted to git; recommend in-app settings entry or environment
- Secure storage utility: `src/utils/secureStorage.ts` (available for localStorage encryption if needed)

## Monitoring & Observability

**Error Tracking:**
- Not integrated (relies on console logging and UI notifications)
- Errors logged to browser console; visible in browser DevTools
- File: `src/services/notifications/NotificationService.ts` for UI toast notifications

**Logs:**
- Browser console (console.log, console.error, console.warn)
- In-memory activity log in IndexedDB (persisted across sessions)
- Trade logs: `src/services/trading/TradeLogger.ts` and `ActivityLogger.ts`
- No remote logging configured

## CI/CD & Deployment

**Hosting:**
- Netlify (serverless static site hosting)
- Configuration: `netlify.toml`
- Build command: `npm ci && npm run build`
- Publish directory: `dist/`
- Node version: 20

**CI Pipeline:**
- Not explicitly configured (no GitHub Actions in this snapshot)
- Netlify auto-deploys on git push to `main` branch

**Deployment Proxies (Netlify Redirects):**
- `/api/clob/*` → https://clob.polymarket.com
- `/api/gamma/*` → https://gamma-api.polymarket.com
- `/api/polygon-rpc` → https://polygon-bor-rpc.publicnode.com/
- `/api/polygon-rpc2` → https://1rpc.io/matic (fallback RPC)
- `/api/coinbase/*` → https://api.coinbase.com
- `/api/polybacktest/*` → https://api.polybacktest.com
- `/*` → `/index.html` (SPA routing)

## Environment Configuration

**Required env vars:**
- `VITE_OPENROUTER_API_KEY` - Must be set for LLM predictions to work (sk-or-v1-*)

**Optional env vars:**
- `VITE_WALLET_SEED_PHRASE` - Can be entered in Settings UI instead
- `VITE_POLYBACKTEST_API_KEY` - Can be entered in Settings UI instead
- `VITE_BINANCE_API_URL` - Defaults to https://api.binance.com/api/v3
- `VITE_BINANCE_WS_URL` - Defaults to wss://stream.binance.com:9443
- `VITE_COINGECKO_API_URL` - Defaults to https://api.coingecko.com/api/v3
- `VITE_OPENROUTER_BASE_URL` - Defaults to https://openrouter.ai/api/v1

**Secrets location:**
- `.env` file (local development only, never committed)
- Netlify dashboard environment variables (production)
- Settings UI (for runtime configuration of API keys and wallet)

## Webhooks & Callbacks

**Incoming:**
- None (no backend to receive webhooks)

**Outgoing:**
- CLOB order placement (synchronous API call, no webhook callback)
- Real-time streaming: Binance WebSocket (miniTicker events), Polymarket RTDS (optional real-time data streaming)

## Real-Time Features

**WebSocket Connections:**
- **Binance:** Mini ticker streams for BTC, ETH, SOL, XRP (~1 second updates)
- **Polymarket RTDS (optional):** Real-time data streaming for market updates (not required, fallback to polling)
- Custom proxy in `vite.config.ts`: Bridges client WebSocket to upstream Binance with auto-reconnect logic

## API Rate Limits & Timeouts

**Clients:**
- **BaseApiClient:** Token bucket rate limiter, configurable per client
- **PolyBacktestClient:** 60 req/min
- **CLOBClient:** Standard Polymarket rate limits (typically 100+ req/min)
- **GammaClient:** Standard Polymarket rate limits
- **DataClient:** 200 req/min
- **PriceOracleService:** Binance 1200 req/min (public), CoinGecko 50 req/min
- **OpenRouterService:** OpenRouter API limits (varies by model; circuit breaker on 402)

**Retry Logic:**
- Exponential backoff on transient failures (configurable)
- Max retries: Typically 3-5 per client configuration
- Timeout: 10-15 seconds per request

---

*Integration audit: 2026-02-25*
