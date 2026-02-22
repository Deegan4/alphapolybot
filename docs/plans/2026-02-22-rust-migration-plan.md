# AlphaPolyBot Rust Migration — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Port the BTC Up/Down strategy end-to-end to a Rust binary with ratatui TUI, proving the latency advantage over the TypeScript implementation.

**Architecture:** 6-crate Tokio async monolith. Tasks communicate via mpsc channels. Signal engine is pure math (no async). RiskManager is shared state via `Arc<RwLock>`. Config via TOML file.

**Tech Stack:** Rust 2024 edition, tokio, tokio-tungstenite, reqwest, ethers, ratatui, crossterm, serde, toml, tracing, hmac, dashmap, thiserror, criterion

**Reference TS codebase:** `/Volumes/SAMSUNG 1TB/alphapolybot` (the existing TypeScript bot — use as spec)

---

## Task 1: Workspace Scaffold & Core Crate

**Files:**
- Create: `/Volumes/SAMSUNG 1TB/alphapolybot-rs/Cargo.toml`
- Create: `/Volumes/SAMSUNG 1TB/alphapolybot-rs/crates/core/Cargo.toml`
- Create: `/Volumes/SAMSUNG 1TB/alphapolybot-rs/crates/core/src/lib.rs`
- Create: `/Volumes/SAMSUNG 1TB/alphapolybot-rs/crates/core/src/config.rs`
- Create: `/Volumes/SAMSUNG 1TB/alphapolybot-rs/crates/core/src/error.rs`
- Create: `/Volumes/SAMSUNG 1TB/alphapolybot-rs/crates/core/src/types.rs`
- Create: `/Volumes/SAMSUNG 1TB/alphapolybot-rs/src/main.rs`
- Create: `/Volumes/SAMSUNG 1TB/alphapolybot-rs/config.toml`
- Create: `/Volumes/SAMSUNG 1TB/alphapolybot-rs/.gitignore`

**Step 1: Create workspace Cargo.toml**

```toml
[workspace]
resolver = "2"
members = [
    "crates/core",
    "crates/signal",
    "crates/exchange",
    "crates/strategy",
    "crates/risk",
    "crates/tui",
]

[package]
name = "alphapolybot-rs"
version = "0.1.0"
edition = "2024"

[dependencies]
core = { path = "crates/core" }
tokio = { version = "1", features = ["full"] }
tracing = "0.1"
tracing-subscriber = { version = "0.3", features = ["env-filter"] }
toml = "0.8"
```

**Step 2: Create core crate with types, config, and errors**

`crates/core/Cargo.toml`:
```toml
[package]
name = "core"
version = "0.1.0"
edition = "2024"

[dependencies]
serde = { version = "1", features = ["derive"] }
thiserror = "2"
toml = "0.8"
```

`crates/core/src/error.rs` — Unified error types:
```rust
use thiserror::Error;

#[derive(Debug, Error)]
pub enum BotError {
    #[error("Exchange: {0}")]
    Exchange(#[from] ExchangeError),

    #[error("Risk rejected: {code:?} — {reason}")]
    RiskRejected { code: RiskCode, reason: String },

    #[error("WebSocket disconnected: {0}")]
    WsDisconnect(String),

    #[error("Config: {0}")]
    Config(String),

    #[error("IO: {0}")]
    Io(#[from] std::io::Error),
}

#[derive(Debug, Error)]
pub enum ExchangeError {
    #[error("Insufficient balance")]
    InsufficientBalance,

    #[error("Invalid signature: {0}")]
    InvalidSignature(String),

    #[error("Invalid fee rate: expected {expected}, got {actual}")]
    InvalidFeeRate { expected: u32, actual: u32 },

    #[error("Rate limited")]
    RateLimited,

    #[error("HTTP {status}: {body}")]
    Http { status: u16, body: String },

    #[error("Network: {0}")]
    Network(String),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RiskCode {
    DailyLossExceeded,
    WeeklyLossExceeded,
    HourlyTradeLimit,
    ConsecutiveFailures,
    InsufficientBalance,
    EmergencyStopped,
    MaxDrawdown,
}

impl ExchangeError {
    /// Whether this error should be retried with backoff.
    /// InsufficientBalance and InvalidSignature are NEVER retried.
    pub fn is_retryable(&self) -> bool {
        matches!(self, Self::RateLimited | Self::Network(_))
    }
}
```

`crates/core/src/types.rs` — Shared types:
```rust
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum Asset {
    BTC,
    ETH,
    SOL,
    XRP,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum Direction {
    Up,
    Down,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum Regime {
    Choppy,
    Trending,
    Neutral,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum WindowDuration {
    FiveMin,
    FifteenMin,
    Hourly,
    Daily,
    NinePM,
}

impl WindowDuration {
    pub fn as_ms(&self) -> u64 {
        match self {
            Self::FiveMin => 5 * 60 * 1000,
            Self::FifteenMin => 15 * 60 * 1000,
            Self::Hourly => 60 * 60 * 1000,
            Self::Daily => 24 * 60 * 60 * 1000,
            Self::NinePM => 24 * 60 * 60 * 1000,
        }
    }
}

/// Price tick from Binance WebSocket
#[derive(Debug, Clone, Copy)]
pub struct PriceTick {
    pub asset: Asset,
    pub price: f64,
    pub timestamp_ms: u64,
}

/// Signal output from the signal engine
#[derive(Debug, Clone)]
pub struct Signal {
    pub direction: Direction,
    pub confidence: f64,
    pub factors: SignalFactors,
}

#[derive(Debug, Clone)]
pub struct SignalFactors {
    pub momentum: f64,
    pub velocity: f64,
    pub time_decay: f64,
    pub value_bet: f64,
    pub order_flow: f64,
    pub cross_asset: f64,
    pub regime: Regime,
    pub regime_efficiency: f64,
    pub regime_efficiency_long_term: f64,
    pub rsi: f64,
    pub volatility: f64,
}

/// Order request to the CLOB
#[derive(Debug, Clone)]
pub struct OrderRequest {
    pub token_id: String,
    pub side: OrderSide,
    pub price: f64,
    pub size: f64,
    pub order_type: OrderType,
    pub neg_risk: bool,
    pub expiration: Option<u64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OrderSide {
    Buy,
    Sell,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OrderType {
    FOK,
    FAK,
    GTC,
    GTD,
}

/// Result from order placement
#[derive(Debug, Clone)]
pub struct OrderResult {
    pub success: bool,
    pub order_id: Option<String>,
    pub tx_hash: Option<String>,
    pub error: Option<String>,
}

/// Trade result for RiskManager tracking
#[derive(Debug, Clone)]
pub struct TradeResult {
    pub success: bool,
    pub pnl: f64,
    pub condition_id: Option<String>,
}

/// Market data from Gamma API
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Market {
    pub condition_id: String,
    pub question: String,
    pub outcomes: Vec<String>,
    pub clob_token_ids: Vec<String>,
    pub neg_risk: bool,
    pub active: bool,
    pub end_date_iso: Option<String>,
}
```

`crates/core/src/config.rs` — TOML config:
```rust
use serde::Deserialize;

#[derive(Debug, Clone, Deserialize)]
pub struct BotConfig {
    pub wallet: WalletConfig,
    pub btc_updown: BtcUpDownConfig,
    pub risk: RiskConfig,
}

#[derive(Debug, Clone, Deserialize)]
pub struct WalletConfig {
    /// Seed phrase — prefer env var WALLET_SEED_PHRASE over config file
    #[serde(default)]
    pub seed_phrase: String,
    /// "auto", "eoa", or "proxy"
    #[serde(default = "default_sig_type")]
    pub signature_type: String,
}

fn default_sig_type() -> String { "auto".into() }

#[derive(Debug, Clone, Deserialize)]
pub struct BtcUpDownConfig {
    #[serde(default = "default_assets")]
    pub enabled_assets: Vec<String>,
    #[serde(default = "default_windows")]
    pub enabled_windows: Vec<String>,
    #[serde(default = "default_trade_size")]
    pub trade_size: f64,
    #[serde(default = "default_true")]
    pub use_kelly_sizing: bool,
    #[serde(default = "default_min_confidence")]
    pub min_confidence: f64,
    #[serde(default = "default_max_entry_price")]
    pub max_entry_price: f64,
    #[serde(default = "default_min_entry_price")]
    pub min_entry_price: f64,
    #[serde(default = "default_scan_interval")]
    pub scan_interval_ms: u64,
    #[serde(default = "default_max_positions")]
    pub max_concurrent_positions: usize,
    #[serde(default = "default_true")]
    pub regime_filter: bool,
    #[serde(default = "default_true")]
    pub rsi_filter: bool,
}

#[derive(Debug, Clone, Deserialize)]
pub struct RiskConfig {
    #[serde(default = "default_daily_loss")]
    pub daily_loss_limit: f64,
    #[serde(default = "default_max_trades")]
    pub max_trades_per_hour: u32,
    #[serde(default = "default_failure_limit")]
    pub consecutive_failure_limit: u32,
    #[serde(default = "default_min_balance")]
    pub min_balance: f64,
    #[serde(default = "default_drawdown")]
    pub max_drawdown_percent: f64,
}

// Default value functions
fn default_assets() -> Vec<String> { vec!["BTC".into(), "SOL".into()] }
fn default_windows() -> Vec<String> { vec!["15m".into()] }
fn default_trade_size() -> f64 { 1.0 }
fn default_true() -> bool { true }
fn default_min_confidence() -> f64 { 0.60 }
fn default_max_entry_price() -> f64 { 0.55 }
fn default_min_entry_price() -> f64 { 0.10 }
fn default_scan_interval() -> u64 { 15_000 }
fn default_max_positions() -> usize { 3 }
fn default_daily_loss() -> f64 { 10.0 }
fn default_max_trades() -> u32 { 20 }
fn default_failure_limit() -> u32 { 5 }
fn default_min_balance() -> f64 { 1.0 }
fn default_drawdown() -> f64 { 0.30 }

impl BotConfig {
    pub fn load(path: &str) -> Result<Self, String> {
        let content = std::fs::read_to_string(path)
            .map_err(|e| format!("Failed to read config: {e}"))?;
        let mut config: BotConfig = toml::from_str(&content)
            .map_err(|e| format!("Failed to parse config: {e}"))?;

        // Override seed phrase from env if present
        if let Ok(seed) = std::env::var("WALLET_SEED_PHRASE") {
            if !seed.is_empty() {
                config.wallet.seed_phrase = seed;
            }
        }
        Ok(config)
    }
}
```

`crates/core/src/lib.rs`:
```rust
pub mod config;
pub mod error;
pub mod types;

pub use config::BotConfig;
pub use error::{BotError, ExchangeError, RiskCode};
pub use types::*;
```

`src/main.rs` (minimal, just loads config):
```rust
use core::BotConfig;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter("alphapolybot_rs=info")
        .init();

    let config = BotConfig::load("config.toml")?;
    tracing::info!("AlphaPolyBot-RS loaded config: {:?}", config.btc_updown.enabled_assets);
    tracing::info!("Starting...");

    // TODO: spawn tasks
    Ok(())
}
```

**Step 3: Create default config.toml and .gitignore**

`config.toml`:
```toml
[wallet]
seed_phrase = ""          # Use env: WALLET_SEED_PHRASE
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

`.gitignore`:
```
/target
config.toml
*.env
```

**Step 4: Build and verify**

Run: `cd "/Volumes/SAMSUNG 1TB/alphapolybot-rs" && cargo build`
Expected: Compiles successfully

**Step 5: Commit**

```bash
git init && git add -A && git commit -m "feat: scaffold workspace with core crate (types, config, errors)"
```

---

## Task 2: Signal Crate — Pure Math Engine

Port the 5-factor signal engine from `signalEngine.ts`. This is the hot path — pure math, zero allocations.

**Files:**
- Create: `crates/signal/Cargo.toml`
- Create: `crates/signal/src/lib.rs`
- Create: `crates/signal/src/ring_buffer.rs`
- Create: `crates/signal/src/factors.rs`
- Create: `crates/signal/benches/signal_bench.rs`

**Reference TS:** `src/services/strategies/btcupdown/signalEngine.ts`

**Step 1: Write ring buffer with tests**

`crates/signal/src/ring_buffer.rs`:
```rust
/// Fixed-size ring buffer for price history. Stack-allocated, zero heap.
/// Stores (price, timestamp_ms) pairs.
pub struct RingBuffer<const N: usize> {
    data: [(f64, u64); N],
    head: usize,    // next write position
    len: usize,     // current count
}

impl<const N: usize> RingBuffer<N> {
    pub const fn new() -> Self {
        Self {
            data: [(0.0, 0); N],
            head: 0,
            len: 0,
        }
    }

    pub fn push(&mut self, price: f64, timestamp_ms: u64) {
        self.data[self.head] = (price, timestamp_ms);
        self.head = (self.head + 1) % N;
        if self.len < N {
            self.len += 1;
        }
    }

    pub fn len(&self) -> usize {
        self.len
    }

    pub fn is_empty(&self) -> bool {
        self.len == 0
    }

    /// Iterate from oldest to newest
    pub fn iter(&self) -> impl Iterator<Item = (f64, u64)> + '_ {
        let start = if self.len < N { 0 } else { self.head };
        (0..self.len).map(move |i| {
            let idx = (start + i) % N;
            self.data[idx]
        })
    }

    /// Get the most recent entry
    pub fn latest(&self) -> Option<(f64, u64)> {
        if self.len == 0 {
            None
        } else {
            let idx = if self.head == 0 { N - 1 } else { self.head - 1 };
            Some(self.data[idx])
        }
    }

    /// Collect prices as a Vec (for functions that need slices)
    pub fn prices(&self) -> Vec<f64> {
        self.iter().map(|(p, _)| p).collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_buffer() {
        let buf = RingBuffer::<300>::new();
        assert!(buf.is_empty());
        assert_eq!(buf.len(), 0);
        assert!(buf.latest().is_none());
    }

    #[test]
    fn push_and_iterate() {
        let mut buf = RingBuffer::<5>::new();
        for i in 0..3 {
            buf.push(i as f64 * 100.0, i as u64 * 1000);
        }
        assert_eq!(buf.len(), 3);
        let prices: Vec<f64> = buf.iter().map(|(p, _)| p).collect();
        assert_eq!(prices, vec![0.0, 100.0, 200.0]);
    }

    #[test]
    fn wraps_around() {
        let mut buf = RingBuffer::<3>::new();
        for i in 0..5 {
            buf.push(i as f64, i as u64);
        }
        assert_eq!(buf.len(), 3);
        let prices: Vec<f64> = buf.iter().map(|(p, _)| p).collect();
        assert_eq!(prices, vec![2.0, 3.0, 4.0]); // oldest 3
    }

    #[test]
    fn latest_returns_most_recent() {
        let mut buf = RingBuffer::<5>::new();
        buf.push(100.0, 1000);
        buf.push(200.0, 2000);
        assert_eq!(buf.latest(), Some((200.0, 2000)));
    }
}
```

**Step 2: Write signal helper functions with tests**

`crates/signal/src/factors.rs` — Port `computeVolatility`, `classifyRegime`, `computeRSI`, `linearRegressionSlope`, `regimeMultiplier`, `computeBlendedEfficiency`:

```rust
/// Compute volatility (stddev of returns). Returns 0 if < 5 data points.
/// Port of: signalEngine.ts computeVolatility()
pub fn compute_volatility(prices: &[(f64, u64)]) -> f64 {
    if prices.len() < 5 { return 0.0; }
    let returns: Vec<f64> = prices.windows(2)
        .filter(|w| w[0].0 > 0.0 && w[1].0 > 0.0)
        .map(|w| (w[1].0 - w[0].0) / w[0].0)
        .collect();
    if returns.len() < 3 { return 0.0; }
    let mean = returns.iter().sum::<f64>() / returns.len() as f64;
    let variance = returns.iter().map(|r| (r - mean).powi(2)).sum::<f64>() / returns.len() as f64;
    variance.sqrt()
}

/// Efficiency ratio: |net displacement| / total path length.
/// < 0.15 → choppy, > 0.40 → trending, else neutral.
pub fn classify_regime(prices: &[(f64, u64)]) -> (crate::Regime, f64) {
    use crate::Regime;
    if prices.len() < 10 { return (Regime::Neutral, 0.25); }
    let net = (prices.last().unwrap().0 - prices[0].0).abs();
    let total: f64 = prices.windows(2).map(|w| (w[1].0 - w[0].0).abs()).sum();
    if total == 0.0 { return (Regime::Neutral, 0.25); }
    let eff = net / total;
    let regime = if eff < 0.15 { Regime::Choppy } else if eff > 0.40 { Regime::Trending } else { Regime::Neutral };
    (regime, eff)
}

/// Graduated confidence multiplier based on efficiency ratio.
/// Port of: signalEngine.ts regimeMultiplier()
pub fn regime_multiplier(efficiency: f64) -> f64 {
    if efficiency <= 0.0 { return 0.60; }
    if efficiency <= 0.30 { return 0.60 + (efficiency / 0.30) * 0.40; }
    if efficiency >= 0.70 { return 1.15; }
    1.00 + ((efficiency - 0.30) / 0.40) * 0.15
}

/// Blend short-term and long-term efficiency with scenario awareness.
/// Port of: signalEngine.ts computeBlendedEfficiency()
pub fn compute_blended_efficiency(eff_short: f64, eff_long: f64) -> f64 {
    let st_choppy = eff_short < 0.15;
    let st_trending = eff_short > 0.40;
    let lt_choppy = eff_long < 0.15;
    let lt_trending = eff_long > 0.40;

    if st_choppy && lt_trending { return 0.40 * eff_short + 0.60 * eff_long; }
    if st_trending && lt_trending { return eff_short.max(eff_long); }
    if st_choppy && lt_choppy { return eff_short.min(eff_long); }
    if st_trending && lt_choppy { return 0.60 * eff_short + 0.40 * eff_long; }
    (eff_short + eff_long) / 2.0
}

/// Fast RSI computation. Returns 50 (neutral) if insufficient data.
/// Port of: signalEngine.ts computeRSI()
pub fn compute_rsi(prices: &[(f64, u64)], period: usize) -> f64 {
    if prices.len() < period + 1 { return 50.0; }
    let recent = &prices[prices.len() - period - 1..];
    let (mut gains, mut losses) = (0.0, 0.0);
    for w in recent.windows(2) {
        let change = w[1].0 - w[0].0;
        if change > 0.0 { gains += change; } else { losses -= change; }
    }
    if losses == 0.0 { return 100.0; }
    if gains == 0.0 { return 0.0; }
    let rs = (gains / period as f64) / (losses / period as f64);
    100.0 - 100.0 / (1.0 + rs)
}

/// Linear regression slope over price history. Returns price change per ms.
/// Port of: signalEngine.ts linearRegressionSlope()
pub fn linear_regression_slope(prices: &[(f64, u64)]) -> f64 {
    let n = prices.len();
    if n < 2 { return 0.0; }
    let t0 = prices[0].1 as f64;
    let (mut sx, mut sy, mut sxy, mut sxx) = (0.0, 0.0, 0.0, 0.0);
    for &(price, ts) in prices {
        let x = ts as f64 - t0;
        sx += x; sy += price; sxy += x * price; sxx += x * x;
    }
    let nf = n as f64;
    let denom = nf * sxx - sx * sx;
    if denom.abs() < 1e-12 { return 0.0; }
    (nf * sxy - sx * sy) / denom
}

/// Orderbook imbalance from top-N levels. Returns [-1, 1].
pub fn compute_orderbook_imbalance(
    bids: &[(f64, f64)],  // (price, size)
    asks: &[(f64, f64)],
    top_n: usize,
) -> f64 {
    if bids.is_empty() || asks.is_empty() { return 0.0; }
    let bid_size: f64 = bids.iter().take(top_n).map(|b| b.1).sum();
    let ask_size: f64 = asks.iter().take(top_n).map(|a| a.1).sum();
    let total = bid_size + ask_size;
    if total == 0.0 { return 0.0; }
    (bid_size - ask_size) / total
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn volatility_insufficient_data() {
        let prices: Vec<(f64, u64)> = (0..3).map(|i| (100.0, i * 1000)).collect();
        assert_eq!(compute_volatility(&prices), 0.0);
    }

    #[test]
    fn volatility_constant_prices() {
        let prices: Vec<(f64, u64)> = (0..10).map(|i| (100.0, i * 1000)).collect();
        assert_eq!(compute_volatility(&prices), 0.0);
    }

    #[test]
    fn volatility_varying_prices() {
        let prices = vec![
            (100.0, 0), (102.0, 1000), (99.0, 2000),
            (101.0, 3000), (103.0, 4000), (98.0, 5000),
        ];
        let vol = compute_volatility(&prices);
        assert!(vol > 0.0);
        assert!(vol < 0.1); // reasonable for ~2% moves
    }

    #[test]
    fn regime_insufficient_data() {
        let prices: Vec<(f64, u64)> = (0..5).map(|i| (100.0 + i as f64, i * 1000)).collect();
        let (regime, eff) = classify_regime(&prices);
        assert_eq!(regime, crate::Regime::Neutral);
        assert!((eff - 0.25).abs() < f64::EPSILON);
    }

    #[test]
    fn regime_trending() {
        // Prices go strictly up — efficiency should be ~1.0
        let prices: Vec<(f64, u64)> = (0..20).map(|i| (100.0 + i as f64, i * 1000)).collect();
        let (regime, eff) = classify_regime(&prices);
        assert_eq!(regime, crate::Regime::Trending);
        assert!(eff > 0.90);
    }

    #[test]
    fn regime_choppy() {
        // Prices oscillate — low efficiency
        let prices: Vec<(f64, u64)> = (0..20)
            .map(|i| (100.0 + if i % 2 == 0 { 1.0 } else { -1.0 }, i * 1000))
            .collect();
        let (regime, _) = classify_regime(&prices);
        assert_eq!(regime, crate::Regime::Choppy);
    }

    #[test]
    fn regime_multiplier_boundaries() {
        assert!((regime_multiplier(0.0) - 0.60).abs() < 0.001);
        assert!((regime_multiplier(0.30) - 1.00).abs() < 0.001);
        assert!((regime_multiplier(0.70) - 1.15).abs() < 0.001);
        assert!((regime_multiplier(1.0) - 1.15).abs() < 0.001);
    }

    #[test]
    fn blended_pullback_in_trend() {
        // Short-term choppy (0.10), long-term trending (0.60)
        let blended = compute_blended_efficiency(0.10, 0.60);
        let expected = 0.40 * 0.10 + 0.60 * 0.60;
        assert!((blended - expected).abs() < 0.001);
    }

    #[test]
    fn rsi_all_gains() {
        let prices: Vec<(f64, u64)> = (0..20)
            .map(|i| (100.0 + i as f64, i * 1000))
            .collect();
        assert_eq!(compute_rsi(&prices, 14), 100.0);
    }

    #[test]
    fn rsi_all_losses() {
        let prices: Vec<(f64, u64)> = (0..20)
            .map(|i| (120.0 - i as f64, i * 1000))
            .collect();
        assert_eq!(compute_rsi(&prices, 14), 0.0);
    }

    #[test]
    fn linear_regression_flat() {
        let prices: Vec<(f64, u64)> = (0..10).map(|i| (100.0, i * 1000)).collect();
        assert!((linear_regression_slope(&prices)).abs() < 1e-10);
    }

    #[test]
    fn linear_regression_uptrend() {
        // Price increases by $1 per second
        let prices: Vec<(f64, u64)> = (0..10).map(|i| (100.0 + i as f64, i * 1000)).collect();
        let slope = linear_regression_slope(&prices);
        assert!((slope - 0.001).abs() < 0.0001); // $1/1000ms = 0.001 per ms
    }
}
```

**Step 3: Write the main `compute_signal` function**

`crates/signal/src/lib.rs` — Port of `computeSignal()`:
```rust
pub mod factors;
pub mod ring_buffer;

pub use core::types::{Direction, Regime, Signal, SignalFactors};
use factors::*;

/// Signal engine configuration
pub struct SignalConfig {
    pub regime_filter_enabled: bool,
    pub rsi_filter_enabled: bool,
    pub baseline_window_ms: u64,
    pub fee_rate_bps: u32,
}

impl Default for SignalConfig {
    fn default() -> Self {
        Self {
            regime_filter_enabled: true,
            rsi_filter_enabled: true,
            baseline_window_ms: 900_000, // 15 min
            fee_rate_bps: 0,
        }
    }
}

/// Input to signal computation
pub struct SignalInput<'a> {
    pub current_price: f64,
    pub window_open_price: f64,
    pub up_price: f64,
    pub down_price: f64,
    pub time_into_window_ms: u64,
    pub window_duration_ms: u64,
    pub recent_prices: &'a [(f64, u64)],
    pub recent_prices_long_term: Option<&'a [(f64, u64)]>,
    pub cross_assets: &'a [(Direction, f64)], // (direction of peer delta, magnitude)
    pub imbalance_score: f64,
}

/// 5-factor vol-normalized signal computation.
/// Port of: signalEngine.ts computeSignal()
///
/// Factors: MOMENTUM (25%), VELOCITY (25%), TIME DECAY (20%),
///          VALUE BET (15%), ORDER FLOW (15%).
pub fn compute_signal(input: &SignalInput, config: &SignalConfig) -> Signal {
    let time_scale = input.window_duration_ms as f64 / config.baseline_window_ms as f64;

    // Factor 1: MOMENTUM — vol-normalized z-score
    let price_delta = (input.current_price - input.window_open_price) / input.window_open_price;
    let sigma = compute_volatility(input.recent_prices);
    let elapsed_s = (input.time_into_window_ms as f64 / 1000.0).max(1.0);
    let remaining_s = ((input.window_duration_ms - input.time_into_window_ms) as f64 / 1000.0).max(1.0);
    let time_norm = remaining_s.min(elapsed_s).sqrt();

    let momentum_score = if sigma > 0.0 {
        let z_score = price_delta / (sigma * time_norm);
        (z_score * 1.5).tanh()
    } else {
        (price_delta * 50.0 / time_scale.sqrt()).clamp(-1.0, 1.0)
    };

    let direction = if price_delta >= 0.0 { Direction::Up } else { Direction::Down };

    // Factor 2: VELOCITY — linear regression slope
    let velocity_score = if input.recent_prices.len() >= 3 {
        let slope = linear_regression_slope(input.recent_prices);
        let relative_slope = slope / input.window_open_price;
        let velocity_scaler = 30.0 / time_scale.sqrt();
        (relative_slope * 60_000.0 * velocity_scaler).clamp(-1.0, 1.0)
    } else {
        0.0
    };

    // Factor 3: TIME DECAY — direction consistency
    let time_ratio = (input.time_into_window_ms as f64 / input.window_duration_ms as f64).clamp(0.0, 1.0);
    let dir_consistency = if input.recent_prices.len() >= 2 {
        let on_same_side = input.recent_prices.iter().filter(|(p, _)| {
            match direction {
                Direction::Up => *p >= input.window_open_price,
                Direction::Down => *p < input.window_open_price,
            }
        }).count();
        on_same_side as f64 / input.recent_prices.len() as f64
    } else {
        0.0
    };
    let time_decay_boost = time_ratio * dir_consistency;

    // Factor 4: VALUE BET — cheapness
    let target_price = match direction {
        Direction::Up => input.up_price,
        Direction::Down => input.down_price,
    };
    let cheapness = (1.0 - target_price).clamp(0.0, 1.0);

    // Factor 6: CROSS-ASSET CORRELATION
    let cross_asset_score = if !input.cross_assets.is_empty() {
        let sum: f64 = input.cross_assets.iter().map(|(_, magnitude)| {
            (magnitude * 100.0).tanh()
        }).sum();
        sum / input.cross_assets.len() as f64
    } else {
        0.0
    };

    // COMPOSITE with dynamic weights
    let has_cross = !input.cross_assets.is_empty();
    let w_momentum = if has_cross { 0.22 } else { 0.25 };
    let w_velocity = if has_cross { 0.22 } else { 0.25 };
    let w_time = 0.20;
    let w_value = 0.15;
    let w_flow = 0.15;
    let w_cross = if has_cross { 0.06 } else { 0.0 };

    let raw_score = momentum_score * w_momentum
        + velocity_score * w_velocity
        + time_decay_boost * w_time
        + cheapness * w_value
        + input.imbalance_score * w_flow
        + cross_asset_score * w_cross;

    // Sqrt scaling
    let amplified = raw_score.signum() * raw_score.abs().sqrt();

    // Noise dampening
    let noise_scale = time_scale.sqrt();
    let noise_dampener = 0.85 + 0.15 * noise_scale;
    let mut confidence = amplified.abs().mul_add(noise_dampener, 0.0).clamp(0.0, 1.0);

    // Regime scaling (dual-timeframe graduated)
    let (regime, regime_eff) = classify_regime(input.recent_prices);
    let mut regime_eff_lt = regime_eff;
    if let Some(lt_prices) = input.recent_prices_long_term {
        if lt_prices.len() >= 10 {
            regime_eff_lt = classify_regime(lt_prices).1;
        }
    }
    let blended_eff = if input.recent_prices_long_term.is_some() {
        compute_blended_efficiency(regime_eff, regime_eff_lt)
    } else {
        regime_eff
    };
    if config.regime_filter_enabled {
        confidence *= regime_multiplier(blended_eff);
    }

    // RSI filter
    let rsi = if input.recent_prices.len() >= 20 {
        compute_rsi(input.recent_prices, 14)
    } else {
        50.0
    };
    if config.rsi_filter_enabled && input.recent_prices.len() >= 20 {
        if (rsi > 75.0 && direction == Direction::Up) || (rsi < 25.0 && direction == Direction::Down) {
            confidence *= 0.85;
        }
    }

    // Early window ramp
    let early_ramp_ms = 60_000.0 * time_scale;
    if (input.time_into_window_ms as f64) < early_ramp_ms {
        let early_penalty = 0.85 + 0.15 * (input.time_into_window_ms as f64 / early_ramp_ms);
        confidence *= early_penalty;
    }

    // Late-window momentum amplifier
    if time_ratio > 0.60 && momentum_score.abs() > 0.3 {
        let late_boost = (time_ratio - 0.60) / 0.40;
        let mom_strength = momentum_score.abs().min(1.0);
        confidence = (confidence * (1.0 + 0.12 * late_boost * mom_strength)).min(1.0);
    }

    // Fee-aware confidence floor
    if config.fee_rate_bps > 0 {
        let effective_payout = 1.0 - config.fee_rate_bps as f64 / 10_000.0;
        let breakeven = target_price / effective_payout;
        if confidence < breakeven {
            confidence = 0.0;
        }
    }

    Signal {
        direction,
        confidence,
        factors: SignalFactors {
            momentum: momentum_score,
            velocity: velocity_score,
            time_decay: time_decay_boost,
            value_bet: cheapness,
            order_flow: input.imbalance_score,
            cross_asset: cross_asset_score,
            regime,
            regime_efficiency: regime_eff,
            regime_efficiency_long_term: regime_eff_lt,
            rsi,
            volatility: sigma,
        },
    }
}
```

**Step 4: Run tests**

Run: `cargo test -p signal`
Expected: All tests pass

**Step 5: Add criterion benchmark**

`crates/signal/benches/signal_bench.rs`:
```rust
use criterion::{criterion_group, criterion_main, Criterion};
use signal::{compute_signal, SignalConfig, SignalInput};

fn bench_compute_signal(c: &mut Criterion) {
    // Build 300-point price history
    let prices: Vec<(f64, u64)> = (0..300)
        .map(|i| (97000.0 + (i as f64 * 10.0).sin() * 200.0, i * 1000))
        .collect();

    let config = SignalConfig::default();
    let input = SignalInput {
        current_price: 97200.0,
        window_open_price: 97000.0,
        up_price: 0.45,
        down_price: 0.55,
        time_into_window_ms: 300_000,
        window_duration_ms: 900_000,
        recent_prices: &prices,
        recent_prices_long_term: None,
        cross_assets: &[],
        imbalance_score: 0.0,
    };

    c.bench_function("compute_signal_300pt", |b| {
        b.iter(|| compute_signal(&input, &config))
    });
}

criterion_group!(benches, bench_compute_signal);
criterion_main!(benches);
```

Run: `cargo bench -p signal`
Expected: Benchmark output showing signal computation time (target: <1μs)

**Step 6: Commit**

```bash
git add -A && git commit -m "feat: add signal crate with 5-factor engine, ring buffer, and benchmarks"
```

---

## Task 3: Risk Crate — Circuit Breaker

Port the RiskManager from `RiskManager.ts`.

**Files:**
- Create: `crates/risk/Cargo.toml`
- Create: `crates/risk/src/lib.rs`

**Reference TS:** `src/services/trading/RiskManager.ts`

**Step 1: Write RiskManager with tests**

Key behaviors to port:
- Daily loss limit check
- Hourly trade limit (sliding window)
- Consecutive failure counter (resets on success)
- Emergency stop (manual trigger, stays stopped)
- `validate_trade()` returns `RiskCheckResult`
- `record_trade_result()` updates state

```rust
use std::time::{Duration, Instant};
use core::{RiskCode, BotError};
use core::config::RiskConfig;

pub struct RiskCheckResult {
    pub allowed: bool,
    pub reason: Option<String>,
    pub risk_code: Option<RiskCode>,
}

pub struct RiskState {
    config: RiskConfig,
    emergency_stopped: bool,
    emergency_reason: String,
    consecutive_failures: u32,
    trade_timestamps: Vec<Instant>,
    trade_pnls: Vec<(Instant, f64)>,
    peak_balance: f64,
}
```

Full implementation with `validate_trade()`, `record_trade_result()`, `emergency_stop()`, `reset()`.

**Step 2: Write tests** — port key behaviors:
- Trade allowed when all checks pass
- Daily loss limit blocks trades
- Hourly trade limit blocks trades
- Consecutive failures trigger emergency stop
- Emergency stop blocks all trades
- Reset clears emergency state

**Step 3: Run tests**

Run: `cargo test -p risk`
Expected: All pass

**Step 4: Commit**

```bash
git add -A && git commit -m "feat: add risk crate with circuit breaker and pre-trade validation"
```

---

## Task 4: Exchange Crate — CLOB Client & WebSocket

The hardest piece. Port CLOB auth, order signing, and Binance WS feed.

**Files:**
- Create: `crates/exchange/Cargo.toml`
- Create: `crates/exchange/src/lib.rs`
- Create: `crates/exchange/src/clob_client.rs`
- Create: `crates/exchange/src/auth.rs`
- Create: `crates/exchange/src/order_signing.rs`
- Create: `crates/exchange/src/rounding.rs`
- Create: `crates/exchange/src/binance_ws.rs`
- Create: `crates/exchange/src/clob_ws.rs`
- Create: `crates/exchange/src/token_cache.rs`

**Reference TS:** `src/services/api/CLOBClient.ts`

**Key dependencies:**
```toml
[dependencies]
reqwest = { version = "0.12", features = ["json"] }
tokio-tungstenite = { version = "0.24", features = ["native-tls"] }
ethers = { version = "2", features = ["legacy"] }
hmac = "0.12"
sha2 = "0.10"
base64 = "0.22"
dashmap = "6"
```

**Step 1: Port rounding helpers with tests**

`rounding.rs` — exact port of `roundNormal`, `roundDown`, `decimalPlaces`, `ROUNDING_CONFIG`. Test against known TS outputs.

**Step 2: Port HMAC L2 auth**

`auth.rs` — `build_poly_hmac_signature()` and `build_l2_headers()`. Test signature output matches TS for known inputs.

**Step 3: Port EIP-712 order signing**

`order_signing.rs` — `sign_order()` using ethers-rs `TypedData`. Include both standard and NegRisk domains. Test signature recovery matches expected signer.

**Step 4: Port ClobClient**

`clob_client.rs` — `place_order()`, `cancel_order()`, `get_order_book()`, `get_best_prices()`, `derive_api_key()`. Uses `token_cache.rs` for tick_size/neg_risk/fee_rate caching with DashMap + TTL.

**Step 5: Binance WebSocket feed**

`binance_ws.rs` — Connect to `wss://stream.binance.com:9443/ws/btcusdt@trade`, parse trade messages, send `PriceTick` through mpsc channel. Auto-reconnect on disconnect.

**Step 6: CLOB WebSocket feed**

`clob_ws.rs` — Connect to CLOB market channel, two-phase subscription, parse `price_change` events. 30s ping. Auto-reconnect.

**Step 7: Run tests**

Run: `cargo test -p exchange`
Expected: All pass (using wiremock for HTTP, mock WS where needed)

**Step 8: Commit**

```bash
git add -A && git commit -m "feat: add exchange crate with CLOB client, order signing, and WS feeds"
```

---

## Task 5: Strategy Crate — BTC Up/Down

Wire signal engine + exchange + risk into the strategy logic.

**Files:**
- Create: `crates/strategy/Cargo.toml`
- Create: `crates/strategy/src/lib.rs`
- Create: `crates/strategy/src/btc_updown.rs`

**Reference TS:** `src/services/strategies/BtcUpDownStrategy.ts`

**Step 1: Implement BtcUpDown strategy task**

The strategy is a Tokio task that:
1. Receives `PriceTick` from Binance WS channel
2. Pushes into ring buffer
3. Every `scan_interval_ms`, computes signal
4. Gate checks: confidence > min, entry price in range, cooldown, max positions
5. Calls `risk_state.validate_trade()`
6. If approved, sends `OrderRequest` to executor channel

**Step 2: Implement OrderExecutor task**

Receives `OrderRequest` from strategy, calls `clob_client.place_order()`, sends `TradeResult` back.

**Step 3: Write integration test**

Test: fake Binance WS → signal computation → strategy fires → mock CLOB receives order.

**Step 4: Commit**

```bash
git add -A && git commit -m "feat: add strategy crate with BtcUpDown and order executor"
```

---

## Task 6: TUI Crate — ratatui Dashboard

**Files:**
- Create: `crates/tui/Cargo.toml`
- Create: `crates/tui/src/lib.rs`
- Create: `crates/tui/src/app.rs`
- Create: `crates/tui/src/widgets.rs`

**Step 1: Build TUI app struct**

`app.rs` — holds references to shared state (signal, positions, risk state, activity log). Receives updates via channels.

**Step 2: Build widget layout**

`widgets.rs` — Signal panel, positions panel, risk panel, activity log. Matrix green theme.

**Step 3: Wire keyboard input**

Blocking crossterm thread → channel → TUI task. `q`=quit, `e`=emergency stop, `p`=pause.

**Step 4: Manual testing**

Run: `cargo run`
Expected: TUI renders with placeholder data, keyboard works

**Step 5: Commit**

```bash
git add -A && git commit -m "feat: add TUI crate with ratatui dashboard and keyboard controls"
```

---

## Task 7: Main Binary — Wire Everything Together

**Files:**
- Modify: `src/main.rs`

**Step 1: Wire all tasks in main.rs**

```rust
#[tokio::main]
async fn main() -> anyhow::Result<()> {
    // 1. Load config
    // 2. Initialize wallet
    // 3. Derive CLOB API keys
    // 4. Create channels
    // 5. Create shared state (RiskState, etc.)
    // 6. Spawn tasks: binance_ws, clob_ws, signal_engine, strategy, executor, tui
    // 7. Wait for shutdown signal
    // 8. Cancel all tasks, cleanup
}
```

**Step 2: Test end-to-end locally**

Run with real Binance WS (public, no auth needed) and mock/dry-run CLOB orders.

**Step 3: Commit**

```bash
git add -A && git commit -m "feat: wire all tasks in main binary"
```

---

## Task 8: Benchmarks & Latency Validation

**Files:**
- Create: `benches/pipeline_bench.rs`

**Step 1: Benchmark signal pipeline**

Measure: PriceTick received → Signal computed. Target: <1μs.

**Step 2: Benchmark order signing**

Measure: OrderRequest → signed EIP-712 payload. Target: <1ms.

**Step 3: Compare with TS baseline**

Run the TS signal engine in a loop and time it. Compare.

**Step 4: Document results in README**

**Step 5: Commit**

```bash
git add -A && git commit -m "feat: add pipeline benchmarks with latency validation"
```

---

## Summary

| Task | Crate | Est. Complexity | Key Risk |
|------|-------|-----------------|----------|
| 1. Workspace + Core | core | Low | None |
| 2. Signal Engine | signal | Medium | Math precision parity with TS |
| 3. Risk Manager | risk | Low | None |
| 4. Exchange/CLOB | exchange | **High** | EIP-712 signing must match exactly |
| 5. Strategy | strategy | Medium | Async task coordination |
| 6. TUI | tui | Medium | ratatui learning curve |
| 7. Main wiring | — | Low | Channel plumbing |
| 8. Benchmarks | — | Low | None |

**Critical path:** Tasks 1 → 2 → 3 can run in parallel with Task 4. Task 5 depends on 2 + 3 + 4. Task 6 is independent. Task 7 depends on all. Task 8 last.

```
Task 1 (core) ──┬──► Task 2 (signal) ──┐
                 ├──► Task 3 (risk) ────┼──► Task 5 (strategy) ──► Task 7 (main) ──► Task 8 (bench)
                 └──► Task 4 (exchange) ┘              ▲
                      Task 6 (tui) ────────────────────┘
```
