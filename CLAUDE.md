# AlphaPolyBot

Browser-based TypeScript/React Polymarket trading bot. Vite 7, React 18, Zustand, Ethers.js, Tailwind, Recharts.

## Commands

```bash
npm run dev          # Vite dev server on :4000 (auto-opens browser)
npm run dev:strict-csp # Dev server with strict CSP headers
npm run build        # Production build (uses vite build, NOT tsc)
npm test             # Vitest single run (762 tests)
npm run test:watch   # Vitest watch mode
npm run lint         # ESLint (.eslintrc.cjs)
npm run preview      # Preview production build
```

**Build**: Always use `npx vite build`. Never use `tsc --noEmit` standalone — tsconfig has `ignoreDeprecations: "6.0"` which standalone tsc rejects.

## Architecture

- **Singleton services** exported from modules: `export const tradingService = new TradingService()`
- **Event-driven strategies**: BaseStrategy has `.on()` / `.emit()` pattern
- **Zustand stores** with `persist` middleware (settingsStore v49, walletStore). notificationStore and backtestStore have no persist.
- **Barrel exports** via `index.ts` in each service directory
- **ActivityLogger** is the central audit trail — services subscribe to it
- **Path alias**: `@/` maps to `src/`

### Six Trading Strategies
1. **LLM Prediction** — AI-powered via OpenRouter, analyzes markets with LLMs. GTD-first order mode (maker 0% fees)
2. **Dip Arbitrage** — Mechanical, buys price dips on binary markets
3. **ProjectFW Arb** — Frank-Wolfe optimized spread arbitrage with Bregman projection
4. **BTC Up/Down** — Resolution-hold on cheap outcomes. 5-factor vol-normalized signal with regime detection, RSI filter. Primary focus on 1hr + 4hr windows (15m opt-in). BinanceWS high-freq buffer.
5. **Dual-Side Hedge** — Maker-only YES+NO orders with 70/30 bias, event-driven via signalComputed, DynamicFeeService viability gate
6. **Gabagool Accumulator** — Direction-agnostic merge arbitrage on BTC 15m markets. Accumulates cheap YES+NO shares via maker-only GTC orders until pair cost < $1.00, then merges for guaranteed profit.

## Directory Structure

```
src/
├── components/
│   ├── charts/        # MatrixLineChart, MatrixAreaChart, MatrixBarChart, MatrixPieChart,
│   │                  # MatrixGauge, MatrixSparkline
│   ├── dashboard/     # ActivePositionsCard, AssetCard, AssetCardsRow, BacktestView,
│   │                  # DiagnosticsBanner, HistoryView, PerformancePanel, PortfolioPanel,
│   │                  # ReadinessPanel, RecentTradesGrid, SniperTopBar, StrategyDropdown,
│   │                  # WindowTimer, MatrixDataTable, MatrixMetricCard, MatrixProgressCard, etc.
│   ├── layout/        # AppLayout, DashboardLayout, SettingsLayout, Header, Sidebar, MatrixRain
│   └── ui/            # 19 Matrix-themed components (Button, Card, Modal, Toast, Resizable, etc.)
├── hooks/             # useWallet, useBalanceHistory, useCryptoPrices, usePolymarketPrices
├── services/
│   ├── api/           # BaseApiClient, CLOBClient, GammaClient, DataClient, PolymarketClient,
│   │                  # PriceOracleService, PolyBacktestClient
│   ├── llm/           # OpenRouterService (multi-model, budget-bucketed)
│   ├── notifications/ # NotificationService (toast + browser + Web Audio)
│   ├── realtime/      # RealtimeService, RTDSService (crypto), UserChannelService (auth push),
│   │                  # BinanceWSService
│   ├── storage/       # IndexedDBService (v4, 6 object stores)
│   ├── strategies/    # BaseStrategy, LLMPrediction, DipArb, ProjectFW, BtcUpDown,
│   │                  # DualSideHedge, GabagoolStrategy, DipDetector
│   │   ├── __tests__/ # DipArb, FW Optimizer, FW Strategy, BtcUpDown, DualSideHedge, Gabagool tests
│   │   ├── btcupdown/ # signalEngine, BacktestRunner, HistoricalEnrichment
│   │   └── projectfw/ # FrankWolfeOptimizer, ArbitrageScanner, crossmarket/
│   ├── trading/       # TradingService, RiskManager, PLM, ActivityLogger, GtcOrderManager,
│   │   │              # KellySizer, GasOracle, OrderBookDepth, TradeLogger, EdgeTracker,
│   │   │              # CalibrationTracker, ReadinessChecker, RejectionTracker,
│   │   │              # MarketScanner, DynamicFeeService, MergeService,
│   │   │              # AvellanedaStoikovPricer, BtcCalibrationService, VPINService
│   │   ├── oms/       # OrderStateMachine (77-state FSM), OrderRegistry (lifecycle tracking)
│   │   └── __tests__/ # RiskManager, PLM, KellySizer, EdgeTracker, DynamicFeeService,
│   │                  # AvellanedaStoikov, KellyMonteCarlo, MergeService, VPINService tests
│   └── wallet/        # WalletService (Ethers.js wrapper)
├── stores/            # settingsStore (v49), walletStore, notificationStore, balanceHistoryStore, backtestStore
├── types/             # api.ts, wallet.ts, index.ts
├── utils/             # secureStorage, cn (tailwind-merge)
└── views/             # TradingTerminal, DashboardView, PortfolioView, ActivityView, SettingsView, NotFoundView
```

## Critical Gotchas

### Circular Dependencies (solved — do not reintroduce)
1. **StrategyManager <-> TradingService <-> RiskManager**: `emergencyStop()` in RiskManager uses dynamic `import()` to reach StrategyManager
2. **settingsStore <-> RiskManager**: Each setter in settingsStore uses dynamic `import()` with fire-and-forget `.then()`. NEVER top-level import riskManager in settingsStore.
3. **PLM -> RiskManager**: This static import IS safe (no cycle). PLM calls `riskManager.recordTradeResult()` directly.

### BaseStrategy Lifecycle
- `_enabled` is set by `enable()`, NOT by `start()`. If code guards on `_enabled`, it won't fire if only `start()` was called.
- Tests must call `enable()` for full lifecycle, not just `start()`.

### Polymarket Exchange
- **USDC.e only**: Exchange uses bridged USDC.e (`0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174`), NOT native USDC (`0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359`). Native USDC is invisible to the exchange.
- **Three contracts need approvals**: (1) CTF Exchange `0x4bFb…982E`, (2) NegRisk CTF Exchange `0xC5d5…80a`, (3) NegRisk Adapter `0xd91E…5296`. Both `USDC.approve()` and `CTF.setApprovalForAll()` for each.
- **CLOB `/balance-allowance` API**: Returns exchange-visible balance (may differ from on-chain). Use for pre-flight checks.
- **"not enough balance" is NOT transient**: Never retry — the exchange `transferFrom` will always fail without USDC.e.
- **Pre-flight failures are structural**: Don't count toward RiskManager consecutive failure circuit breaker.

### WebSocket Protocol
- **Market channel** (`wss://…/ws/market`): Two-phase subscription — initial `{assets_ids, type:'market'}`, dynamic `{assets_ids, operation:'subscribe'}`. Messages use `event_type` field (not `type`). `price_change` wraps data in `price_changes` array with string `best_bid`/`best_ask`. **30s ping**.
- **User channel** (`wss://…/ws/user`): Auth via `{type:'user', auth:{apiKey,secret,passphrase}}`. Push-based trade/order events. **30s ping**.
- **RTDS** (`wss://ws-live-data.polymarket.com`): Public crypto price feed, no auth. **5s ping** (different from CLOB 30s — will disconnect if wrong).

### Market Data
- **Gamma mid-prices always sum to exactly 1.00**: Display prices, NOT tradeable. Coherence filtering on Gamma prices is useless.
- **CLOB ask sums typically 1.005–1.02**: Market maker spread. Real buy-all-merge arb only works when ask sum temporarily dips below $1.00 (rare on liquid markets).
- **Dynamic taker fees** (Feb 2026): Formula `fee = 2500 × (p × (1-p))²`, max ~156 bps at 50% price, near zero at extremes. 15-min crypto markets = 1000 bps (10%). Makers pay 0% + earn rebates.
- With 2 legs on binary: ~2-3% total taker fee, so need >3% incoherence to profit as taker.

### Maker vs Taker Fee Meta (Feb 2026)
- **Makers pay 0%** + earn daily USDC rebates. **Takers pay dynamic fees** up to 1.56%.
- **GTD/GTC limit orders** fill as maker (0% fees). **FOK market orders** are always taker.
- **Strategy order modes**: LLM Prediction = GTD (10 min), BTC Up/Down = GTC if makerMode, Dual-Side = GTC+postOnly, Gabagool = GTC+postOnly, DipArb = GTD (2 min). ProjectFW remains FOK taker.
- **settingsStore fields**: `llmOrderMode`, `microOrderMode` control GTD vs FOK per strategy.
- **PLM default taker fee**: `DEFAULT_TAKER_FEE_PERCENT = 0.01` (100 bps). Strategies should set `takerFeeBps` on positions; if omitted, this default applies.
- **DynamicFeeService**: `computeTakerFeeBps(price)` implements the quadratic formula. Used by BtcUpDown and DualSide for EV viability gates.

### FW Optimizer
- Large `epsilonD` (e.g., 0.1) causes early convergence before finding profit for small incoherence. Needs >20% price gap for loose convergence.
- **Coherence filter direction**: `Math.abs(sum - 1.0) < X` is a "reject-if-within" filter. Larger X rejects MORE markets (bigger exclusion zone). Smaller X rejects FEWER. Current: 0.001 (0.1%).

### Order Signing (CLOBClient)
- **`signatureType`**: On-chain `Signatures.sol` dispatches to 3 different verification functions: `verifyEOASignature()` (type 0), `verifyPolyProxySignature()` (type 1), `verifyPolySafeSignature()` (type 2). Wrong type = instant "invalid signature". Standard Polymarket proxy = type 1. Type 2 is only for actual Gnosis Safe wallets.
- **`side` field has TWO formats**: EIP-712 signed data uses uint8 `0`/`1`. The API request body uses `"BUY"`/`"SELL"` strings. Server maps them back internally. Sending `"0"`/`"1"` in the body causes "invalid signature".
- **Tick size is per-token**: Markets have tick sizes of 0.1, 0.01, 0.001, or 0.0001. Must query `/tick-size?token_id=X`. `ROUNDING_CONFIG` maps tick to decimal places. "invalid signature" can also mean tick-size precision violation.
- **`feeRateBps` is per-token**: Must query `/fee-rate?token_id=X`. 15-min crypto markets = 1000 bps (10%), standard markets = 0-100 bps. Wrong fee = "invalid fee rate" 400 error.
- **`negRisk` is per-token**: Must query `/neg-risk?token_id=X`. Wrong value = wrong EIP-712 domain = "invalid signature".
- **`VITE_SIGNATURE_TYPE` env var**: Override auto-detection with explicit 0/1/2.


### Environment
- Project lives on external drive: `/Volumes/SAMSUNG 1TB/alphapolybot` — paths have spaces, always quote.
- `useWalletStore.getState()` is synchronous Zustand read, safe in non-React service code.
- **Vite dev proxies** (in `vite.config.ts`): `/api/pm-us` → `api.polymarket.us`, `/api/pm-gateway` → `gateway.polymarket.us`, `/api/gamma` → Gamma API, `/api/coinbase` → Coinbase API, `/api/polybacktest` → PolyBacktest API, `/v1/` → `api.polymarket.us` (direct, for SDK URL construction). API calls use these proxy paths in dev to avoid CORS.

## Testing

- **Framework**: Vitest + jsdom + @testing-library/react
- **Config**: `vitest.config.ts` (globals enabled, jsdom environment)
- **798 tests** across 31 files: RiskManager (32), PLM (25), DipArb (21), FW Optimizer (31), FW Strategy (17), KellySizer (33), CrossMarket (23), OpenRouterService (21), secureStorage (19), settingsStore (18), BtcUpDown (38), EdgeTracker (24), ArbitrageProfitFormula (30), signalEngine (54), signalFusion (12), BacktestRunner (12), PolyBacktestClient (15), DualSideHedge (27), DynamicFeeService (27), ChainlinkFeedService (20), OrderStateMachine (77), OrderRegistry (51), MergeService (13), Gabagool (28), AvellanedaStoikov (34), KellyMonteCarlo (17), VPINService (25), MCP tools (12), MCP PMUS tools (23), MCP rounding (11), MCP auth (8)
- Test files live in `__tests__/` directories next to the code they test

## Environment Setup

1. `cp .env.example .env`
2. Required: `VITE_WALLET_SEED_PHRASE` (dedicated trading wallet!) and `VITE_OPENROUTER_API_KEY`
3. All other vars have working defaults (Polygon mainnet, Polymarket endpoints)
4. See `.env.example` for full setup checklist

## Code Style

- **UI**: All components use Matrix theme (green/cyan on dark). Custom components prefixed `Matrix*`.
- **Tailwind**: Extended theme in `tailwind.config.js` with matrix colors, animations, shadows
- **ESLint**: `.eslintrc.cjs` at project root. `npm run lint` works.
- **TypeScript**: Strict mode via tsconfig, but build uses Vite's esbuild transform (not tsc)

## Risk Management

RiskManager is a circuit breaker with:
- Daily loss limit: $10
- Hourly trade limit: 20
- Consecutive failure limit: 5
- Balance check before every trade
- Emergency stop (halts all strategies)

PositionLifecycleManager enforces SL/TP via real-time WebSocket price monitoring with 3-retry sell, double-sell prevention, IndexedDB persistence, and crash recovery.

## IndexedDB Schema

Database `alphapolybot` at version 4 with 6 object stores:
- `activities` — audit trail (30-day auto-cleanup)
- `positions` — PLM crash recovery (keyed by tokenId)
- `arbRounds` — historical arb rounds
- `gtcOrders` — pending GTC limit orders
- `tradeRecords` — structured trade log (40+ fields per record)
- `calibrationData` — LLM confidence calibration (Brier score)

Storage failures are non-critical and never block bot execution.

## MCP Server

`mcp-server/` contains a standalone Model Context Protocol server for AI-assisted trading operations. Separate `package.json`, own test suite (54 tests across 4 files: tools, PMUS tools, rounding, auth). Built with TypeScript, tested with Vitest.

## Claude Code Automations

- **Agents** (5): trading-bot-architect, trade-flow-reviewer, security-reviewer, market-researcher, fee-impact-reviewer
- **Skills** (9): ci, deploy, run-checks, new-strategy, polymarket-api, trade-safety, scan-status, fee-calculator, strategy-health
- **Commands** (6): trade, strategy, risk, portfolio, scan, analyze
- **Hooks**: .env/lockfile block, ESLint-on-edit, smart test matching (source→`__tests__/`), build-on-type-change, settingsStore version guard, circular dep prevention, strategy edit fee reminder
- **MCP Server**: Custom Polymarket server (`mcp-server/`, 54 tests)

## Deployment

- **Netlify**: `netlify.toml` configured — build `npm ci && npm run build`, publish `dist/`, SPA redirect, API proxies
- **CI/CD**: `.github/workflows/` — runs tests + build on push/PR to main (Node 20)
