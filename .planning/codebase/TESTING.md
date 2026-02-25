# Testing Patterns

**Analysis Date:** 2026-02-25

## Test Framework

**Runner:**
- Vitest v4.0.18
- Config: `vitest.config.ts` (root), `mcp-server/vitest.config.ts` (MCP server tests)

**Environment:**
- jsdom (DOM simulation for browser tests)
- Global test functions enabled: `globals: true`

**Assertion Library:**
- Vitest built-in (chai-based assertions)
- Methods: `expect()`, `toBe()`, `toEqual()`, `toContain()`, `toMatch()`, etc.

**Run Commands:**
```bash
npm run test              # Run all tests once (vitest run)
npm run test:watch       # Watch mode (vitest)
npm run lint             # ESLint with TypeScript (65 warnings max)
```

## Test File Organization

**Location:**
- Co-located with source: `__tests__` subdirectory in same folder
- Frontend: `src/stores/__tests__/`, `src/utils/__tests__/`, `src/services/**/__tests__/`
- Backend: `mcp-server/__tests__/`

**Naming:**
- Convention: `[module].test.ts` for unit tests
- Example: `settingsStore.ts` → `__tests__/settingsStore.test.ts`

**Structure:**
```
src/
├── stores/
│   ├── settingsStore.ts
│   └── __tests__/
│       └── settingsStore.test.ts
├── utils/
│   ├── secureStorage.ts
│   └── __tests__/
│       └── secureStorage.test.ts
├── services/
│   └── trading/
│       ├── RiskManager.ts
│       ├── ActivityLogger.ts
│       └── __tests__/
│           ├── RiskManager.test.ts
│           └── ActivityLogger.test.ts
```

## Test Structure

**Suite Organization:**

Test files use `describe()` for logical grouping, `it()` for individual test cases:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest'

describe('ModuleName', () => {
  beforeEach(() => {
    // Setup before each test
  })

  describe('feature or method name', () => {
    it('should do X when condition Y', () => {
      expect(result).toBe(expected)
    })

    it('should handle edge case Z', () => {
      expect(result).toBeNull()
    })
  })
})
```

**Patterns Observed:**

1. **Setup/Teardown:**
   - `beforeEach()`: Reset state, instantiate fresh objects, clear mocks
   - `afterEach()`: Cleanup (localStorage clear, timer reset)
   - No top-level test state — each test starts fresh

2. **Describe Blocks:**
   - Top level: class or module name
   - Nested levels: group by feature, method, or scenario
   - Example from `secureStorage.test.ts`:
     - `describe('SecureStorage', ...)`
     - `describe('unencrypted storage', ...)`
     - `describe('initialization', ...)`
     - `describe('AES-GCM encrypted storage', ...)`

3. **Test Naming:**
   - Descriptive, starts with "should" or "is": `it('stores and retrieves a string', ...)`
   - Include edge case explanation: `it('fails to decrypt with wrong passphrase', ...)`
   - Assertions are obvious from test name (no need to read function body)

**Example from `settingsStore.test.ts`:**
```typescript
describe('settingsStore', () => {
  beforeEach(() => {
    useSettingsStore.getState().resetSettings()
  })

  describe('default values', () => {
    it('starts in dry run mode', () => {
      expect(useSettingsStore.getState().dryRun).toBe(true)
    })
  })

  describe('setters (no side effects)', () => {
    it('setDryRun updates state', () => {
      useSettingsStore.getState().setDryRun(false)
      expect(useSettingsStore.getState().dryRun).toBe(false)
    })
  })
})
```

## Mocking

**Framework:** Vitest's `vi` module (similar to jest.mock)

**Key Functions:**
- `vi.mock(modulePath, factory)`: Replace entire module with mock implementation
- `vi.hoisted(factory)`: Create variables available inside mock factories (hoisted above imports)
- `vi.fn()`: Create spy/mock function
- `vi.useFakeTimers()` / `vi.useRealTimers()`: Control time in tests
- `vi.advanceTimersByTime()`: Fast-forward time

**Patterns:**

1. **Mocking Zustand Stores:**
   ```typescript
   const { mockWalletState, mockSettingsState } = vi.hoisted(() => ({
     mockWalletState: { balance: 100, buyingPower: 100 },
     mockSettingsState: { dryRun: true, ... },
   }))

   vi.mock('@/stores/walletStore', () => ({
     useWalletStore: {
       getState: () => mockWalletState,
     },
   }))
   ```
   - Stores are mocked at module level (hoisted)
   - `getState()` returns mutable mock object
   - Tests can toggle properties between test cases

2. **Mocking Side Effect Modules:**
   ```typescript
   vi.mock('@/services/trading/RiskManager', () => ({
     riskManager: { setConfig: vi.fn() },
   }))
   ```
   - Services that trigger dynamic imports wrapped in mocks to prevent "Closing rpc" errors
   - Fire-and-forget operations mocked to prevent async module resolution timeouts

3. **Mocking localStorage:**
   ```typescript
   const store: Record<string, string> = {}
   const localStorageProxy = new Proxy(store, {
     get(target, prop: string) {
       if (prop === 'getItem') return (key: string) => key in target ? target[key] : null
       if (prop === 'setItem') return (key: string, val: string) => { target[key] = val }
       // ...
     },
   })
   Object.defineProperty(globalThis, 'localStorage', {
     value: localStorageProxy,
     writable: true,
     configurable: true,
   })
   ```
   - jsdom localStorage doesn't fully satisfy Zustand's StateStorage interface
   - Custom Proxy mock ensures `Object.keys(localStorage)` works (used in expiry cleanup)

**What to Mock:**
- External services (API clients, wallet services, trading services)
- Side effect modules that trigger cascading imports (RiskManager, TradingService)
- Store instances (Zustand stores via `getState()`)
- Time-dependent operations (when testing expiry, timers, etc.)

**What NOT to Mock:**
- DOM APIs (jsdom provides these)
- Simple utility functions (cn(), encryption helpers) — test them directly
- Assertions and test helpers
- The module under test (test the real implementation)

## Fixtures and Factories

**Test Data:**

Test files create simple mock objects inline rather than using factories:

```typescript
// From secureStorage.test.ts
const testSecret = Buffer.from('test-secret-key-1234567890', 'utf8').toString('base64')

// From settingsStore.test.ts
const mockSettingsState = {
  dailyLossLimit: 4,
  weeklyLossLimit: 20,
  maxTradesPerHour: 20,
  // ...
}

// From auth.test.ts
const body = JSON.stringify({ orderID: 'abc-123' })
```

**Location:**
- Inline at test file top (hoisted if used in mocks)
- No separate fixtures directory (data is test-specific, reuse minimal)
- Setup via `beforeEach()` for test isolation

## Coverage

**Requirements:** Not enforced (no coverage thresholds in vitest config)

**View Coverage:**
```bash
# No explicit coverage command in package.json
# Can run manually with: vitest run --coverage
```

**Current State:**
- No `.nycrc` or coverage config detected
- Tests written for critical paths (stores, services, utils)
- Focus on behavior verification, not coverage percentage

## Test Types

**Unit Tests:**
- **Scope:** Individual functions, methods, small components
- **Approach:** Mock all dependencies, test in isolation
- **Examples:**
  - `settingsStore.test.ts`: Store state mutations and reset logic
  - `secureStorage.test.ts`: Encryption roundtrips, expiry behavior
  - `auth.test.ts`: Signature generation with different inputs
  - `RiskManager.test.ts`: Trade validation, failure limits, emergency stops

**Integration Tests:**
- **Scope:** Multiple components interacting
- **Approach:** Mock external services (APIs, storage), use real store logic
- **Examples:**
  - `PositionLifecycleManager.test.ts`: Position state machine with order updates
  - `OrderStateMachine.test.ts`: State transitions across cancel/fill events
  - Strategy tests: Configuration changes propagate to risk manager

**E2E Tests:**
- **Status:** Not present in codebase
- **Frameworks available but unused:** Playwright (detected in `.playwright-mcp/`), but no test files
- **Future:** E2E could test trading flow (connect wallet, place order, monitor position)

## Common Patterns

**Async Testing:**

Vitest handles async tests naturally:

```typescript
it('stores and retrieves encrypted value', async () => {
  await storage.initialize('passphrase')
  await storage.set('key', 'value', { encrypt: true })
  const result = await storage.get<string>('key', true)
  expect(result).toBe('value')
})
```

- `async` in test function signature
- `await` all async operations
- No `.then()` chaining needed (prefer async/await)

**Error Testing:**

Tests verify error conditions and recovery:

```typescript
it('fails to decrypt with wrong passphrase', async () => {
  await storage.set('secret', 'sensitive-data', { encrypt: true })

  const otherStorage = new SecureStorage()
  await otherStorage.initialize('wrong-passphrase')

  const result = await otherStorage.get<string>('secret', true)
  expect(result).toBeNull()  // Decryption fails gracefully
})

it('fails on tampered ciphertext', async () => {
  await storage.set('secret', 'sensitive-data', { encrypt: true })
  const raw = store['alphapolybot_secret']!
  const tampered = raw.slice(0, -4) + 'XXXX'
  store['alphapolybot_secret'] = tampered

  const result = await storage.get<string>('secret', true)
  expect(result).toBeNull()  // Tamper detection works
})
```

**Timer Testing:**

Use fake timers for expiry and timeout logic:

```typescript
it('respects expiry', async () => {
  vi.useFakeTimers()
  await storage.set('temp', 'value', { expiry: 1000 })

  const fresh = await storage.get<string>('temp')
  expect(fresh).toBe('value')

  vi.advanceTimersByTime(1500)
  const expired = await storage.get<string>('temp')
  expect(expired).toBeNull()

  vi.useRealTimers()
})
```

**State Assertion Pattern (Zustand):**

Tests access store state via `getState()` (synchronous, always current):

```typescript
useSettingsStore.getState().setDryRun(false)
expect(useSettingsStore.getState().dryRun).toBe(false)  // No await needed
```

**Determinism Testing:**

Verify crypto operations produce consistent output:

```typescript
it('is deterministic — same inputs produce same output', () => {
  const sig1 = buildPolyHmacSignature(testSecret, 1700000000, 'GET', '/orders')
  const sig2 = buildPolyHmacSignature(testSecret, 1700000000, 'GET', '/orders')
  expect(sig1).toBe(sig2)
})
```

**Conditional Tests:**

Skip tests when environment lacks required features:

```typescript
it.skipIf(!hasWebCrypto)('initializes with encryption key', async () => {
  await storage.initialize('test-passphrase')
  expect(storage.isEncryptionReady).toBe(true)
})
```

## Test Isolation and Cleanup

**Module-level Mocks:**
- `vi.mock()` calls are hoisted above imports, applied globally to test
- Reset state in `beforeEach()` to avoid test pollution
- Example: `mockSettingsState.pennyTraderMode = false` before each test

**Store Reset:**
```typescript
beforeEach(() => {
  useSettingsStore.getState().resetSettings()
})
```
- Zustand tests call `resetSettings()` to restore defaults between tests
- Prevents state from test N affecting test N+1

**Storage Cleanup:**
```typescript
function clearStore() {
  for (const k of Object.keys(store)) delete store[k]
}

beforeEach(() => {
  storage = new SecureStorage()
  clearStore()
})

afterEach(() => {
  clearStore()
})
```

**Timer Cleanup:**
Always restore real timers after fake timer tests:
```typescript
vi.useFakeTimers()
// ... test code
vi.useRealTimers()
```

---

*Testing analysis: 2026-02-25*
