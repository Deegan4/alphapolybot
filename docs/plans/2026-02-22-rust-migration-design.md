# AlphaPolyBot Rust Migration Design

**Date**: 2026-02-22
**Goal**: Rewrite AlphaPolyBot in Rust for latency/performance gains
**First milestone**: BTC Up/Down strategy end-to-end

## Decisions

| Decision | Choice |
|---|---|
| Motivation | Latency / performance |
| UI | Rust + ratatui TUI |
| Migration strategy | One strategy end-to-end (BTC Up/Down) |
| Repo | New repo at `/Volumes/SAMSUNG 1TB/alphapolybot-rs` |
| Architecture | Async Tokio monolith (Approach A) |

## 1. Crate Structure

```
alphapolybot-rs/
├── Cargo.toml              # Workspace root
├── crates/
│   ├── core/               # Types, config, error types (no async)
│   ├── signal/             # Signal engine (pure math, no IO)
│   ├── exchange/           # CLOB client, order signing, WS feeds
│   ├── strategy/           # BtcUpDown strategy
│   ├── risk/               # RiskManager circuit breaker
│   └── tui/                # ratatui dashboard
├── src/
│   └── main.rs             # Tokio runtime, task spawning, config loading
├── tests/
│   └── integration/        # End-to-end pipeline tests
└── config.toml             # Runtime config
```

**Key dependencies:**
- `tokio` — async runtime
- `tokio-tungstenite` — WebSocket (Binance + CLOB)
- `reqwest` — HTTP (CLOB REST, Gamma API)
- `ethers` — EIP-712 signing, wallet, CREATE2 proxy
- `ratatui` + `crossterm` — TUI
- `serde` + `toml` — config
- `tracing` — structured logging
- `ring` or `hmac` — HMAC-SHA256 for CLOB L2 auth
- `dashmap` — concurrent cache for token metadata
- `thiserror` — error types
- `criterion` — benchmarks

## 2. Data Flow

All components are async Tokio tasks communicating via `mpsc` channels.

```
BinanceWS (PriceTick) ──┐
                         ├──► SignalEngine ──► BtcUpDown Strategy ──► OrderExecutor
CLOB WS (BookUpdate) ───┘         │                   │                    │
                                  │                   ▼                    ▼
                                  │            RiskManager          TUI (ratatui)
                                  │         (Arc<RwLock<State>>)
                                  └──────────────────────────────► TUI (display)
```

- **Ring buffer**: `[f64; 300]` stack-allocated, zero heap allocation in hot path
- **RiskManager**: `Arc<RwLock<RiskState>>` — reads vastly outnumber writes
- **Shutdown**: `tokio_util::CancellationToken` checked in all task loops

## 3. CLOB Integration

### Authentication (two layers)

**L1 — API key creation (one-time):**
- EIP-712 sign `ClobAuthDomain` → POST `/auth/api-key` → `{key, secret, passphrase}`

**L2 — Per-request HMAC:**
- `HMAC-SHA256(secret, timestamp + method + path + body)`
- Headers: `POLY-ADDRESS`, `POLY-SIGNATURE`, `POLY-TIMESTAMP`, `POLY-NONCE`, `POLY-API-KEY`, `POLY-PASSPHRASE`

### Order signing (EIP-712)
- Domain: `CTFExchange` or `NegRiskCTFExchange` (per-token `negRisk` flag)
- `signatureType`: 0=EOA, 1=POLY_PROXY (auto-detect via on-chain code check)
- `side`: uint8 0/1 in signed data, "BUY"/"SELL" strings in API body
- Price rounded to token tick size

### Per-token metadata (cached in DashMap, 5-min TTL)
- `GET /tick-size?token_id=X`
- `GET /fee-rate?token_id=X`
- `GET /neg-risk?token_id=X`

### Critical rules (carried from TS)
- USDC.e only (`0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174`)
- "not enough balance" — NEVER retry
- "invalid signature" — NEVER retry (config bug)
- Only rate limits and network errors get exponential backoff

## 4. TUI Layout

```
┌─ AlphaPolyBot-RS ──────────────────────────────────────────────┐
│ BTC: $97,432.18 (+0.3%)  ETH: $2,841.50  SOL: $189.22        │
├────────────────────────────────┬────────────────────────────────┤
│  Signal Engine                 │  Active Positions              │
│  Direction: UP ▲               │  BTC-15m-UP  0.42 → ?         │
│  Confidence: 0.72              │  SOL-15m-DN  0.38 → ?         │
│  Regime: trending              │  (1/3 slots)                   │
│  RSI: 58.3                     │                                │
│  Momentum/Velocity/Vol         │  Risk Manager                  │
│                                │  PnL 24h / Trades/hr / Fails  │
│  Price Buffer [300/300]        │  Status: ACTIVE                │
├────────────────────────────────┴────────────────────────────────┤
│  Recent Activity (scrolling log)                                │
└─────────────────────────────────────────────────────────────────┘
  [q]uit  [e]mergency stop  [p]ause  [r]eload config
```

- 4fps render (250ms tick)
- Matrix green theme (`Color::Rgb(0, 255, 65)`)
- Keyboard input on blocking thread, forwarded via channel
- `e` key → `CancellationToken::cancel()` → all tasks stop

## 5. Config

TOML file replaces Zustand settingsStore:

```toml
[wallet]
seed_phrase = ""          # or env: WALLET_SEED_PHRASE
signature_type = "auto"

[btc_updown]
enabled_assets = ["BTC", "SOL"]
enabled_windows = ["15m"]
trade_size = 1.0
use_kelly_sizing = true
min_confidence = 0.60
max_entry_price = 0.55
scan_interval_ms = 15000
max_concurrent_positions = 3
regime_filter = true
rsi_filter = true

[risk]
daily_loss_limit = 10.0
max_trades_per_hour = 20
consecutive_failure_limit = 5
min_balance = 1.0
max_drawdown_percent = 0.30
```

## 6. Error Handling

Unified error type with `thiserror`. Exhaustive match enforced by compiler.

- `ExchangeError::InsufficientBalance` — never retry
- `ExchangeError::InvalidSignature` — never retry (config bug)
- `ExchangeError::RateLimited` — exponential backoff
- Network errors — retry with backoff
- Risk rejections — log and skip, not errors

## 7. Testing

| Layer | Tool | Target |
|---|---|---|
| Signal unit tests | `#[cfg(test)]` + `proptest` | Port 51 signalEngine tests |
| Risk unit tests | `#[cfg(test)]` | Port 32 RiskManager tests |
| Exchange unit tests | `wiremock` | Mock CLOB, verify EIP-712 output |
| Integration | `tokio::test` | Full pipeline with mock WS/HTTP |
| Benchmarks | `criterion` | Signal <1μs, ring buffer <100ns, signing <1ms |
