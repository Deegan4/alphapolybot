# Codebase Structure

**Analysis Date:** 2026-02-25

## Directory Layout

```
alphapolybot/
├── src/                           # Main application source
│   ├── main.tsx                   # React DOM root entry point
│   ├── App.tsx                    # Root component with router + service init
│   ├── components/                # React UI components
│   │   ├── charts/                # Chart visualizations (Recharts)
│   │   ├── dashboard/             # Dashboard panels and widgets
│   │   ├── layout/                # Page layouts (DashboardLayout, SettingsLayout)
│   │   ├── ui/                    # Reusable UI primitives (buttons, inputs, tables)
│   │   └── ErrorBoundary.tsx      # Error boundary wrapper
│   ├── views/                     # Page-level components (routed)
│   │   ├── DashboardView.tsx      # Main dashboard with grid layout
│   │   ├── SettingsView.tsx       # Strategy settings + configuration
│   │   ├── PortfolioView.tsx      # Position tracking + trade history
│   │   ├── ActivityView.tsx       # Activity log viewer
│   │   ├── TradingTerminal.tsx    # Manual trading interface
│   │   └── NotFoundView.tsx       # 404 page
│   ├── services/                  # Business logic and external integrations
│   │   ├── api/                   # HTTP API clients
│   │   │   ├── BaseApiClient.ts   # Base class (rate limit, retry, timeout)
│   │   │   ├── PolymarketClient.ts # Market data API
│   │   │   ├── CLOBClient.ts      # CLOB order execution API
│   │   │   ├── DataClient.ts      # Position + trade history API
│   │   │   ├── GammaClient.ts     # Greeks/IV calculation API
│   │   │   ├── PolyBacktestClient.ts # Backtesting API
│   │   │   ├── PriceOracleService.ts # Multi-source price aggregation
│   │   │   └── index.ts           # Exports all clients
│   │   ├── trading/               # Core trading and risk services
│   │   │   ├── TradingService.ts  # FOK order execution + retry logic
│   │   │   ├── RiskManager.ts     # Position limits, capital gates, concentration checks
│   │   │   ├── PositionLifecycleManager.ts # Stop-loss + take-profit enforcement
│   │   │   ├── GtcOrderManager.ts # GTD fallback orders (FOK → GTD)
│   │   │   ├── MarketScanner.ts   # Market scanning for opportunities
│   │   │   ├── OrderBookDepth.ts  # Liquidity checking
│   │   │   ├── ActivityLogger.ts  # Central event bus (broadcasts trades, errors)
│   │   │   ├── TradeLogger.ts     # Persistent trade history (IndexedDB)
│   │   │   ├── RejectionTracker.ts # Categorized rejection tracking
│   │   │   ├── EdgeTracker.ts     # Strategy edge statistics
│   │   │   ├── CalibrationTracker.ts # Calibration bucket tracking
│   │   │   ├── BtcCalibrationService.ts # BTC up/down calibration
│   │   │   ├── KellySizer.ts      # Kelly criterion sizing
│   │   │   ├── GasOracle.ts       # Gas fee estimation
│   │   │   ├── ReadinessChecker.ts # System readiness validation
│   │   │   ├── oms/               # Order Management System
│   │   │   │   ├── OrderRegistry.ts # Order state machine + lifecycle
│   │   │   │   └── types.ts       # OMS types (StrategyId, OrderIntent, ManagedOrder)
│   │   │   ├── __tests__/         # Trading service unit tests
│   │   │   └── index.ts           # Exports all trading services
│   │   ├── strategies/            # Trading strategies
│   │   │   ├── BaseStrategy.ts    # Abstract base class (lifecycle, events)
│   │   │   ├── StrategyManager.ts # Strategy registration + orchestration
│   │   │   ├── LLMPredictionStrategy.ts # LLM-based price predictions
│   │   │   ├── DipArbStrategy.ts  # Dip detection + arbitrage
│   │   │   ├── DipDetector.ts     # Shared dip detection logic
│   │   │   ├── ProjectFWStrategy.ts # Cross-market arbitrage
│   │   │   │   └── crossmarket/   # Cross-market specific tools
│   │   │   ├── BtcUpDownStrategy.ts # BTC up/down binary betting
│   │   │   ├── GabagoolStrategy.ts # Market-making on tight spreads
│   │   │   ├── DualSideHedgeStrategy.ts # Dual-side hedging strategy
│   │   │   ├── __tests__/         # Strategy unit tests
│   │   │   └── index.ts           # Exports all strategies
│   │   ├── realtime/              # WebSocket streaming services
│   │   │   ├── RTDSService.ts     # RTDS WS (real-time default service)
│   │   │   ├── BinanceWSService.ts # Binance WS (ETH, SOL, BTC prices)
│   │   │   ├── UserChannelService.ts # CLOB user channel (order updates)
│   │   │   └── index.ts           # Exports all realtime services
│   │   ├── wallet/                # Web3 wallet management
│   │   │   ├── WalletService.ts   # Ethers.js integration
│   │   │   └── index.ts           # Exports wallet service
│   │   ├── llm/                   # LLM integration
│   │   │   ├── OpenRouterService.ts # OpenRouter API client
│   │   │   └── index.ts           # Exports LLM service
│   │   ├── notifications/         # In-app notifications + browser alerts
│   │   │   ├── NotificationService.ts # Toast + sound notifications
│   │   │   └── index.ts           # Exports notification service
│   │   ├── storage/               # Data persistence
│   │   │   ├── IndexedDBService.ts # IndexedDB wrapper (trades, activity, balance history)
│   │   │   └── index.ts           # Exports storage service
│   │   └── index.ts               # Central exports for all services
│   ├── stores/                    # Zustand state stores (persistent)
│   │   ├── settingsStore.ts       # User settings (strategy params, API keys, dry-run flag)
│   │   ├── walletStore.ts         # Wallet state (address, balance, connection)
│   │   ├── backtestStore.ts       # Backtest results
│   │   ├── notificationStore.ts   # Notification settings
│   │   ├── balanceHistoryStore.ts # Historical balance snapshots
│   │   ├── __tests__/             # Store unit tests
│   │   └── index.ts               # Exports all stores
│   ├── hooks/                     # Custom React hooks
│   │   ├── usePolymarketPrices.ts # Fetch + stream Polymarket prices
│   │   ├── useCryptoPrices.ts     # Stream BTC/ETH/SOL prices
│   │   ├── useWallet.ts           # Wallet connection + balance updates
│   │   ├── useBalanceHistory.ts   # Historical balance data
│   │   ├── useTradeAnalytics.ts   # Trade statistics + metrics
│   │   └── index.ts               # Exports all hooks
│   ├── types/                     # TypeScript type definitions
│   │   ├── api.ts                 # Market, Order, Trade, Portfolio types
│   │   ├── wallet.ts              # Wallet and balance types
│   │   ├── index.ts               # Re-exports all types
│   │   └── vite-env.d.ts          # Vite environment types
│   ├── utils/                     # Utility functions
│   │   ├── secureStorage.ts       # Encrypted localStorage wrapper
│   │   ├── cn.ts                  # CSS class merging (clsx wrapper)
│   │   ├── __tests__/             # Utility tests
│   │   └── index.ts               # Exports all utilities
│   └── styles/                    # Global CSS + Tailwind
│       └── index.css              # Tailwind imports + custom theme
├── mcp-server/                    # MCP (Model Context Protocol) server
│   ├── src/                       # MCP server source
│   │   ├── index.ts               # MCP server entry + tool registration
│   │   ├── config.ts              # MCP configuration
│   │   ├── auth/                  # Authentication for MCP tools
│   │   ├── clients/               # MCP client implementations
│   │   ├── tools/                 # MCP tool definitions
│   │   └── utils/                 # MCP utility functions
│   ├── __tests__/                 # MCP tests
│   └── package.json               # MCP server dependencies
├── .planning/                     # GSD planning artifacts
│   └── codebase/                  # Codebase analysis documents
├── docs/                          # Documentation
│   ├── plans/                     # Implementation plans
│   └── screenshots/               # Screenshots and diagrams
├── public/                        # Static assets
├── dist/                          # Build output (Vite)
├── .github/                       # GitHub workflows + issue templates
├── .vscode/                       # VS Code settings
├── vite.config.ts                 # Vite + proxy configuration (Binance WS proxy)
├── tsconfig.json                  # TypeScript configuration (path alias @/*)
├── package.json                   # Dependencies + scripts (React, Vite, ethers, etc.)
└── .env                           # Environment variables (dev/prod, API keys)
```

## Directory Purposes

**`src/`**
- Purpose: Main application source code
- Contains: Components, services, stores, hooks, types, utilities
- Key files: `main.tsx` (entry), `App.tsx` (root component)

**`src/components/`**
- Purpose: Reusable React UI components
- Contains: Charts (Recharts), dashboard panels, layout wrappers, UI primitives
- Key files: `layout/DashboardLayout.tsx`, `dashboard/` (grid panels), `charts/` (chart components)

**`src/views/`**
- Purpose: Page-level components matched to routes
- Contains: Full-page views (Dashboard, Settings, Portfolio, Activity)
- Key files: `DashboardView.tsx`, `SettingsView.tsx` (contains all strategy controls)

**`src/services/api/`**
- Purpose: HTTP API client implementations
- Contains: Clients for Polymarket, CLOB, Data API, Gamma, Binance, CoinGecko
- Key files: `BaseApiClient.ts` (rate limiting, retry), `CLOBClient.ts` (order execution)

**`src/services/trading/`**
- Purpose: Core trading, risk management, order lifecycle
- Contains: TradingService, RiskManager, ActivityLogger, TradeLogger, OMS
- Key files: `TradingService.ts` (execution), `RiskManager.ts` (gates), `oms/OrderRegistry.ts` (state machine)

**`src/services/strategies/`**
- Purpose: Autonomous trading strategies
- Contains: StrategyManager, BaseStrategy, 6 concrete strategies
- Key files: `StrategyManager.ts` (orchestration), strategy implementations

**`src/services/realtime/`**
- Purpose: WebSocket streaming for prices and order updates
- Contains: RTDS, Binance WS, user channel services
- Key files: `RTDSService.ts` (BTC), `BinanceWSService.ts` (ETH/SOL/BTC)

**`src/stores/`**
- Purpose: Persistent React state (Zustand)
- Contains: Settings, wallet, backtest results, notifications
- Key files: `settingsStore.ts`, `walletStore.ts`

**`src/hooks/`**
- Purpose: Custom React hooks bridging stores and services
- Contains: Price hooks, wallet hooks, analytics hooks
- Key files: `useCryptoPrices.ts`, `useWallet.ts`

**`src/types/`**
- Purpose: TypeScript type definitions
- Contains: Market, Order, Trade, Wallet types
- Key files: `api.ts` (main types), `wallet.ts`

**`mcp-server/`**
- Purpose: Claude MCP server for AI agent integration
- Contains: Tool definitions, client implementations, auth
- Separate package with own dependencies
- Not loaded in browser; runs as Node.js process for agent-based trading

## Key File Locations

**Entry Points:**
- `src/main.tsx`: React DOM root — mounts App
- `src/App.tsx`: Root component — initializes all services, sets up router
- `vite.config.ts`: Vite configuration with Binance WS proxy + API proxies
- `package.json`: npm scripts (dev, build, test, lint)

**Configuration:**
- `tsconfig.json`: TypeScript config with `@/*` path alias
- `.env`: Environment variables (VITE_WALLET_SEED_PHRASE, API keys, URLs)
- `vite.config.ts`: Vite proxies for CLOB, Coinbase, Polybacktest, Gamma, Binance, CoinGecko

**Core Logic:**
- `src/services/trading/TradingService.ts`: Order execution entry point
- `src/services/trading/RiskManager.ts`: Risk validation gates
- `src/services/strategies/StrategyManager.ts`: Strategy lifecycle management
- `src/stores/settingsStore.ts`: All user-configurable settings

**UI Entry Points:**
- `src/views/DashboardView.tsx`: Main dashboard (route `/`)
- `src/views/SettingsView.tsx`: Strategy configuration (route `/settings`)
- `src/components/layout/DashboardLayout.tsx`: Dashboard page wrapper
- `src/components/layout/SettingsLayout.tsx`: Settings page wrapper

**Testing:**
- `src/services/api/__tests__/`: API client tests
- `src/services/trading/__tests__/`: Trading service tests
- `src/services/strategies/__tests__/`: Strategy tests
- `src/services/trading/oms/__tests__/`: OMS tests
- `src/stores/__tests__/`: Store tests
- `src/utils/__tests__/`: Utility tests

## Naming Conventions

**Files:**
- `PascalCase.ts` for classes/services: `TradingService.ts`, `RiskManager.ts`, `StrategyManager.ts`
- `camelCase.ts` for constants/utilities: `secureStorage.ts`, `cn.ts`
- `PascalCase.tsx` for React components: `DashboardView.tsx`, `ActivityLog.tsx`
- `camelCase.test.ts` or `camelCase.spec.ts` for tests: `secureStorage.test.ts`
- Index files: `index.ts` for barrel exports

**Directories:**
- `camelCase` for features: `services/api/`, `services/trading/`, `services/strategies/`
- `PascalCase` for React component containers: `components/charts/`, `components/dashboard/`
- `__tests__` for test directories (adjacent to source)

**Exports:**
- Named exports for classes/functions: `export class TradingService {}`
- Singleton instances: `export const tradingService = new TradingService()`
- Barrel exports in `index.ts`: `export { TradingService, tradingService }`

**Imports:**
- Path alias `@/` resolves to `src/`
- Imports ordered: React → external libs → internal services → types → utils

## Where to Add New Code

**New Feature:**
- Primary code: Implement in dedicated feature service under `src/services/[feature]/`
- If strategy: Extend `BaseStrategy` in `src/services/strategies/[StrategyName].ts`
- Tests: Create adjacent `__tests__/` directory with matching test files
- Export: Add to `src/services/[feature]/index.ts` barrel
- Hooks: Create `useFeature.ts` in `src/hooks/` if UI needs real-time data
- Store: Add to appropriate store or create new one in `src/stores/[featureStore].ts`

**New Component/Module:**
- Implementation: `src/components/[category]/[ComponentName].tsx` for UI components
- Page views: `src/views/[ViewName].tsx` if it's a routed page
- Layout: `src/components/layout/[LayoutName].tsx` for page structure
- Shared primitives: `src/components/ui/[PrimitiveName].tsx`

**Utilities:**
- Shared helpers: `src/utils/[helperName].ts`
- Tests: `src/utils/__tests__/[helperName].test.ts`
- Export via `src/utils/index.ts`

**API/External Integration:**
- New API client: `src/services/api/[ServiceName]Client.ts` extending `BaseApiClient`
- Real-time stream: `src/services/realtime/[ServiceName]Service.ts`
- Hook wrapper: `src/hooks/use[Service].ts` if UI needs subscription

**Testing:**
- Unit tests: Always co-located with source in `__tests__/` subdirectory
- Use Vitest (configured in `vite.config.ts`)
- Test file pattern: `src/services/trading/__tests__/TradingService.test.ts`

## Special Directories

**`src/styles/`**
- Purpose: Global CSS and Tailwind configuration
- Contains: `index.css` (Tailwind directives + custom theme)
- Generated: No (hand-written)
- Committed: Yes

**`dist/`**
- Purpose: Production build output from Vite
- Generated: Yes (run `npm run build`)
- Committed: No (.gitignore)

**`.planning/codebase/`**
- Purpose: GSD codebase analysis documents (this file and others)
- Generated: Via GSD commands
- Committed: Yes (part of documentation)

**`.netlify/`**
- Purpose: Netlify build artifacts and serverless functions
- Generated: Yes (by Netlify CI)
- Committed: No (.gitignore)

**`mcp-server/node_modules/`**
- Purpose: MCP server dependencies
- Generated: Yes (`npm install` in mcp-server/)
- Committed: No (.gitignore)

**`.env`** (and `.env.*`)
- Purpose: Environment variables for API keys, wallet credentials, URLs
- Generated: No (manually created)
- Committed: No (.gitignore) — secrets should never be committed
- Note: Development uses `.env.local` or `.env.development`

**`docs/plans/`**
- Purpose: Implementation plans generated by GSD
- Generated: Via GSD planning commands
- Committed: Yes (part of documentation)

## Proxy Configuration (vite.config.ts)

Vite dev server proxies external APIs to avoid CORS issues:

- `/api/clob` → `https://clob.polymarket.com`
- `/api/coinbase` → `https://api.coinbase.com`
- `/api/polybacktest` → `https://api.polybacktest.com`
- `/api/gamma` → `https://gamma-api.polymarket.com`
- `/api/binance` → `https://api.binance.us`
- `/api/coingecko` → `https://api.coingecko.com`
- `/ws/binance/*` → Binance WebSocket with auto-reconnect (custom Vite plugin)

Services construct URLs like `/api/clob/...` which get proxied by Vite during development. In production, either CORS is configured on the server or requests are proxied via Netlify functions.
