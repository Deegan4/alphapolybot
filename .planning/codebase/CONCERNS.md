# Codebase Concerns

**Analysis Date:** 2026-02-25

## Tech Debt

### 1. Oversized Store File

**Area:** State Management
- Issue: `src/stores/settingsStore.ts` is 1,164 lines (130+ setter functions) for a single Zustand store. This monolithic approach makes the file difficult to navigate and maintain.
- Files: `src/stores/settingsStore.ts`
- Impact: Hard to locate specific settings, increased cognitive load for modifications, slow IDE responsiveness when editing, merge conflicts likely
- Fix approach: Split into logical domain stores (trading, risk, wallet, strategies, llm, alerts, api). Create index.ts barrel export for backward compatibility. Example structure: `settingsStore/tradingStore.ts`, `settingsStore/riskStore.ts`, etc.

### 2. Type Safety Gaps in Views

**Area:** TypeScript Type Safety
- Issue: `src/views/SettingsView.tsx` contains unchecked `any` type cast at line 2324: `const prices = activeMarkets.map((m: any) => m.lastTradePrice || m.outcomePrices?.[0] || 0)`. This bypasses TypeScript type checking for market data structure.
- Files: `src/views/SettingsView.tsx:2324`
- Impact: Silent bugs if market API response structure changes, no IDE autocomplete for market fields, hard to track data flow
- Fix approach: Create proper `Market` interface with `lastTradePrice` and `outcomePrices` fields. Replace cast with type guard or validation function. Import from `@/types`.

### 3. Component Props Passthrough Without Type Safety

**Area:** UI Components
- Issue: `src/components/ui/MatrixButton.tsx` line 73-74 uses `eslint-disable-next-line` to suppress TypeScript error when spreading unknown framer-motion props: `{...(props as any)}`. This is a direct type safety bypass.
- Files: `src/components/ui/MatrixButton.tsx:73-74`
- Impact: Framer-motion breaking changes will be missed, runtime errors possible when props don't match framer-motion API
- Fix approach: Extract validated framer-motion props explicitly, create a typing interface for motion component variations, avoid spreads with unknown props.

### 4. Dynamic Imports Without Error Boundary

**Area:** Service Loading
- Issue: Multiple locations use `.catch(() => {})` to silently swallow errors from dynamic imports:
  - `src/App.tsx:96, 108, 156` (RTDS, Binance WS, UserChannel)
  - `src/services/trading/RiskManager.ts:376-387` (StrategyManager, GtcOrderManager)
  - These are critical services whose failure is hidden from user and logs
- Files: `src/App.tsx`, `src/services/trading/RiskManager.ts`
- Impact: Silent service initialization failures (e.g., WebSocket disconnection goes unnoticed), users unaware of degraded functionality, difficult to diagnose issues
- Fix approach: Log all dynamic import failures with activityLogger. Implement service health monitoring. Set a flag if critical services fail (e.g., `realtimeServiceReady`). Display warning badge if services are unavailable.

### 5. Memory Leak Risk: Uncleared Intervals

**Area:** Resource Management
- Issue: `src/App.tsx:113-117` sets a 6-hour interval for pruning but never clears it on unmount:
  ```typescript
  setInterval(() => { ... }, PRUNE_INTERVAL_MS)
  ```
  This interval will fire indefinitely even if the component unmounts (which is rare for App but bad pattern).
- Files: `src/App.tsx:113-117`
- Impact: Memory waste from interval continuing to run if App ever unmounts (edge cases: error boundaries, testing), multiple intervals on hot reload during dev
- Fix approach: Store interval ID and clear in cleanup: `const intervalId = setInterval(...); return () => clearInterval(intervalId)`.

### 6. Observer Unsubscription Incompleteness

**Area:** Event Subscriptions
- Issue: `RiskManager.ts` initializes an unsubscriber for activity logger at line 84, but if `initialize()` is never called, the subscription is never set up. Additionally, no cleanup on service destruction.
- Files: `src/services/trading/RiskManager.ts:84, 123-133`
- Impact: If RiskManager is instantiated but not initialized (edge case), there's no cleanup path. Possible listener leaks in tests or during strategy hot-reloading.
- Fix approach: Add explicit `cleanup()` method that clears unsubscriber. Call from StrategyManager cleanup. Consider making initialization auto-run in constructor as fallback.

## Known Bugs

### 1. Static Salt Reduces Encryption Security

**Area:** Cryptography
- Symptoms: API keys encrypted in localStorage can be decrypted if attacker has code (salt is visible in source)
- Files: `src/utils/secureStorage.ts:15` - `const SALT = 'alphapolybot-v2-salt'`
- Trigger: Any inspection of localStorage keys and values combined with access to source code
- Workaround: Use PBKDF2 with user-provided passphrase (already implemented), but static salt is a cryptographic weakness. Encryption is best-effort obfuscation, not true security.
- Impact: Low - The system already acknowledges localStorage is not HSM-level security, and AES-GCM with 100k PBKDF2 iterations is strong. But static salt should be documented as limitation.

### 2. Legacy XOR Migration Path Has No Version Tracking

**Area:** Storage Migration
- Symptoms: Encrypted values from v1 (XOR) are transparently migrated to v2 (AES-GCM), but no version bump on storage. If user downgrades, they'll read new AES-GCM format as XOR and crash.
- Files: `src/utils/secureStorage.ts:108-119`
- Trigger: User downgrades app version after migration has occurred
- Workaround: None - downgrading will fail
- Impact: Medium - Users who downgrade after migration cannot recover their data without manual localStorage cleanup

### 3. Inconsistent Error Handling in Market Analysis

**Area:** LLM Service
- Symptoms: `OpenRouterService.ts` catches and silently logs many LLM failures (line 159, 216, 330, 367) but doesn't always propagate to strategies. Some strategies retry, some don't.
- Files: `src/services/llm/OpenRouterService.ts:159, 216, 330, 367`
- Trigger: LLM API call fails or times out
- Workaround: Enable debug mode to see console warnings
- Impact: Medium - Strategies may miss signals if LLM fails, no visibility to user unless they check console

## Security Considerations

### 1. Plaintext Credentials in SettingsView

**Area:** Credential Storage UI
- Risk: Credentials (OpenRouter API key, Tavily key, Coinbase API key) are read from localStorage without decryption in SettingsView for display purposes at lines 1618-1620. While not written in plaintext, they're read from localStorage directly.
- Files: `src/views/SettingsView.tsx:1618-1620`
- Current mitigation: Browser DevTools needed to access localStorage; encryption is optional. Users must manually enable encryption passphrase.
- Recommendations:
  - Auto-encrypt all API keys with user password on first setup
  - Mask displayed credentials (show only last 4 chars)
  - Add warning if credentials are not encrypted
  - Clear from memory after render (use secure-clear-on-unmount pattern)

### 2. Window Location Manipulation Without Validation

**Area:** Navigation
- Risk: Multiple components directly manipulate `window.location.pathname` without validation:
  - `src/components/dashboard/DiagnosticsBanner.tsx:118, 131, 146, 186`
  - No guard against XSS or malformed paths
- Files: `src/components/dashboard/DiagnosticsBanner.tsx:118, 131, 146, 186`, `src/ErrorBoundary.tsx:42`
- Current mitigation: Paths are hardcoded in component, not user input
- Recommendations: Use React Router's `useNavigate()` instead of direct window.location assignment. Create a navigation helper function. Avoid window.location.reload() - use error boundary recovery instead.

### 3. Wallet Seed Phrase in Environment Variable

**Area:** Wallet Management
- Risk: `VITE_WALLET_SEED_PHRASE` and private keys are stored in `.env` file. If checked into git (even as .env.local), they're exposed.
- Files: `src/App.tsx:123`
- Current mitigation: `.env` is in `.gitignore`, but users can accidentally commit `.env.local`
- Recommendations:
  - Add pre-commit hook to prevent .env* commits
  - Document that wallet credentials should NEVER be committed
  - Consider browser wallet (MetaMask) integration instead of storing seeds
  - Add warning if VITE_WALLET_SEED_PHRASE contains obvious test phrase

## Performance Bottlenecks

### 1. Large Strategy Files Cause Long Parse Times

**Area:** Bundle & Startup
- Problem: `BtcUpDownStrategy.ts` is 1,594 lines; `CLOBClient.ts` is 1,278 lines. These are imported eagerly in StrategyManager, increasing Time-to-Interactive.
- Files: `src/services/strategies/BtcUpDownStrategy.ts` (1,594 lines), `src/services/api/CLOBClient.ts` (1,278 lines)
- Cause: Strategies contain both logic and extensive comments; no code splitting
- Improvement path:
  - Lazy-load strategy implementations (already partially done with React.lazy in views, but services are eager)
  - Extract pure computation functions (signal engine) into separate, reusable files
  - Use dynamic import() in StrategyManager.register() instead of top-level imports

### 2. SettingsStore Persistence on Every Change

**Area:** State Management
- Problem: Each setter in `settingsStore.ts` triggers Zustand's persist middleware, which serializes the entire 1,164-line store and writes to localStorage. With 130+ setters, rapid UI changes cause many localStorage writes.
- Files: `src/stores/settingsStore.ts`
- Cause: Zustand persist middleware doesn't batch or debounce writes
- Improvement path:
  - Add debounce middleware (e.g., 500ms) before persist
  - Use selective persistence (only persist changed fields)
  - Consider splitting settings into frequently-changed (in-memory) and infrequent (persisted)

### 3. IndexedDB Queries Without Indexes

**Area:** Storage
- Problem: `IndexedDBService.ts` (642 lines) performs range queries and filters in JavaScript instead of using database indexes.
- Files: `src/services/storage/IndexedDBService.ts`
- Cause: Lazy indexing strategy; IDB supports indexes but they're not being leveraged
- Improvement path:
  - Audit all query patterns in IndexedDBService
  - Add IDB indexes for common queries (timestamp, status, type)
  - Benchmark query performance before/after

## Fragile Areas

### 1. Position Lifecycle Manager Depends on Polling + WebSocket Race

**Area:** Position Tracking
- Files: `src/services/trading/PositionLifecycleManager.ts` (1,074 lines)
- Why fragile:
  - Tracks positions using both polling (REST API) and WebSocket (UserChannel)
  - If WebSocket is slow to connect, polling may fetch stale data
  - Merge of polling + WS data can have race conditions (which source is authoritative?)
  - Stop-loss/take-profit enforcement depends on real-time updates; missing an update = missed exit
- Safe modification:
  - Add tests that simulate WebSocket lag (e.g., 5s delay before update)
  - Make polling fallback explicit (use it only if WS not connected for >30s)
  - Add "data source" tag to each position update (polling vs WS)
- Test coverage: Gaps in race condition scenarios

### 2. CLOB Order Signing + Execution Tight Coupling

**Area:** Trading Execution
- Files: `src/services/api/CLOBClient.ts` (1,278 lines), `mcp-server/src/auth/order-signer.ts`
- Why fragile:
  - Orders are signed in one function, executed in another
  - No validation that signed order matches execution parameters
  - If signing and execution are called with different nonces or amounts, trades can fail silently
- Safe modification:
  - Enforce immutability of order object between signing and execution
  - Create a `SignedOrder` type that can't be modified post-signature
  - Add round-trip validation (verify signed order matches execution request)
- Test coverage: No tests for signature tampering scenarios

### 3. Strategy Manager State Machine Not Explicit

**Area:** Strategy Lifecycle
- Files: `src/services/strategies/StrategyManager.ts`, `src/services/strategies/BaseStrategy.ts`
- Why fragile:
  - Strategies transition between enabled/disabled/running/stopped states
  - No explicit state machine; state tracked as boolean flags in multiple places
  - Calling enable() twice, or stop() while already stopped, has undefined behavior
- Safe modification:
  - Create explicit state machine using enums: `DISABLED | ENABLED | RUNNING | STOPPING | ERROR`
  - Add validation for each state transition
  - Log all state changes with timestamps
- Test coverage: Missing state transition tests (calling methods in wrong order)

## Scaling Limits

### 1. ActivityLogger In-Memory Array Unbounded Growth

**Area:** Logging & Performance
- Current capacity: 500 activities max in memory, older ones discarded
- Limit: If persistence to IndexedDB fails repeatedly (e.g., storage full), new activities still push old ones out of memory. If user has 10+ strategies running for hours, they'll lose activity history.
- Scaling path:
  - Increase max from 500 to 5,000 (use LRU cache library)
  - Implement better cleanup: move old activities to IndexedDB batches
  - Add metrics for activity buffer usage

### 2. Market Exposure Maps Grow Without Bounds

**Area:** Risk Management
- Current capacity: `marketExposure` and `categoryExposure` Maps in RiskManager store entries for every trade made. No cleanup.
- Limit: If user trades 10 different markets per day, after 1 month the maps contain ~300 entries. Not a crash, but memory usage grows linearly with trade volume.
- Scaling path:
  - Implement expiry on exposure entries (clear after 24h if no new activity)
  - Add prune() method called during app's auto-prune cycle
  - Monitor Map size and warn if it exceeds 10k entries

### 3. WebSocket Feed Cannot Scale to 50+ Markets

**Area:** Real-Time Data
- Current capacity: RTDS + Binance WS can subscribe to ~10-15 markets concurrently before frame rate issues
- Limit: Dip Arbitrage and ProjectFW scale beyond this; if user enables both with full market set, message processing falls behind
- Scaling path:
  - Implement frame bundling (coalesce rapid updates into 100ms batches)
  - Use Web Worker for message parsing (off main thread)
  - Implement market sampling (only track top N by volume if count exceeds threshold)

## Dependencies at Risk

### 1. Ethers.js Major Version Bump

**Area:** External Library
- Risk: `package.json` pins `ethers` at `^6.7.0`. Ethers 7.x will have breaking changes (e.g., Contract API changes, removed deprecated methods).
- Impact: All contract interaction code in `src/services/api/CLOBClient.ts` will need updates
- Migration plan:
  - Monitor ethers.js releases
  - Create feature branch for v7 migration after it stabilizes (6 months post-release)
  - Update CLOBClient and tests in parallel
  - Use ethers v6 compat flag during transition

### 2. React Router 6.x Pinned; Major Upgrade Looming

**Area:** External Library
- Risk: `react-router-dom@^6.16.0` is pinned but v7 is already released with new useNavigate() and data API changes
- Impact: Upgrade necessary for security patches; routing logic in `src/App.tsx` and layout components will need refactoring
- Migration plan:
  - Test v7 in staging environment
  - Replace direct window.location manipulation with useNavigate()
  - Update route guard patterns

## Missing Critical Features

### 1. Multi-Chain Support Absent

**Area:** Blockchain Integration
- Problem: System is hardcoded for Polygon (MATIC for gas, CLOB on Polygon). No abstraction for alternate chains.
- Blocks: Cannot support Ethereum mainnet, Arbitrum, or other chains where Polymarket might expand
- Implementation needed:
  - Create `ChainConfig` interface with RPC, CLOB address, fee token, etc.
  - Make CLOBClient, TradingService, and WalletStore chain-aware
  - Add chain selector UI in Settings

### 2. Order Cancellation Confirmation Missing

**Area:** Trading Safety
- Problem: GtcOrderManager cancels GTD orders without confirmation. If user accidentally clicks "cancel all", all pending limit orders are wiped.
- Blocks: User protection; data loss possible
- Implementation needed:
  - Add modal confirm before cancelAll()
  - Show list of orders being cancelled
  - Add undo capability (cache cancelled orders for 30s)

### 3. Backtest Results Not Persistent

**Area:** Analytics
- Problem: Backtest results are calculated in memory and discarded on page reload. No export/comparison of runs over time.
- Blocks: Cannot iterate on strategy parameters and compare results
- Implementation needed:
  - Store backtest runs in IndexedDB with timestamp, parameters, result metrics
  - Add backtest history view
  - Export to CSV

## Test Coverage Gaps

### 1. WebSocket Reconnection Logic

**Area:** Real-Time Connectivity
- What's not tested:
  - Rapid disconnect/reconnect cycles
  - Message loss during reconnection
  - Subscription state consistency after reconnect
- Files: `src/services/realtime/`, `src/services/strategies/DipArbStrategy.ts` (consumes WS)
- Risk: WebSocket bugs only appear under network stress; users experience silent data loss
- Priority: **High** - DipArb strategy depends entirely on WebSocket feed

### 2. Race Conditions in Position Merging

**Area:** Trading Mechanics
- What's not tested:
  - Two merge operations on same position simultaneously
  - Merge while position is being closed
  - Merge with conflicting merge requests from different strategies
- Files: `src/services/trading/MergeService.ts`, `src/services/trading/__tests__/MergeService.test.ts`
- Risk: Duplicate merges or lost position data if concurrent merges occur
- Priority: **High** - Merge is critical for capital efficiency

### 3. LLM Service Circuit Breaker Boundary

**Area:** LLM Integration
- What's not tested:
  - Budget exhaustion edge case (last call uses remaining budget)
  - Recovery after circuit breaker timeout
  - Concurrent requests during cooldown
- Files: `src/services/llm/OpenRouterService.ts`, no dedicated boundary tests
- Risk: Unclear behavior when budget = $0; strategies may hang waiting for LLM response
- Priority: **Medium** - Graceful degradation when LLM unavailable

### 4. Risk Manager Circuit Breaker Reset Workflow

**Area:** Risk Management
- What's not tested:
  - User manually resets circuit breaker while trades are in-flight
  - Reset triggered while new trades are being validated
  - State consistency after reset
- Files: `src/services/trading/RiskManager.ts`, `src/services/trading/__tests__/RiskManager.test.ts`
- Risk: If reset happens mid-trade, risk limits may be bypassed
- Priority: **Medium** - UI must prevent reset during active trades

### 5. Strategy Manager Hot Reload Lifecycle

**Area:** Development/Testing
- What's not tested:
  - Rapid enable/disable cycles on same strategy
  - Memory cleanup after strategy stop (listeners, subscriptions)
  - Multiple instances of same strategy
- Files: `src/services/strategies/StrategyManager.ts`
- Risk: Tests pass but hot-reload in dev causes leaks; strategy runs twice in production if manager isn't properly reset
- Priority: **Medium** - Affects developer experience and potential prod bugs

---

*Concerns audit: 2026-02-25*
