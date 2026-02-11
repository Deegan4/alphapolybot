# AlphaPolyBot

Browser-based TypeScript/React Polymarket trading bot. Vite 4, React 18, Zustand, Ethers.js, Tailwind, Recharts.

## Commands

```bash
npm run dev          # Vite dev server on :4000 (auto-opens browser)
npm run build        # Production build (uses vite build, NOT tsc)
npm test             # Vitest single run (236 tests)
npm run test:watch   # Vitest watch mode
npm run lint         # ESLint (.eslintrc.cjs)
npm run preview      # Preview production build
```

**Build**: Always use `npx vite build`. Never use `tsc --noEmit` standalone — tsconfig has `ignoreDeprecations: "6.0"` which standalone tsc rejects.

## Architecture

- **Singleton services** exported from modules: `export const tradingService = new TradingService()`
- **Event-driven strategies**: BaseStrategy has `.on()` / `.emit()` pattern
- **Zustand stores** with `persist` middleware (settingsStore, walletStore). notificationStore has no persist.
- **Barrel exports** via `index.ts` in each service directory
- **ActivityLogger** is the central audit trail — services subscribe to it
- **Path alias**: `@/` maps to `src/`

### Five Trading Strategies
1. **LLM Prediction** — AI-powered via OpenRouter, analyzes markets with LLMs
2. **Dip Arbitrage** — Mechanical, buys price dips on binary markets
3. **ProjectFW Arb** — Frank-Wolfe optimized spread arbitrage with Bregman projection
4. **BTC Up/Down** — 5-factor signal (momentum, velocity, time_decay, value_bet, order_flow) on crypto direction markets
5. **Microstructure Momentum** — Trades on bid/ask imbalance and flow toxicity signals from MicrostructureAnalyzer

## Directory Structure

```
src/
├── components/
│   ├── charts/        # MatrixLineChart, MatrixAreaChart, MatrixPieChart
│   ├── dashboard/     # MatrixDataTable, MatrixStatWidget, MatrixTimeline
│   ├── layout/        # AppLayout, Header, Sidebar, MatrixRain
│   └── ui/            # 18 Matrix-themed components (Button, Card, Modal, Toast, etc.)
├── hooks/             # useWallet
├── services/
│   ├── api/           # CLOBClient, GammaClient, DataClient, PriceOracleService
│   ├── llm/           # OpenRouterService (multi-model, budget-bucketed)
│   ├── notifications/ # NotificationService (toast + browser + Web Audio)
│   ├── realtime/      # RealtimeService, RTDSService (crypto prices), UserChannelService (auth push)
│   ├── storage/       # IndexedDBService (v4, 6 object stores)
│   ├── strategies/    # BaseStrategy, LLMPrediction, DipArb, ProjectFW, BtcUpDown, MicroMomentum
│   │   ├── __tests__/ # DipArb, FW Optimizer, FW Strategy tests
│   │   └── projectfw/ # FrankWolfeOptimizer, ArbitrageScanner, crossmarket/
│   ├── trading/       # TradingService, RiskManager, PLM, ActivityLogger, GtcOrderManager,
│   │   │              # KellySizer, GasOracle, OrderBookDepth, TradeLogger,
│   │   │              # CalibrationTracker, MicrostructureAnalyzer
│   │   └── __tests__/ # RiskManager, PLM, KellySizer tests
│   └── wallet/        # WalletService (Ethers.js wrapper)
├── stores/            # settingsStore (v7), walletStore, notificationStore (Zustand)
├── types/             # api.ts, wallet.ts, index.ts
├── utils/             # secureStorage, cn (tailwind-merge)
└── views/             # TradingTerminal, PortfolioView, ActivityView, SettingsView
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
- **Taker fee ~1%** (100 bps). With 2 legs on binary: ~2% total fee, so need >2% incoherence to profit.

### FW Optimizer
- Large `epsilonD` (e.g., 0.1) causes early convergence before finding profit for small incoherence. Needs >20% price gap for loose convergence.

### Environment
- Project lives on external drive: `/Volumes/SAMSUNG 1TB/alphapolybot` — paths have spaces, always quote.
- `useWalletStore.getState()` is synchronous Zustand read, safe in non-React service code.
- **Vite dev proxies** (in `vite.config.ts`): `/api/clob` → Polymarket CLOB, `/api/gamma` → Gamma API, `/api/polygon-rpc` + `/api/polygon-rpc2` → Polygon RPC nodes. API calls use these proxy paths in dev to avoid CORS.

## Testing

- **Framework**: Vitest + jsdom + @testing-library/react
- **Config**: `vitest.config.ts` (globals enabled, jsdom environment)
- **236 tests** across 10 files: RiskManager (31), PLM (25), DipArb (21), FW Optimizer (31), FW Strategy (17), KellySizer (33), CrossMarket (23), OpenRouterService (21), secureStorage (19), settingsStore (15)
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
- **TypeScript**: Strict mode via tsconfig, but build uses Vite's esbuild (not tsc)

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

## Deployment

- **Netlify**: `netlify.toml` configured — build `npm ci && npm run build`, publish `dist/`, SPA redirect, API proxies
- **CI/CD**: `.github/workflows/` — runs tests + build on push/PR to main (Node 20)
