<div align="center">

# `> AlphaPolyBot_`

### Autonomous Polymarket Trading Engine

[![CI](https://github.com/Deegan4/alphapolybot/actions/workflows/ci.yml/badge.svg)](https://github.com/Deegan4/alphapolybot/actions)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.3-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![React](https://img.shields.io/badge/React-18-61DAFB?logo=react&logoColor=black)](https://reactjs.org/)
[![Vite](https://img.shields.io/badge/Vite-4-646CFF?logo=vite&logoColor=white)](https://vitejs.dev/)
[![Tests](https://img.shields.io/badge/tests-247_passing-00C853)](#testing)
[![License](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)

<br/>

*A browser-based trading bot that runs five independent strategies on [Polymarket](https://polymarket.com) prediction markets — from AI-powered LLM predictions to microstructure momentum and Frank-Wolfe optimized arbitrage.*

<br/>

```
 ╔══════════════════════════════════════════════════════════════╗
 ║  ░▒▓ ALPHA POLY BOT ▓▒░                                    ║
 ║                                                              ║
 ║  strategies: 5 ■■■■■░░░  positions: 3    P&L: +$12.47      ║
 ║  uptime: 4h 23m          risk: NOMINAL   mode: LIVE         ║
 ║                                                              ║
 ║  [LLM] scanning 847 markets...  confidence: 0.72  ████░     ║
 ║  [DIP] watching 12 tokens       last dip: -6.2%   ███░░     ║
 ║  [F-W] 3 arb candidates         spread: 1.8%      ██░░░     ║
 ║  [BTC] 5-factor signal           score: 0.46       ████░     ║
 ║  [MIC] flow toxicity: 0.23      imbalance: +0.31  ███░░     ║
 ╚══════════════════════════════════════════════════════════════╝
```

</div>

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        Browser (React 18)                       │
├──────────┬──────────┬──────────┬──────────┬────────────────────┤
│ Trading  │Portfolio │ Activity │ Settings │   Notifications    │
│ Terminal │   View   │   View   │   View   │   (Toast + Audio)  │
├──────────┴──────────┴──────────┴──────────┴────────────────────┤
│                      Zustand Stores                             │
│              settings (v7) · wallet · notifications             │
├─────────────────────────────────────────────────────────────────┤
│                     Strategy Manager                            │
│  ┌─────────┐ ┌─────────┐ ┌─────────┐ ┌───────┐ ┌───────────┐ │
│  │   LLM   │ │  Dip    │ │Frank-   │ │  BTC  │ │  Micro-   │ │
│  │Predict  │ │  Arb    │ │Wolfe Arb│ │Up/Down│ │  structure│ │
│  └────┬────┘ └────┬────┘ └────┬────┘ └───┬───┘ └─────┬─────┘ │
├───────┴───────────┴───────────┴───────────┴───────────┴───────┤
│                      Trading Service                           │
│  Kelly Sizer · Gas Oracle · Order Book Depth · Trade Logger    │
├─────────────────────────────────────────────────────────────────┤
│                      Risk Manager                               │
│  Circuit Breaker · Position Lifecycle · Correlation Tracking   │
├────────────────┬────────────────┬───────────────────────────────┤
│   CLOB Client  │  Gamma Client  │       Realtime Service       │
│  (order sign)  │  (market data) │  Market WS · User WS · RTDS │
├────────────────┴────────────────┴───────────────────────────────┤
│                    Polygon Network (Ethers.js)                  │
│           USDC.e · CTF Exchange · NegRisk Adapter               │
└─────────────────────────────────────────────────────────────────┘
```

## Strategies

| Strategy | Signal Source | Edge | Scan Frequency |
|:---------|:-------------|:-----|:---------------|
| **LLM Prediction** | OpenRouter AI analysis with calibration tracking and multi-model signal fusion | AI identifies mispriced markets | Adaptive (accelerates near close) |
| **Dip Arbitrage** | Real-time WebSocket price monitoring + periodic order book spread scan | Buys temporary dips on binary outcomes | 60s market refresh, 30s spread scan |
| **Frank-Wolfe Arb** | Bregman projection optimizer on CLOB order books with cross-market mutex validation | Exploits ask-sum < $1.00 across outcomes | 15s full scan |
| **BTC Up/Down** | 5-factor signal: momentum, velocity, time decay, value bet, order flow | Trades crypto direction markets | Per 15-min window |
| **Microstructure Momentum** | Bid/ask imbalance, spread volatility, trade flow toxicity | Exploits informed flow signals | Continuous |

## Risk Infrastructure

- **Circuit Breaker** — Daily loss limit, hourly trade cap, consecutive failure halt
- **Position Lifecycle Manager** — SL/TP enforcement via real-time price monitoring, partial exits (50% at TP, trail remainder), time-based exits, crash recovery from IndexedDB
- **Kelly Criterion Sizing** — Drawdown-adjusted fractional Kelly with high-water mark tracking
- **Gas Oracle** — Skips trades when Polygon gas exceeds 50% of expected profit
- **Order Book Depth** — Caps order size to available liquidity
- **Correlation Tracking** — Category-based exposure caps

## Quick Start

```bash
# Clone and install
git clone https://github.com/Deegan4/alphapolybot.git
cd alphapolybot
npm install

# Configure
cp .env.example .env
# Edit .env: add VITE_WALLET_SEED_PHRASE and VITE_OPENROUTER_API_KEY

# Run
npm run dev        # Dev server on :4000
```

### Setup Checklist

1. Create a **dedicated trading wallet** (not your main wallet!)
2. Fund it with **USDC.e + MATIC** on Polygon
3. Get an **OpenRouter API key** from [openrouter.ai/keys](https://openrouter.ai/keys)
4. In the app: **Settings > Wallet > Approve Tokens** (3 contracts)
5. Start in **dry run mode** — verify trades in the Activity tab
6. When confident, disable dry run for live trading

## Commands

```bash
npm run dev          # Vite dev server on :4000
npm run build        # Production build
npm test             # 247 tests (Vitest)
npm run test:watch   # Watch mode
npm run lint         # ESLint
npm run preview      # Preview production build
```

## Testing

247 tests across 10 suites covering all critical paths:

| Suite | Tests | Coverage |
|:------|------:|:---------|
| RiskManager | 31 | Circuit breaker, emergency stop, daily limits |
| PositionLifecycleManager | 25 | SL/TP enforcement, partial exits, crash recovery |
| KellySizer | 33 | Fractional Kelly, drawdown adjustment, edge cases |
| FrankWolfeOptimizer | 31 | Bregman projection, convergence, fee handling |
| ProjectFWStrategy | 17 | Scan lifecycle, trade execution, merge retry |
| DipArbStrategy | 21 | Dip detection, spread scan, merge retry |
| CrossMarket | 23 | Event analysis, dependency classification, mutex validation |
| OpenRouterService | 21 | Budget tracking, model selection, signal fusion |
| secureStorage | 19 | Encryption, key derivation, migration |
| settingsStore | 15 | Persistence, version migration, setter isolation |

## Tech Stack

| Layer | Technology |
|:------|:-----------|
| **Frontend** | React 18, TypeScript 5.3, Tailwind CSS |
| **Build** | Vite 4 (esbuild) |
| **State** | Zustand with persist middleware |
| **Blockchain** | Ethers.js v6 (Polygon) |
| **Charts** | Recharts |
| **LLM** | OpenRouter (multi-model) |
| **Storage** | IndexedDB (6 object stores) |
| **Real-time** | WebSocket (3 channels: market, user, RTDS) |
| **Testing** | Vitest + jsdom + Testing Library |
| **CI/CD** | GitHub Actions + Netlify |

## Project Structure

```
src/
├── components/         # Matrix-themed UI (18+ components)
│   ├── charts/         # Line, Area, Pie charts
│   ├── dashboard/      # DataTable, StatWidget, Timeline
│   ├── layout/         # AppLayout, Header, Sidebar, MatrixRain
│   └── ui/             # Button, Card, Modal, Toast, Toggle...
├── services/
│   ├── api/            # CLOBClient (order signing), GammaClient, DataClient
│   ├── llm/            # OpenRouter (budget-bucketed, multi-model)
│   ├── notifications/  # Toast + Browser + Web Audio
│   ├── realtime/       # Market WS, User Channel, RTDS crypto feed
│   ├── storage/        # IndexedDB v4 (6 stores)
│   ├── strategies/     # 5 strategies + Frank-Wolfe optimizer + cross-market
│   ├── trading/        # TradingService, RiskManager, PLM, Kelly, Gas, Depth
│   └── wallet/         # Ethers.js wrapper, approvals, balance tracking
├── stores/             # Zustand (settings v7, wallet, notifications)
├── views/              # Terminal, Portfolio, Activity, Settings
└── types/              # API types, wallet types
```

## Disclaimer

> This software is provided for **educational and research purposes only**. Trading on prediction markets involves significant financial risk. The authors are not responsible for any financial losses. Always use a dedicated wallet with funds you can afford to lose.

---

<div align="center">

Built with TypeScript, React, and too much coffee.

</div>
