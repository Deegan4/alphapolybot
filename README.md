# AlphaPolyBot

A browser-based, AI-powered Polymarket trading bot built with TypeScript, React, and Vite. This project leverages LLMs for market analysis and supports multiple trading strategies, including LLM Prediction and Dip Arbitrage.

## Features
- LLM-powered market analysis (OpenRouter API)
- Multi-strategy trading (LLM Prediction, Dip Arbitrage)
- Real-time market data via WebSocket
- Matrix-inspired UI/UX
- Wallet integration (Polygon, USDC)
- Risk management and auto-exit
- Activity logging and analytics

## Getting Started

### Prerequisites
- Node.js 18+
- Yarn or npm

### Installation
```sh
npm install
# or
yarn install
```

### Development
```sh
npm run dev
# or
yarn dev
```

### Build
```sh
npm run build
# or
yarn build
```

### Environment Variables
- `VITE_OPENROUTER_API_KEY` (optional, can be set in Settings UI)

## Usage
1. Connect your Polygon wallet (seed phrase, testnet recommended).
2. Enter your OpenRouter API key in Settings.
3. Enable desired trading strategies in the Terminal.
4. Monitor trades, portfolio, and activity in real time.

## Documentation
- See `alphapolybot.md` for full architecture, strategy configs, and roadmap.

## Troubleshooting
- Ensure wallet is funded and on Polygon.
- Check API key validity.
- Use dry run mode for safe testing.

## License
MIT
