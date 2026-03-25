# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

# AlphaPolyBot

Browser-based TypeScript/React Polymarket trading bot. Vite 7, React 18, Zustand, Ethers.js, Tailwind, Recharts.

## Commands

```bash
npm run dev          # Vite dev server on :4000 (auto-opens browser)
npm run dev:strict-csp # Dev server with strict CSP headers
npm run build        # Production build (uses vite build, NOT tsc)
npm test             # Vitest single run (1159 tests)
npm run test:watch   # Vitest watch mode
npm run lint         # ESLint (.eslintrc.cjs, --max-warnings 0)
npm run preview      # Preview production build

# Single test file / single test
npx vitest run src/services/trading/__tests__/RiskManager.test.ts
npx vitest run -t "should enforce daily loss limit"
```

**Build**: Always use `npx vite build`. Never use `tsc --noEmit` standalone — tsconfig has `ignoreDeprecations: "6.0"` which standalone tsc rejects.

## Architecture

- **Singleton services** exported from modules: `export const tradingService = new TradingService()`
- **Event-driven strategies**: BaseStrategy has `.on()` / `.emit()` pattern
- **Zustand stores** with `persist` middleware (settingsStore v67, walletStore). notificationStore and backtestStore have no persist.
- **Barrel exports** via `index.ts` in each service directory
- **ActivityLogger** is the central audit trail — services subscribe to it
- **Path alias**: `@/` maps to `src/`

### Eight Trading Strategies
1. **LLM Prediction** — AI-powered via local Ollama, analyzes markets with LLMs. GTD-first order mode (maker 0% fees)
2. **Dip Arbitrage** — Mechanical, buys price dips on binary markets
3. **ProjectFW Arb** — Frank-Wolfe optimized spread arbitrage with Bregman projection
4. **BTC Up/Down** — Resolution-hold on cheap outcomes. 8-factor vol-normalized signal with regime detection, RSI filter, MRO oscillator, CVD divergence. Primary focus on 1hr + 4hr windows (15m opt-in). BinanceWS high-freq buffer. HLP sentiment contrarian gate.
5. **Dual-Side Hedge** — Maker-only YES+NO orders with 70/30 bias, event-driven via signalComputed, DynamicFeeService viability gate
6. **Gabagool Accumulator** — Direction-agnostic merge arbitrage on BTC 15m markets. Accumulates cheap YES+NO shares via maker-only GTC orders until pair cost < $1.00, then merges for guaranteed profit. Gasless merges via Polymarket Relayer (if API key set).
7. **Impulse Sniper** — Latency arb exploiting BinanceWS crypto price moves vs. Polymarket repricing lag. Multi-asset (BTC/ETH/SOL/XRP), vol-aware dynamic thresholds via AvellanedaStoikovPricer, VPIN toxicity filter, EdgeTracker circuit breaker. 1h markets preferred (15m = 10% taker fee kills edge).
8. **Liquidation Momentum** — Monitors Hyperliquid BTC liquidation cascades via WebSocket. Long liqs → buy DOWN, short liqs → buy UP on 5m Polymarket binaries. Configurable $25K–$100K threshold range, 60s rolling window. GTD maker-only orders (0% fees). Moon Dev multi-exchange confirmation boost + position proximity asymmetry boost. Hedge leg on Hyperliquid planned for v2.

9. **Copy Trading** — Mirrors trades from followed whale wallets. Polls Gamma API for target wallet activity, copies BUYs with GTD maker orders (0% fees). Configurable SL/TP, max concurrent, buys-only mode.

### Supporting Services
- **HyperliquidHedgeService** (`src/services/trading/HyperliquidHedgeService.ts`) — Delta hedging for unpaired Polymarket exposure. Opens opposite positions on Hyperliquid to neutralize directional risk while waiting for paired fills. Used by Gabagool/DualSide for unpaired exposure problem.
- **WeatherMarketAdapter** (`src/services/strategies/WeatherMarketAdapter.ts`) — Scanner for Polymarket weather/temperature markets. NOT a strategy — it's a market discovery adapter that feeds weather markets to existing strategies. Fetches NWS forecasts (free, no API key) to estimate fair probabilities. Weather markets have lower fees (~100 bps max) than crypto (~156 bps).

### Strategy Viability Ranking (Mar 2026)

**Tier 1 — Structural edge (recommended enabled):**
- **Gabagool Accumulator** — Only strategy with guaranteed profit (YES+NO pair < $1.00 → merge for $1.00). Maker-only (0% fees). Catches are: opportunities rare on liquid markets, capital sits idle waiting for cheap fills.
- **Impulse Sniper** — Real latency arb with vol-aware thresholds + circuit breakers. 1h markets only (15m = 10% taker fee kills edge).

**Tier 2 — Positive EV, fee-aware (enable with monitoring):**
- **Dual-Side Hedge** — Maker-only = 0% fees + rebates. DynamicFeeService viability gate prevents bad trades.
- **BTC Up/Down** — 8-factor signal, resolution-hold. Best on 1h + 4h windows with maker mode enabled.
- **Liquidation Momentum** — Novel signal source (Hyperliquid cascades). GTD maker-only. Newer/less validated.

**Tier 2.5 — Proven strategy, unvalidated locally (enable with monitoring):**
- **Copy Trading** — Mirrors whale wallets. GTD maker = 0% fees. Proven $65K/month by others. Needs good wallet selection.

**Tier 3 — Marginal after fees (use cautiously):**
- **LLM Prediction** — Edge depends entirely on Ollama model quality. Check calibration Brier scores before trusting.
- **ProjectFW Arb** — FOK taker orders pay full dynamic fee. Needs >2-3% incoherence (rare on liquid markets).
- **Dip Arb** — GTD helps but mechanical dip-buying has thin edge on binary markets.

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
├── hooks/             # useWallet, useBalanceHistory, useCryptoPrices, usePolymarketPrices, useTradeAnalytics
├── services/
│   ├── api/           # BaseApiClient, CLOBClient, GammaClient, DataClient, PolymarketClient,
│   │                  # PriceOracleService, PolyBacktestClient, MoonDevClient, CryptoComClient
│   ├── llm/           # OllamaService (local LLM), LLMInteractionStore, TrainingDataExporter
│   ├── notifications/ # NotificationService (toast + browser + Web Audio)
│   ├── realtime/      # RealtimeService, RTDSService (crypto), UserChannelService (auth push),
│   │                  # BinanceWSService, HyperliquidWSService
│   ├── backtest/      # BacktestOrchestrator, BacktestSummaryEngine, SnapshotRecorder,
│   │                  # FreeDataAdapter, per-strategy runners (DipArb, DualSide, Gabagool,
│   │                  # Impulse, LLM, ProjectFW)
│   ├── storage/       # IndexedDBService (v6, 7 object stores), SupabaseService
│   ├── strategies/    # BaseStrategy, LLMPrediction, DipArb, ProjectFW, BtcUpDown,
│   │                  # DualSideHedge, GabagoolStrategy, ImpulseSniper, LiquidationMomentum, DipDetector
│   │   ├── __tests__/ # DipArb, FW Optimizer, FW Strategy, BtcUpDown, DualSideHedge, Gabagool, ImpulseSniper, LiquidationMomentum tests
│   │   ├── btcupdown/ # signalEngine (8-factor: momentum, velocity, timeDecay, valueBet,
│   │   │              # orderFlow, crossAsset, MRO, CVD), BacktestRunner, HistoricalEnrichment
│   │   └── projectfw/ # FrankWolfeOptimizer, ArbitrageScanner, crossmarket/
│   ├── trading/       # TradingService, RiskManager, PLM, ActivityLogger, GtcOrderManager,
│   │   │              # KellySizer, GasOracle, OrderBookDepth, TradeLogger, EdgeTracker,
│   │   │              # CalibrationTracker, ReadinessChecker, RejectionTracker,
│   │   │              # MarketScanner, DynamicFeeService, MergeService,
│   │   │              # AvellanedaStoikovPricer, BtcCalibrationService, VPINService,
│   │   │              # LiquidationHeatmapService, MoonDevLiquidationService,
│   │   │              # MoonDevPositionProximityService, MoonDevSentimentService
│   │   ├── oms/       # OrderStateMachine (77-state FSM), OrderRegistry (lifecycle tracking)
│   │   └── __tests__/ # RiskManager, PLM, KellySizer, EdgeTracker, DynamicFeeService,
│   │                  # AvellanedaStoikov, KellyMonteCarlo, MergeService, VPINService,
│   │                  # LiquidationHeatmapService, MoonDevServices tests
│   └── wallet/        # WalletService (Ethers.js wrapper)
├── stores/            # settingsStore (v62), walletStore, notificationStore, balanceHistoryStore, backtestStore
├── types/             # api.ts, wallet.ts, index.ts
├── utils/             # secureStorage, cn (tailwind-merge)
└── views/             # TradingTerminal, DashboardView, PortfolioView, ActivityView, SettingsView, NotFoundView
scripts/               # generate-training-data.ts, finetune.sh, prepare-training-data.py, etc.
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

### Polymarket Relayer (Gasless Merges)
- **MergeService** has two paths: relayer (gasless, preferred) and direct on-chain (fallback, requires MATIC).
- **Relayer headers**: `RELAYER_API_KEY` + `RELAYER_API_KEY_ADDRESS` (signer: `0xe19b…de33`).
- **settingsStore**: `relayerApiKey` is non-persisted (like `moondevApiKey`). Set via Settings → API Keys.
- **Merge flow**: `merge()` → try relayer first → if no key or failure → fall back to direct CTF contract call.
- **`MergeResult.via`**: `'relayer'` or `'direct'` — logged by GabagoolStrategy for audit trail.

### WebSocket Protocol
- **Market channel** (`wss://…/ws/market`): Two-phase subscription — initial `{assets_ids, type:'market'}`, dynamic `{assets_ids, operation:'subscribe'}`. Messages use `event_type` field (not `type`). `price_change` wraps data in `price_changes` array with string `best_bid`/`best_ask`. **30s ping**.
- **User channel** (`wss://…/ws/user`): Auth via `{type:'user', auth:{apiKey,secret,passphrase}}`. Push-based trade/order events. **30s ping**.
- **RTDS** (`wss://ws-live-data.polymarket.com`): Public crypto price feed, no auth. **5s ping** (different from CLOB 30s — will disconnect if wrong).

### Market Data
- **Gamma mid-prices always sum to exactly 1.00**: Display prices, NOT tradeable. Coherence filtering on Gamma prices is useless.
- **CLOB ask sums typically 1.005–1.02**: Market maker spread. Real buy-all-merge arb only works when ask sum temporarily dips below $1.00 (rare on liquid markets).
- **Dynamic taker fees** (Feb 2026 crypto, Mar 30 2026 all categories): Formula `fee = MULTIPLIER × (p × (1-p))²`. Per-category multipliers in `DynamicFeeService`: crypto/sports = 2500 (~156 bps max), politics/finance/tech/weather = 1600 (~100 bps max), economics/culture/science = 1280 (~80 bps max). 15-min crypto markets = 1000 bps (10%). Makers pay 0% + earn rebates.
- `DynamicFeeService.inferCategory(market)` auto-detects category from slug/tags/category field. Use `estimateDynamicFee(price, category)` — boolean overload still works for backward compat.
- With 2 legs on binary: ~2-3% total taker fee (crypto), ~1.2% (politics), so need >3%/1.5% incoherence to profit as taker.

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
- **Vite dev proxies** (in `vite.config.ts`): `/api/pm-us` → `api.polymarket.us`, `/api/pm-gateway` → `gateway.polymarket.us`, `/api/gamma` → Gamma API, `/api/polybacktest` → PolyBacktest API, `/api/moondev` → `api.moondev.com`, `/v1/` → `api.polymarket.us` (direct, for SDK URL construction). API calls use these proxy paths in dev to avoid CORS.

### Moon Dev Data Layer (api.moondev.com)
- **MoonDevClient** (`src/services/api/MoonDevClient.ts`): API client for Moon Dev's Hyperliquid Data Layer. Auth via `X-API-Key` header. Rate limit 3600 req/min. Key set at runtime via `moondevApiKey` in settingsStore (not persisted — secrets must not persist in plain-text localStorage).
- **Endpoints**: `getPositions()`, `getPositionSnapshots(symbol)`, `getHLPSentiment()`, `getAllLiquidations(timeframe)`, `getOrderFlow()`, `getImbalance(timeframe)`, `health()`
- **3 Polling Services** (all follow LiquidationHeatmapService singleton pattern, all require API key):
  1. **MoonDevLiquidationService** (30s poll) — Multi-exchange BTC liquidation aggregation (Hyperliquid+Binance+Bybit+OKX). Rolling 1m/5m/10m/15m windows. `getLiquidationSummary()` returns dominant side + cascade momentum. Used by LiquidationMomentumStrategy as 15% confidence boost when cross-exchange data confirms direction.
  2. **MoonDevPositionProximityService** (60s poll) — Tracks whale positions within 2% of liquidation. `getNearLiquidationFuel(side)` returns count/totalValue/within1Pct/within2Pct. `getProximitySignal()` returns fuel asymmetry. Used by LiquidationMomentumStrategy as 10% confidence boost when fuel is heavily asymmetric (>2x).
  3. **MoonDevSentimentService** (5min poll) — HLP z-score contrarian filter. `getSentimentSignal(coin)` returns zScore/direction/isExtreme. `shouldFilterTrade(coin, direction)` gates trades when extreme z-score opposes signal. Used by BtcUpDownStrategy as viability gate (skips trade when retail is crowded on our side).
- **CVD Signal Factor** (`signalEngine.ts`): `computeCVD()` computes tick-level Cumulative Volume Delta from BinanceWS price buffer. `detectCVDDivergence()` identifies price/CVD disagreement (accumulation/distribution). 8% weight in signal composite when `btcCvdEnabled=true`. No Moon Dev API needed — computed from existing tick data.
- **Settings** (settingsStore v66): `btcCvdEnabled`, `btcCrossExchangeEnabled`, `btcCrossExchangeMaxDivergencePct` (default 0.15%), `moondevMultiExchangeLiqEnabled`, `moondevProximityEnabled`, `moondevSentimentEnabled`, `moondevSentimentMinZScore` (default 2.0), `moondevProximityMaxDistancePct` (default 2.0). All Moon Dev services default to off.

## Testing

- **Framework**: Vitest + jsdom + @testing-library/react
- **Config**: `vitest.config.ts` (globals enabled, jsdom environment)
- **1169 tests** across 44 files (run `npm test` to verify)
- Test files live in `__tests__/` directories next to the code they test

## Environment Setup

1. `cp .env.example .env`
2. Install Ollama (`https://ollama.com/download`), build model: `ollama create polytrader -f Modelfile.polytrader` (based on plutus 8B — fits 16GB RAM)
3. Wallet seed phrase/private key must be entered securely in the Settings UI or via hardware wallet/KMS. Never store secrets in env files or source control.
4. All other vars have working defaults (Polygon mainnet, Polymarket endpoints)
5. See `.env.example` for full setup checklist

## Code Style

- **Comments**: Use sparingly. Only comment complex code.
- **UI**: All components use Matrix theme (green/cyan on dark). Custom components prefixed `Matrix*`.
- **Tailwind**: Extended theme in `tailwind.config.js` with matrix colors, animations, shadows
- **ESLint**: `.eslintrc.cjs` at project root. `npm run lint` works.
- **TypeScript**: Strict mode via tsconfig, but build uses Vite's esbuild transform (not tsc)

## Risk Management

RiskManager is a circuit breaker with:
- Daily loss limit: $3 (v66, tuned for $20 bankroll)
- Weekly loss limit: $6
- Hourly trade limit: 15
- Consecutive failure limit: 3
- Min balance floor: $3
- Max drawdown: 25% from peak ($5 emergency stop)
- Balance check before every trade
- Emergency stop (halts all strategies)

PositionLifecycleManager enforces SL/TP via real-time WebSocket price monitoring with 3-retry sell, double-sell prevention, IndexedDB persistence, and crash recovery.

## IndexedDB Schema

Database `alphapolybot` at version 6 with 7 object stores:
- `activities` — audit trail (30-day auto-cleanup)
- `positions` — PLM crash recovery (keyed by tokenId)
- `arbRounds` — historical arb rounds
- `gtcOrders` — pending GTC limit orders
- `tradeRecords` — structured trade log (40+ fields per record)
- `calibrationData` — LLM confidence calibration (Brier score)
- `llmInteractions` — training data capture (every LLM prompt/response/outcome)

Storage failures are non-critical and never block bot execution.

## MCP Server

`mcp-server/` contains a standalone Model Context Protocol server for AI-assisted trading operations. Separate `package.json`, own test suite (54 tests across 4 files: tools, PMUS tools, rounding, auth). Built with TypeScript, tested with Vitest.

## Claude Code Automations

- **Agents** (5): trading-bot-architect, trade-flow-reviewer, security-reviewer, market-researcher, fee-impact-reviewer
- **Skills** (9): ci, deploy, run-checks, new-strategy, polymarket-api, trade-safety, scan-status, fee-calculator, strategy-health
- **Commands** (6): trade, strategy, risk, portfolio, scan, analyze
- **Hooks**: .env/lockfile block, ESLint-on-edit, smart test matching (source→`__tests__/`), build-on-type-change, settingsStore version guard, circular dep prevention, strategy edit fee reminder
- **MCP Server**: Custom Polymarket server (`mcp-server/`, 54 tests)

## LLM Training Pipeline

- **Modelfile.polytrader**: System prompt with Polymarket domain knowledge + 6 few-shot examples from synthetic training data. Based on `plutus` (8B Q5_K_M, 5.7GB — fits 16GB RAM).
- **LLM confirmation default**: OFF (`btcUseLLMConfirmation: false`). Pure mechanical signal is faster with no Ollama dependency. Enable in Settings if Ollama is running.
- **Training data generator**: `npx tsx scripts/generate-training-data.ts --count 500` — produces ChatML JSONL with 1740+ training pairs (signal confirmations + direction predictions). Output: `polytrader-training-YYYY-MM-DD.jsonl`.
- **LLMInteractionStore**: Auto-captures every live LLM prompt→response→outcome triple to IndexedDB. Export from Settings → Training Data for fine-tuning.
- **TrainingDataExporter**: Exports ChatML JSONL from IndexedDB interactions or trade records. Supports Supabase backend for cross-device export.
- **Fine-tuning path**: MLX QLoRA (native Apple Silicon) → fuse → GGUF → `ollama create polytrader-v2`. Single command: `bash scripts/finetune.sh`. Uses `mlx-community/Meta-Llama-3.1-8B-Instruct-4bit` as base (~6-8GB peak RAM on 16GB Mac). Needs ~200+ resolved interactions for meaningful improvement.

## Bankroll Configuration ($20)

settingsStore v67 is tuned for a $20 bankroll with aggressive mode ON:
- **Trade sizes**: BTC $1.50, DualSide $1.50/leg, Gabagool $1.50 (~7.5% per trade)
- **Kelly fraction**: 0.15 (conservative quarter Kelly)
- **Risk limits**: $3/day loss, $6/week, $3 min balance floor, 15 trades/hr, 25% max drawdown
- **BTC-only focus**: ETH/SOL/XRP disabled, 1h + 4h windows only (5m/15m OFF)
- **Maker strategies only**: Gabagool, BTC Up/Down, DualSide (0% fees). Impulse + Liq Momentum OFF.
- **Cross-exchange confirmation**: Crypto.com price vs Binance, >0.15% divergence skips trade
- **LLM confirmation**: OFF by default (pure mechanical speed)

## Deployment

- **Netlify**: `netlify.toml` configured — build `npm ci && npm run build`, publish `dist/`, SPA redirect, API proxies
- **CI/CD**: `.github/workflows/` — runs tests + build on push/PR to main (Node 20)
