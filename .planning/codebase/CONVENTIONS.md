# Coding Conventions

**Analysis Date:** 2026-02-25

## Naming Patterns

**Files:**
- Components: PascalCase with .tsx extension (e.g., `DashboardView.tsx`, `MatrixLoading.tsx`)
- Utilities/helpers: camelCase with .ts extension (e.g., `secureStorage.ts`, `cn.ts`)
- Stores: camelCase ending in "Store" (e.g., `settingsStore.ts`, `walletStore.ts`)
- Services: PascalCase class files, camelCase singleton exports (e.g., `RiskManager.ts` exports `riskManager`)
- Test files: Co-located in `__tests__` directories with `.test.ts` or `.test.tsx` suffix
- Config files: lowercase or kebab-case (`.eslintrc.cjs`, `tsconfig.json`, `vitest.config.ts`)

**Functions:**
- Event handlers: camelCase, often prefixed with `handle` (e.g., `handleClick`, `handleTradeResult`)
- Utility functions: camelCase, descriptive names (e.g., `buildPolyHmacSignature`, `recordTradeAttempt`)
- Async operations: camelCase, verbs describe action (e.g., `initialize`, `loadFromStorage`)
- Private class methods: leading underscore (e.g., `_emergencyStopped`)
- Setters: `set` prefix followed by property name (e.g., `setDryRun`, `setOpenRouterApiKey`, `setAggressiveMode`)

**Variables:**
- State properties: camelCase, descriptive (e.g., `dailyLossLimit`, `emergencyReason`, `openRouterApiKey`)
- Constants: UPPER_SNAKE_CASE with `const` (e.g., `STORAGE_PREFIX`, `DEFAULT_CONFIG`, `SALT`)
- Unused parameters: leading underscore to suppress linting warnings (e.g., `(_error: unknown)`)
- Zustand store state: camelCase interface properties matching store structure

**Types:**
- Interfaces: PascalCase descriptive names (no `I` prefix) (e.g., `RiskManagerConfig`, `StorageOptions`, `RiskCheckResult`)
- Type aliases: PascalCase (e.g., `RiskCode`)
- Unions: descriptive literal strings in single quotes (e.g., `'DAILY_LOSS_EXCEEDED' | 'WEEKLY_LOSS_EXCEEDED'`)
- Generic types: single uppercase letter or descriptive `T` prefix (e.g., `T`, `TData`)
- React component props: PascalCase interface named `[ComponentName]Props`

## Code Style

**Formatting:**
- Tool: Prettier (via vite/build system) — no explicit `.prettierrc` override for this project
- Line length: default (80-120 characters, controlled by ESLint)
- Indentation: 2 spaces
- Semicolons: required
- Trailing commas: multi-line objects/arrays only
- Arrow functions preferred over `function` keyword for callbacks

**Linting:**
- Tool: ESLint (v8.50.0) with TypeScript support
- Config: `.eslintrc.cjs`
- Base extends: `eslint:recommended`, `plugin:@typescript-eslint/recommended`, `plugin:react-hooks/recommended`
- Build command: `npm run lint` (max warnings: 65)

**Key ESLint Rules:**
- `react-refresh/only-export-components`: warn on non-component module exports (Vite HMR requirement)
- `@typescript-eslint/no-unused-vars`: warn, ignore `_` prefix (used for intentionally unused parameters)
- `@typescript-eslint/no-var-requires`: off (this rule governs usage of CommonJS `require()`, not ES dynamic `import()`. Disabled to allow legacy/CommonJS `require()` in scripts, config files, or circular import workarounds. Use dynamic `import()` for ES modules.)
- `no-empty`: error but allow empty catch blocks (fire-and-forget pattern)
- `@typescript-eslint/no-explicit-any`: warn (permitted for API response parsing where types unknown)

**TypeScript Strict Mode:**
- `strict: true` enabled in `tsconfig.json`
- `noUnusedLocals: true` — all variables must be used
- `noUnusedParameters: true` — prefix unused params with `_`
- `noFallthroughCasesInSwitch: true` — switch statements must handle all cases

## Import Organization

**Order:**
1. External packages (react, zustand, axios, etc.)
2. Absolute path aliases (@/*, relative paths if no alias)
3. Local relative imports

**Path Aliases:**
- `@/*` → `src/*` (defined in `tsconfig.json`)
- All imports use full paths: `import { useSettingsStore } from '@/stores/settingsStore'`
- No implicit index imports — prefer explicit exports

**Example import block:**
```typescript
import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { WalletEntry } from '@/types'
import { useWalletStore } from '@/stores/walletStore'
import { RiskManager } from './RiskManager'
```

## Error Handling

**Patterns:**
- Try-catch blocks wrap operations with side effects (API calls, storage, async initialization)
- Catch blocks: log errors with context prefix (e.g., `[App]`, `[RiskManager]`), handle gracefully
- Fire-and-forget patterns: `.catch(() => {})` for non-critical async operations
- Error propagation: re-throw after logging if error is critical to flow

**Example:**
```typescript
try {
  await indexedDBService.initialize()
  console.log('[App] IndexedDB storage initialized')
} catch (error) {
  console.error('[App] Failed to initialize:', error)
  // Continue with graceful fallback
}

// Fire-and-forget for non-critical cleanup:
indexedDBService.pruneAll().catch(() => {})
```

**No-op catch blocks:**
- Permitted by ESLint config: `allowEmptyCatch: true`
- Used for non-critical operations (e.g., optional cache warming, retry attempts)
- Only when failure doesn't affect state or user experience

## Logging

**Framework:** `console` (no external logger)

**Patterns:**
- All logs prefixed with context module in brackets: `[App]`, `[RiskManager]`, `[ActivityLogger]`
- Log levels:
  - `console.log()`: initialization, state transitions, info
  - `console.warn()`: recoverable failures (fallback activated, connection retry)
  - `console.error()`: critical failures, exceptions
- Messages: descriptive, include relevant state/IDs when helpful
- Async operations: log start and completion separately

**Examples:**
```typescript
console.log('[App] Initializing AlphaPolyBot...')
console.warn('[App] RTDS connection failed — using Binance/CoinGecko fallback')
console.error('[App] Failed to initialize strategy manager:', error)
```

## Comments

**When to Comment:**
- Non-obvious algorithms or math (e.g., Kelly criterion calculation, fee mechanics)
- Workarounds for known issues or limitations
- Fire-and-forget patterns explaining why async errors are swallowed
- Sections of code with high cognitive load or cross-module dependencies

**Comment Style:**
- Line comments: `// Single line explanation`
- Block comments: `/* Multi-line explanation */` for complex logic
- Avoid obvious comments: `const name = 'Alice'; // Set name to Alice` ❌
- Pragma comments: Used to suppress ESLint rules (`// eslint-disable-next-line`)

**JSDoc/TSDoc:**
- Used on public functions, classes, and interfaces
- Format: standard JSDoc with `/**` opening, `*` prefix, `*/` closing
- Includes: brief description, `@param` and `@returns` for complex signatures
- Not required for simple getters/setters or obvious functions

**Example:**
```typescript
/**
 * Initialize storage with optional encryption passphrase.
 * Derives an AES-256-GCM key via PBKDF2.
 */
async initialize(passphrase?: string): Promise<void> {
  // ...
}
```

## Function Design

**Size:** Prefer compact functions (<50 lines typical), split at logical boundaries

**Parameters:**
- Destructured object params preferred for >2 args (e.g., `{ startPrice, endPrice, quantity }`)
- Type annotations required for all params
- Optional params: `?` suffix in interface, default values in function signature
- No positional boolean params — use enums or object literal

**Return Values:**
- Type annotations explicit (`Promise<T>`, `T | null`, `T | undefined`)
- Early returns preferred (exit guard clauses at top)
- Async functions return Promise; no callback-based async
- Methods updating internal state: return `this` for chaining (Zustand setters excepted)

**Example (from settingsStore):**
```typescript
setDryRun(enabled: boolean): void {
  this.dryRun = enabled
}

async set<T>(key: string, value: T, options: StorageOptions = {}): Promise<void> {
  // ...
}
```

## Module Design

**Exports:**
- Explicit named exports preferred: `export const riskManager = new RiskManager()`
- Default exports only for React components (convention for lazy-loaded views)
- Barrel files: `src/stores/index.ts`, `src/utils/index.ts` re-export commonly used items

**Singleton Services:**
- Instantiated once at module level: `export const riskManager = new RiskManager()`
- Shared globally via imports (not passed through props)
- Allows services to maintain internal state and subscribe to updates

**Example Barrel File (`src/utils/index.ts`):**
```typescript
export { cn } from './cn'
export { secureStorage, SecureStorage } from './secureStorage'
```

**Zustand Store Pattern:**
- Store interface exported: `export interface AppSettingsState { ... }`
- Store hook exported: `export const useSettingsStore = create<AppSettingsState>(...)`
- Setters are methods on the store, called via `useSettingsStore.getState().setDryRun(false)`
- Tests access via `useSettingsStore.getState()` (synchronous, always current)

---

*Convention analysis: 2026-02-25*
