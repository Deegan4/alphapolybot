# Technology Stack

**Analysis Date:** 2026-02-25

## Languages

**Primary:**
- TypeScript 5.2.0 - Full application codebase (React frontend + service layer)

**Secondary:**
- JavaScript (Node.js) - Build configuration (Vite, Tailwind, PostCSS configs)
- HTML/CSS - Index template and TailwindCSS styling

## Runtime

**Environment:**
- Node.js 20 (per netlify.toml)
- Browser (ES2020+, DOM APIs for IndexedDB, WebSocket, crypto.subtle)

**Package Manager:**
- npm
- Lockfile: `package-lock.json` present

## Frameworks

**Core:**
- React 18.2.0 - UI framework
- React Router DOM 6.16.0 - Client-side routing
- Vite 7.3.1 - Build tool and dev server with HMR

**Styling:**
- TailwindCSS 3.3.0 - Utility-first CSS
- PostCSS 8.4.0 - CSS transformation (autoprefixer integration)

**State Management:**
- Zustand 4.4.0 - Lightweight store with persistence middleware

**UI Components & Animation:**
- Framer Motion 11.18.2 - Animation and transitions
- React Resizable Panels 4.6.5 - Resizable layout components
- Recharts 3.7.0 - Data visualization and charting

**Testing:**
- Vitest 4.0.18 - Unit test runner (Vite-native)
- @testing-library/react 16.3.2 - React component testing utilities
- @testing-library/jest-dom 6.9.1 - DOM matchers

**Build/Dev:**
- @vitejs/plugin-react 5.1.4 - React fast refresh plugin
- TypeScript 5.2.0 - Type checking

**Code Quality:**
- ESLint 9.x - Linting
- @typescript-eslint/eslint-plugin 7.x - TypeScript linting rules
- @typescript-eslint/parser 7.x - TypeScript parser for ESLint
- eslint-plugin-react-hooks 4.6.0 - React hooks best practices
- eslint-plugin-react-refresh 0.4.0 - Fast refresh validation

## Key Dependencies

**Critical:**
- axios 1.5.0 - HTTP client for API requests (with rate limiting and retry logic)
- ethers 6.7.0 - Ethereum wallet operations, HMAC signing, HD wallet derivation
- tweetnacl 1.0.3 - Cryptographic signing for wallet credentials
- idb 8.0.3 - Promise-based IndexedDB wrapper for persistent storage
- clsx 2.0.0 - Conditional className utility
- tailwind-merge 1.14.0 - Merge TailwindCSS class conflicts

**Infrastructure:**
- @coinbase/cdp-sdk 1.44.1 - Coinbase Advanced Trade API integration (if used)
- @coinbase/onchainkit 1.1.2 - On-chain kit (may be unused in current codebase)

## Configuration

**Environment Variables:**
- `VITE_OPENROUTER_API_KEY` - OpenRouter LLM API key (sk-or-v1-*)
- Wallet seed phrase/private key: Must never be stored in env files or source control. Use browser secure storage, hardware wallets, or KMS. Never expose secrets via VITE_ env vars.
- `VITE_BINANCE_API_URL` - Binance REST API endpoint (default: https://api.binance.com/api/v3)
- `VITE_BINANCE_WS_URL` - Binance WebSocket endpoint (default: wss://stream.binance.com:9443)
- `VITE_COINGECKO_API_URL` - CoinGecko API endpoint (default: https://api.coingecko.com/api/v3)
- `VITE_OPENROUTER_BASE_URL` - OpenRouter API base URL (default: https://openrouter.ai/api/v1)
- `VITE_POLYBACKTEST_API_KEY` - PolyBacktest API key (optional, can be set in UI)
- `VITE_DATA_API_URL` - Data API URL (Polymarket positions/trades)
- `VITE_APP_VERSION` - Application version string
- `VITE_ENVIRONMENT` - Environment name (development/production)
- `VITE_DEBUG_MODE` - Enable debug logging
- `VITE_STRICT_CSP_DEV` - Strict Content Security Policy for dev (disables React HMR injection)

**Build Configuration:**
- `tsconfig.json` - TypeScript compiler options (target: ES2020, strict mode enabled)
- `tsconfig.node.json` - TypeScript config for Vite config file
- `vite.config.ts` - Vite build configuration with custom Binance WS proxy plugin
- `.eslintrc.cjs` - ESLint rules and parser configuration
- `postcss.config.js` - PostCSS configuration for TailwindCSS autoprefixer
- `tailwind.config.js` - TailwindCSS theme and plugin configuration

**Dev Server:**
- Port: 4000
- Host: 0.0.0.0 (accessible from network)
- Auto-open browser on start
- WebSocket proxy for Binance streams
- HTTP API proxies for CLOB, Gamma, CoinGecko, PolyBacktest, Coinbase, Polygon RPC

## Platform Requirements

**Development:**
- Node.js 20+
- npm or compatible package manager
- Modern browser with:
  - ES2020 support
  - IndexedDB support
  - WebSocket support
  - Web Crypto API (for HMAC-SHA256 signing)

**Production:**
- Netlify (deployed via netlify.toml)
- Browser support: ES2020+ (Chrome 80+, Firefox 75+, Safari 14+)
- Environment variables must be configured in Netlify dashboard

## Build Process

**Development:**
```bash
npm run dev              # Start Vite dev server with HMR on port 4000
npm run dev:strict-csp  # Dev mode with strict CSP (no React HMR injection)
npm run build           # Production build with sourcemaps to dist/
npm run lint            # ESLint check (zero warnings tolerated; see package.json TODO for remediation plan)
npm run preview         # Preview production build locally
npm run test            # Run Vitest once
npm run test:watch      # Watch mode for tests
```

**Production Build:**
- Output: `dist/` directory
- Sourcemaps: enabled for debugging
- Code splitting:
  - `vendor-ethers.js` - ethers.js library (~450KB)
  - `vendor-d3.js` - D3 visualization libraries
  - `vendor-charts.js` - Recharts + supporting libs
  - `vendor-motion.js` - Framer Motion animation library
  - `vendor-react.js` - React DOM + scheduler
  - Main bundle - Application code

**Deployment:**
- Command: `npm ci && npm run build`
- Publish directory: `dist/`
- Node version: 20
- Netlify redirects configured for SPA routing and API proxying

---

*Stack analysis: 2026-02-25*
