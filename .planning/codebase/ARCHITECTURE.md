# Architecture

**Analysis Date:** 2026-02-25

## Pattern Overview

**Overall:** Layered Client-Side Application with Autonomous Trading Services

AlphaPolyBot is a **React-based client-side trading dashboard** with a sophisticated backend service layer for automated trading. The architecture follows strict separation between **UI rendering** and **trading services**, where services operate independently and asynchronously with their own state management.

**Key Characteristics:**
- Client-side only — no backend server (trades execute through public APIs)
- Multi-service architecture with independent lifecycle management
- Zustand stores for persistent UI state (settings, wallet, notifications)
- Autonomous trading strategies running in parallel with independent ON/OFF controls
- Risk-first architecture with multiple validation gates before execution
- Real-time data pipelines (RTDS, Binance WS, HTTP polling)

## Layers

**UI Layer:**
- Purpose: React components for dashboard, settings, charts, terminal
- Location: `src/components/`, `src/views/`
- Contains: Page layouts, charts (Recharts), terminal, activity logs, dashboards
- Depends on: Hooks (custom data fetchers), Zustand stores, trading services
- Used by: React Router for navigation

**Hooks/Data Layer:**
- Purpose: Custom React hooks that bridge stores and services
- Location: `src/hooks/`
- Contains: `usePolymarketPrices`, `useCryptoPrices`, `useWallet`, `useBalanceHistory`, `useTradeAnalytics`
- Depends on: Zustand stores, real-time services, API clients
- Used by: React components throughout the application

**State Management Layer (Zustand):**
- Purpose: Persistent application state (settings, wallet, notifications, backtest results)
- Location: `src/stores/`
- Contains: `settingsStore`, `walletStore`, `backtestStore`, `notificationStore`, `balanceHistoryStore`
- Depends on: None (standalone)
- Used by: Components, services (read-only for settings), hooks

**Services Layer - API Clients:**
- Purpose: HTTP API communication with Polymarket, Gamma, Binance, CoinGecko
- Location: `src/services/api/`
- Contains: `PolymarketClient`, `CLOBClient`, `DataClient`, `GammaClient`, `PolyBacktestClient`, `PriceOracleService`, `BaseApiClient`
- Depends on: Axios for HTTP, types
- Used by: Trading services, strategies, real-time services, hooks

**Services Layer - Trading Core:**
- Purpose: Order execution, risk management, position tracking
- Location: `src/services/trading/`
- Contains: `TradingService`, `RiskManager`, `PositionLifecycleManager`, `OrderRegistry`, `ActivityLogger`, `TradeLogger`, `RejectionTracker`
- Depends on: API clients, types, Zustand stores
- Used by: Strategies, views

**Services Layer - Strategies:**
- Purpose: Autonomous trading algorithms
- Location: `src/services/strategies/`
- Contains: `StrategyManager`, `BaseStrategy` (abstract), `LLMPredictionStrategy`, `DipArbStrategy`, `ProjectFWStrategy`, `BtcUpDownStrategy`, `GabagoolStrategy`, `DualSideHedgeStrategy`
- Depends on: Trading services, API clients, real-time services, LLM service
- Used by: Main App, SettingsView

**Services Layer - Realtime:**
- Purpose: WebSocket streaming for market prices and order updates
- Location: `src/services/realtime/`
- Contains: `RTDSService`, `BinanceWSService`, `UserChannelService`
- Depends on: API clients, stores
- Used by: Strategies, components via hooks

**Services Layer - Supporting:**
- Purpose: Utilities for wallet, LLM, notifications, storage
- Location: `src/services/wallet/`, `src/services/llm/`, `src/services/notifications/`, `src/services/storage/`
- Contains: Wallet service (ethers.js), OpenRouter LLM client, notification system, IndexedDB persistence
- Depends on: External SDKs, types
- Used by: App initialization, strategies, views

**Types Layer:**
- Purpose: TypeScript type definitions and interfaces
- Location: `src/types/`
- Contains: `api.ts` (Market, Order, Trade types), `wallet.ts` (wallet interfaces), `index.ts` (re-exports)
- Depends on: None
- Used by: All layers

## Data Flow

**Initialization Flow:**

1. `main.tsx` → React root mounts `App.tsx`
2. App sets up error boundary, router, code-splitting
3. App.useEffect runs initialization sequence:
   - IndexedDB storage initialized
   - Activity logger hydrated from storage (trade history)
   - Risk manager initialized (sets up capital tracking)
   - Position lifecycle manager initialized (hydrates tracked stops/profits)
   - GTC order manager initialized (pending GTD fallback orders)
   - Notification service initialized (subscribes to activity logger)
   - Strategy manager initialized (registers all 6 strategies)
   - Real-time services connected (RTDS, Binance WS, User channel)
   - Auto-pruning scheduled every 6 hours
   - Wallet auto-reconnected from env if credential present
   - Balance polling started globally

**Trading Flow (from Strategy):**

1. Strategy detects trade opportunity via real-time prices
2. Calls `TradingService.placeBet(market, outcome, amount, options)`
3. `RiskManager.validateTrade()` gates execution (capital, concentration, position limits)
4. If passed: `OrderRegistry` creates managed order with CREATED → SUBMITTED flow
5. `PolymarketClient` or `CLOBClient` sends FOK order to CLOB API
6. `OrderRegistry` transitions order through states: SUBMITTED → FILLED/EXPIRED/REJECTED
7. On fill: Position is tracked in `PositionLifecycleManager`
8. `TradeLogger` records to IndexedDB and in-memory history
9. `ActivityLogger` broadcasts event (picked up by notifications, risk manager)
10. If FOK expires and GTD fallback enabled: `GtcOrderManager` resubmits as GTD order
11. Stop-loss/take-profit checked periodically by `PositionLifecycleManager`

**Real-Time Price Flow:**

1. RTDS WebSocket stream (primary, BTC only) or Binance WS (ETH, SOL, BTC)
2. Message received → parsed → price update
3. Broadcast via in-memory subscription model
4. Strategies update internal market snapshots
5. Hooks subscribe to price updates → trigger React re-renders

**State Persistence:**

- **Zustand stores:** Settings, wallet address/balances → persisted to localStorage automatically
- **IndexedDB:** Trade records, activity logs, balance history → persisted via `indexedDBService`
- **In-memory:** Strategy states, order registry, risk manager buckets → lost on refresh (but activity log restored)

## Key Abstractions

**BaseStrategy:**
- Purpose: Abstract base class for all trading strategies
- Examples: `src/services/strategies/LLMPredictionStrategy.ts`, `src/services/strategies/DipArbStrategy.ts`
- Pattern: Lifecycle (initialize, start, stop), event emission (statusChanged, tradePlaced), configuration management

**BaseApiClient:**
- Purpose: HTTP client with rate limiting, retry logic, error handling
- Examples: All clients inherit from this
- Pattern: Configurable timeout, max requests/min, retry with exponential backoff

**ActivityLogger / EventBus Pattern:**
- Purpose: Central event hub for trade execution, risk events, errors
- Examples: Used by RiskManager, NotificationService, TradeLogger, ActivityView
- Pattern: Subscribe to events (logTrade, logError, logWarning, logSystem) → broadcast to all listeners

**OrderRegistry / State Machine:**
- Purpose: Tracks order lifecycle with strict state transitions
- Examples: `src/services/trading/oms/OrderRegistry.ts`
- Pattern: CREATED → SUBMITTED → FILLED | CANCELLED | EXPIRED | REJECTED, validators prevent invalid transitions

**Zustand Store Pattern:**
- Purpose: Persistent React state with async actions
- Examples: `useSettingsStore`, `useWalletStore`
- Pattern: `(state) => state.property` selectors, batch updates with `store.setState()`

## Entry Points

**React Root:**
- Location: `src/main.tsx`
- Triggers: Application startup
- Responsibilities: Mount React DOM, bootstrap App component

**App Component:**
- Location: `src/App.tsx`
- Triggers: Router navigation, service initialization
- Responsibilities: Setup routes, initialize all services, manage top-level state, error boundary

**Strategy Manager:**
- Location: `src/services/strategies/StrategyManager.ts`
- Triggers: User enables strategy in settings, App initialization
- Responsibilities: Register strategies, manage lifecycle (initialize/start/stop), notify UI of status changes

**TradingService:**
- Location: `src/services/trading/TradingService.ts`
- Triggers: Strategy calls placeBet(), user manual trade
- Responsibilities: Validate risk, execute order, manage retry/fallback, track in-flight capital

## Error Handling

**Strategy:** Layered error prevention and recovery

**Patterns:**

1. **Risk Gates (Prevention):**
   - RiskManager validates before execution (capital available, position limits, concentration)
   - OrderBookDepth checks liquidity before order submission
   - ReadinessChecker validates system health (API connectivity, strategy readiness)

2. **Validation Tracking:**
   - RejectionTracker logs all rejected trades (too small, insufficient capital, dip detection, risk limits)
   - Surfaced in Settings → Rejection Dashboard

3. **Error Propagation:**
   - ActivityLogger broadcasts errors → NotificationService → browser notifications + toast
   - All failures logged with timestamp, strategy name, error code

4. **Graceful Degradation:**
   - RTDS down → fallback to Binance WS
   - Binance WS down → fallback to HTTP polling
   - GTD fallback: FOK order expires → resubmit as GTD (if enabled)

5. **Position Recovery:**
   - PositionLifecycleManager hydrates from IndexedDB on refresh
   - Stop-loss/take-profit orders continue executing even if browser crashes

## Cross-Cutting Concerns

**Logging:**
- Activity/event logging via `ActivityLogger` (central event bus)
- Trade logging via `TradeLogger` (persistent to IndexedDB)
- Console logging with service prefixes: `[StrategyManager]`, `[TradingService]`, etc.
- Rejection tracking via `RejectionTracker` (categorized by reason)

**Validation:**
- Pre-execution: RiskManager gates (capital, concentration, position limits)
- Pre-submission: OrderBookDepth checks available liquidity
- Pre-strategy-start: ReadinessChecker validates prerequisites
- Post-execution: TradeLogger records all fills + rejections

**Authentication:**
- Wallet: Ethers.js + web3 signing (user imports seed/key)
- CLOB: HMAC-signed requests derived from wallet (polymarket-sdk)
- Public APIs: No auth (Polymarket market data, Gamma, CoinGecko, RTDS)
- OpenRouter: API key stored in settings (secure storage, environment variable)

**Dry-run/Safety:**
- All trades prefixed with dry-run check in TradingService
- Dry-run mode disabled by default (forces user to explicitly enable live trading)
- UI warns before closing/refreshing with live strategies + tracked positions
- Activity log marks all transactions with `[DRY RUN]` or `[LIVE]`
