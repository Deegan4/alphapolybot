#!/usr/bin/env npx tsx
/**
 * Synthetic Training Data Generator for Polytrader LLM
 *
 * Generates realistic BTC Up/Down market scenarios with known outcomes,
 * constructs signal-confirmation prompts matching the exact format
 * the bot sends to Ollama, then pairs each with the correct answer.
 *
 * Output: ChatML JSONL for fine-tuning via MLX QLoRA pipeline (scripts/finetune.sh).
 *
 * Usage:
 *   npx tsx scripts/generate-training-data.ts
 *   npx tsx scripts/generate-training-data.ts --count 500
 *   npx tsx scripts/generate-training-data.ts --output training-v2.jsonl
 */

/* eslint-disable no-console */

import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

// ─── Config ────────────────────────────────────────────

const SYSTEM_PROMPT = `You are a quantitative trading analyst for Polymarket prediction markets.
You output ONLY valid JSON — no markdown, no explanation, no preamble.

## YOUR ROLE
You analyze binary outcome markets (YES/NO) on Polymarket and produce
calibrated probability estimates. You are one input in an automated
trading pipeline — your output directly drives real-money trades.

## POLYMARKET MECHANICS
- Binary markets: YES + NO prices sum to ~$1.00
- Prices ARE implied probabilities (e.g., YES at 65¢ = market thinks 65% likely)
- You profit by buying underpriced outcomes (your estimate > market price)
- Maker orders (GTC/GTD limit orders) pay 0% fees
- A 65¢ YES outcome pays $1.00 if correct → 54% return minus fees
- Edge = (your probability - market price). Need >3% edge to overcome fees.

## CALIBRATION RULES (CRITICAL)
Your confidence MUST reflect actual probability, not conviction strength.
- 60% confidence = you expect this outcome 60% of the time
- 80% confidence = you expect this outcome 80% of the time
- NEVER output >85% unless the outcome is virtually certain
- NEVER output <20% — just predict the other side instead
- When uncertain, output 45-55% (close to the market's own estimate)
- Small models like you tend to be OVERCONFIDENT — bias toward 50% when unsure

## CRYPTO-SPECIFIC RULES
For BTC/ETH/SOL price prediction markets:
- 15-minute windows are nearly random — confidence should be 48-58%
- 1-hour windows: slight edge possible from momentum — confidence 50-65%
- Daily windows: more signal available — confidence 50-75%
- High volatility regimes = LOWER confidence, not higher
- Displacement (current vs open price) is the strongest short-term signal
- Volume spikes often precede reversals, not continuations

## SIGNAL CONFIRMATION TASK
When given mechanical signal factors to confirm/reject:
- "confirm": true if the signal factors are internally consistent
- "confirm": false if factors contradict each other or context is adverse
- Veto signals where: volatility is spiking, time remaining is very short,
  or the displacement is tiny (<0.1%) relative to noise
- confidence_adjustment: -20 to +20, usually -5 to +5

## OUTPUT FORMAT
{"confirm":true|false,"confidence_adjustment":-20 to 20,"reasoning":"1-2 sentences"}`

// ─── Types ─────────────────────────────────────────────

interface SyntheticMarket {
  question: string
  resolvedOutcome: 'Yes' | 'No'
  outcomePrices: [number, number]
}

interface ChatMLEntry {
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>
}

interface TrainingStats {
  total: number
  confirms: number
  vetoes: number
  directions: number
  byDuration: Record<string, number>
  avgDisplacement: number
  avgConfidence: number
}

// ─── Synthetic Market Generator ────────────────────────

function generateSyntheticMarkets(count: number): SyntheticMarket[] {
  const markets: SyntheticMarket[] = []
  // Weighted toward 1h (our primary trading duration), with all durations represented
  const durations = ['5m', '5m', '15m', '15m', '15m', '1h', '1h', '1h', '1h', '1h', '4h', '4h', '4h', '24h', '24h']
  const btcPriceRange = [60000, 110000]

  for (let i = 0; i < count; i++) {
    const duration = durations[Math.floor(Math.random() * durations.length)]
    const btcStart = btcPriceRange[0] + Math.random() * (btcPriceRange[1] - btcPriceRange[0])

    const volByDuration: Record<string, number> = {
      '5m': 0.002, '15m': 0.004, '1h': 0.008, '4h': 0.015, '24h': 0.025,
    }
    const vol = volByDuration[duration] || 0.008
    const move = (Math.random() - 0.5) * 2 * vol * btcStart * 3
    const btcEnd = btcStart + move
    const winner = btcEnd >= btcStart ? 'up' : 'down'

    const impliedUp = winner === 'up'
      ? 0.45 + Math.random() * 0.20
      : 0.30 + Math.random() * 0.25

    const hour = Math.floor(Math.random() * 24)
    const month = ['January', 'February', 'March'][Math.floor(Math.random() * 3)]
    const day = 1 + Math.floor(Math.random() * 28)

    const questions: Record<string, string[]> = {
      '5m': [
        `Will BTC go up or down in the next 5 minutes? (${month} ${day}, ${hour}:00 UTC)`,
        `BTC 5-minute: Will Bitcoin be above $${btcStart.toFixed(0)} at ${hour}:05 UTC?`,
      ],
      '15m': [
        `Will BTC go up or down in the next 15 minutes? (${month} ${day}, ${hour}:00 UTC)`,
        `BTC 15-minute: Will Bitcoin be above $${btcStart.toFixed(0)} at ${hour}:15 UTC?`,
      ],
      '1h': [
        `Will BTC go up or down in the next 1 hour? (${month} ${day}, ${hour}:00 UTC)`,
        `BTC 1-hour: Will Bitcoin be above $${btcStart.toFixed(0)} at ${(hour + 1) % 24}:00 UTC?`,
        `Will the price of BTC be higher at ${(hour + 1) % 24}:00 UTC on ${month} ${day}?`,
      ],
      '4h': [
        `Will BTC go up or down in the next 4 hours? (${month} ${day}, ${hour}:00 UTC)`,
        `BTC 4-hour: Will Bitcoin be above $${btcStart.toFixed(0)} at ${(hour + 4) % 24}:00 UTC?`,
      ],
      '24h': [
        `Will BTC be higher or lower at midnight UTC on ${month} ${day + 1}?`,
        `Bitcoin daily: Will BTC close above $${btcStart.toFixed(0)} on ${month} ${day}?`,
      ],
    }

    const qList = questions[duration] || questions['1h']

    markets.push({
      question: qList[Math.floor(Math.random() * qList.length)],
      resolvedOutcome: winner === 'up' ? 'Yes' : 'No',
      outcomePrices: [impliedUp, 1 - impliedUp],
    })
  }

  return markets
}

// ─── Synthetic Signal Generator ────────────────────────

function generateSyntheticSignal(market: SyntheticMarket): {
  prompt: string
  response: string
  duration: string
  displacement: number
  confidence: number
  isConfirm: boolean
} | null {
  const resolved = market.resolvedOutcome.toLowerCase()
  if (resolved !== 'yes' && resolved !== 'no') return null

  const actualDirection: 'up' | 'down' = resolved === 'yes' ? 'up' : 'down'
  const duration = detectDuration(market.question)
  const windowMs = durationToMs(duration)

  const displacement = generateDisplacement(actualDirection, duration)
  const timeIntoWindow = 0.3 + Math.random() * 0.5
  const timeRemainingMin = Math.round((1 - timeIntoWindow) * windowMs / 60_000)

  const factors = generateFactors(actualDirection, displacement, duration)

  const mechanicalDirection = factors.netSignal > 0 ? 'up' : 'down'
  const mechanicalConfidence = Math.min(95, Math.max(20, Math.abs(factors.netSignal) * 100))
  const isCorrectDirection = mechanicalDirection === actualDirection

  // ~30% of the time, even correct-direction signals should be vetoed
  // (teaches model to recognize weak/fragile signals)
  const isWeakSignal = mechanicalConfidence < 45 || Math.abs(displacement) < 0.1
  const shouldConfirm = isCorrectDirection && mechanicalConfidence >= 35 && !isWeakSignal && Math.random() > 0.15
  const adjustment = shouldConfirm
    ? Math.round((Math.random() * 10) - 2)
    : Math.round(-5 - Math.random() * 10)

  const btcPrice = 80000 + Math.random() * 30000
  const windowOpenPrice = btcPrice / (1 + displacement / 100)
  const [upPrice, downPrice] = market.outcomePrices

  const vol24h = 10 + Math.random() * 90
  const range24h = 1 + Math.random() * 6
  const change24h = -3 + Math.random() * 6

  const prompt = buildPrompt({
    question: market.question,
    asset: 'BTC',
    duration,
    timeRemainingMin,
    btcPrice,
    windowOpenPrice,
    displacement,
    upPrice,
    downPrice,
    vol24h,
    range24h,
    change24h,
    factors,
    mechanicalDirection,
    mechanicalConfidence,
  })

  const response = JSON.stringify({
    confirm: shouldConfirm,
    confidence_adjustment: adjustment,
    reasoning: shouldConfirm
      ? generateConfirmReasoning(factors, displacement, duration, timeRemainingMin)
      : generateVetoReasoning(factors, displacement, duration, timeRemainingMin),
  })

  return { prompt, response, duration, displacement, confidence: mechanicalConfidence, isConfirm: shouldConfirm }
}

// ─── Prompt Builder (matches BtcUpDownStrategy.llmConfirmation exactly) ───

function buildPrompt(p: {
  question: string; asset: string; duration: string; timeRemainingMin: number
  btcPrice: number; windowOpenPrice: number; displacement: number
  upPrice: number; downPrice: number; vol24h: number; range24h: number; change24h: number
  factors: ReturnType<typeof generateFactors>
  mechanicalDirection: string; mechanicalConfidence: number
}): string {
  const f = p.factors
  return `You are confirming a mechanical trading signal for a Polymarket crypto up/down binary market.

MARKET: "${p.question}"
ASSET: ${p.asset}
WINDOW: ${p.duration} (${p.timeRemainingMin} min remaining)

PRICE DATA:
- Current ${p.asset} price: $${p.btcPrice.toFixed(2)}
- Window open price: $${p.windowOpenPrice.toFixed(2)}
- Displacement: ${p.displacement.toFixed(3)}%
- Up outcome price: ${Math.round(p.upPrice * 100)}c
- Down outcome price: ${Math.round(p.downPrice * 100)}c

24H MARKET DATA (BinanceWS):
- ${p.asset} price: $${p.btcPrice.toLocaleString()} | 24h change: ${p.change24h > 0 ? '+' : ''}${p.change24h.toFixed(1)}%
- 24h range: $${(p.btcPrice * (1 - p.range24h / 200)).toFixed(0)} – $${(p.btcPrice * (1 + p.range24h / 200)).toFixed(0)} (${p.range24h.toFixed(1)}%)
- 24h volume: $${p.vol24h.toFixed(2)}B

SIGNAL FACTORS (individual scores):
- Momentum (25%): ${(f.momentum * 100).toFixed(0)}% — vol-normalized z-score of displacement
- Velocity (25%): ${(f.velocity * 100).toFixed(0)}% — linear regression slope of recent prices
- Time Decay (20%): ${(f.timeDecay * 100).toFixed(0)}% — direction consistency × elapsed time
- Value Bet (15%): ${(f.valueBet * 100).toFixed(0)}% — how cheap the target outcome is
- Order Flow (15%): ${(f.orderFlow * 100).toFixed(0)}% — bid/ask imbalance
- Regime: ${f.regime} (ST=${f.regimeEfficiency.toFixed(3)}, LT=${f.regimeEfficiencyLongTerm.toFixed(3)}) | RSI: ${f.rsi.toFixed(0)} | Volatility: ${(f.volatility * 100).toFixed(3)}%

MECHANICAL SIGNAL:
- Direction: ${p.mechanicalDirection.toUpperCase()}
- Composite confidence: ${p.mechanicalConfidence.toFixed(0)}%

TASK: Should this trade be placed? Consider:
1. Is the ${p.displacement.toFixed(3)}% displacement likely to hold for ${p.timeRemainingMin} more minutes?
2. Do the individual factor scores support the composite confidence, or is one factor dominating?
3. Does the 24h market context (trend, volume, volatility) support the signal direction?
4. Is the outcome pricing fair given the displacement and time remaining?

Respond ONLY with JSON:
{"confirm":true/false,"confidence_adjustment":-20 to +20,"reasoning":"1-2 sentences"}`
}

// ─── Factor Generation (realistic correlated noise) ────

function generateFactors(actualDirection: 'up' | 'down', displacement: number, duration: string) {
  const dirSign = actualDirection === 'up' ? 1 : -1
  const noise = () => (Math.random() - 0.5) * 0.3

  const dispStrength = Math.min(1, Math.abs(displacement) / 2)
  const agreement = 0.3 + dispStrength * 0.5

  const momentum = clamp(dirSign * agreement + noise(), -1, 1)
  const velocity = clamp(dirSign * (agreement * 0.9) + noise(), -1, 1)
  const timeDecay = clamp(0.3 + Math.random() * 0.5, 0, 1)
  const valueBet = clamp(0.2 + Math.random() * 0.6, 0, 1)
  const orderFlow = clamp(dirSign * (agreement * 0.7) + noise(), -1, 1)

  const regimeEfficiency = 0.2 + Math.random() * 0.6
  const regime = regimeEfficiency > 0.5 ? 'trending' : regimeEfficiency < 0.3 ? 'choppy' : 'neutral'

  const rsi = actualDirection === 'up' ? 40 + Math.random() * 25 : 35 + Math.random() * 25

  const volMap: Record<string, [number, number]> = {
    '5m': [0.002, 0.005], '15m': [0.003, 0.008], '1h': [0.005, 0.015],
    '4h': [0.008, 0.023], '24h': [0.010, 0.030],
  }
  const [vLo, vHi] = volMap[duration] || [0.005, 0.015]
  const volatility = vLo + Math.random() * (vHi - vLo)

  const netSignal = momentum * 0.25 + velocity * 0.25 + timeDecay * 0.20 * dirSign +
    valueBet * 0.15 * dirSign + orderFlow * 0.15

  return {
    momentum, velocity, timeDecay, valueBet, orderFlow,
    regime, regimeEfficiency, regimeEfficiencyLongTerm: regimeEfficiency + (Math.random() - 0.5) * 0.1,
    rsi, volatility, netSignal,
  }
}

function generateDisplacement(direction: 'up' | 'down', duration: string): number {
  const baseRange: Record<string, [number, number]> = {
    '5m': [0.01, 0.3], '15m': [0.02, 0.6], '1h': [0.05, 1.5],
    '4h': [0.1, 3.0], '24h': [0.2, 5.0],
  }
  const [min, max] = baseRange[duration] || [0.05, 1.5]
  const magnitude = min + Math.random() * (max - min)
  return direction === 'up' ? magnitude : -magnitude
}

// ─── Reasoning generators ──────────────────────────────

function generateConfirmReasoning(
  factors: ReturnType<typeof generateFactors>, displacement: number,
  duration: string, timeRemaining: number,
): string {
  const templates = [
    `${Math.abs(displacement).toFixed(2)}% displacement with ${timeRemaining}min remaining is significant for a ${duration} window. Momentum and velocity align.`,
    `Factors are internally consistent — momentum ${(factors.momentum * 100).toFixed(0)}% and velocity ${(factors.velocity * 100).toFixed(0)}% agree on direction. ${factors.regime} regime supports continuation.`,
    `Strong directional signal with ${Math.abs(displacement).toFixed(2)}% displacement. RSI at ${factors.rsi.toFixed(0)} — not overbought. Time decay favors holding.`,
    `Order flow and momentum both support the signal direction. ${timeRemaining}min remaining provides adequate time for ${duration} window resolution.`,
    `Displacement is well above noise threshold for ${duration} window. Value bet component suggests outcome is still underpriced.`,
    `${factors.regime} market regime with efficiency ${factors.regimeEfficiency.toFixed(2)} supports directional trading. Signal factors are aligned.`,
  ]
  return templates[Math.floor(Math.random() * templates.length)]
}

function generateVetoReasoning(
  factors: ReturnType<typeof generateFactors>, displacement: number,
  duration: string, timeRemaining: number,
): string {
  const templates = [
    `${Math.abs(displacement).toFixed(2)}% displacement is too small relative to ${duration} window noise — likely to mean-revert.`,
    `Signal factors contradict each other — momentum says ${factors.momentum > 0 ? 'up' : 'down'} but order flow disagrees at ${(factors.orderFlow * 100).toFixed(0)}%.`,
    `Only ${timeRemaining}min remaining in ${duration} window — displacement could easily reverse. High volatility (${(factors.volatility * 100).toFixed(2)}%) adds risk.`,
    `RSI at ${factors.rsi.toFixed(0)} suggests ${factors.rsi > 65 ? 'overbought' : factors.rsi < 35 ? 'oversold' : 'neutral'} conditions — displacement may not hold.`,
    `Choppy regime (efficiency ${factors.regimeEfficiency.toFixed(2)}) undermines directional confidence. Displacement is marginal for ${duration} window.`,
    `Factor scores are dominated by a single component — composite confidence is fragile. Low conviction trade.`,
  ]
  return templates[Math.floor(Math.random() * templates.length)]
}

// ─── Direction prediction training pairs ───────────────

function generateDirectionTrainingPair(market: SyntheticMarket): ChatMLEntry | null {
  const resolved = market.resolvedOutcome.toLowerCase()
  if (resolved !== 'yes' && resolved !== 'no') return null

  const direction = resolved === 'yes' ? 'up' : 'down'
  const duration = detectDuration(market.question)
  const displacement = generateDisplacement(direction as 'up' | 'down', duration)
  const btcPrice = 80000 + Math.random() * 30000

  const baseConf: Record<string, [number, number]> = {
    '5m': [48, 58], '15m': [50, 60], '1h': [52, 65], '4h': [55, 72], '24h': [55, 75],
  }
  const [lo, hi] = baseConf[duration] || [50, 65]
  const confidence = Math.round(lo + Math.random() * (hi - lo))

  const prompt = `Predict this market outcome. Respond ONLY with JSON.

Q: "${market.question}"
- Yes: ${Math.round((0.45 + Math.random() * 0.10) * 100)}%
- No: ${Math.round((0.45 + Math.random() * 0.10) * 100)}%
- BTC Price: $${btcPrice.toFixed(0)} (displacement: ${displacement > 0 ? '+' : ''}${displacement.toFixed(2)}%)
- Window: ${duration}, Vol: $${(10 + Math.random() * 90).toFixed(1)}B

{"direction":"up|down","confidence":0-100,"reasoning":"1 sentence"}`

  const response = JSON.stringify({
    direction,
    confidence,
    reasoning: direction === 'up'
      ? `BTC displaced +${Math.abs(displacement).toFixed(2)}% above open — momentum favors upside continuation in ${duration} window.`
      : `BTC displaced -${Math.abs(displacement).toFixed(2)}% below open — downside pressure likely to persist through ${duration} resolution.`,
  })

  return {
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: prompt },
      { role: 'assistant', content: response },
    ],
  }
}

// ─── Helpers ───────────────────────────────────────────

function detectDuration(question: string): string {
  // Order matters: check longer patterns first to avoid partial matches
  if (/15.?min/i.test(question)) return '15m'
  if (/\b5.?min/i.test(question)) return '5m'  // \b prevents "15 min" matching
  if (/24.?h|daily|day|midnight|9.*pm/i.test(question)) return '24h'
  if (/4.?h|4 hours/i.test(question)) return '4h'
  if (/1.?h|\b1 hour\b/i.test(question)) return '1h'
  return '1h'
}

function durationToMs(d: string): number {
  const map: Record<string, number> = {
    '5m': 5 * 60_000, '15m': 15 * 60_000, '1h': 60 * 60_000,
    '4h': 4 * 60 * 60_000, '24h': 24 * 60 * 60_000,
  }
  return map[d] || 60 * 60_000
}

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v))
}

// ─── Main ──────────────────────────────────────────────

function main() {
  const args = process.argv.slice(2)
  const countIdx = args.indexOf('--count')
  const count = countIdx >= 0 ? parseInt(args[countIdx + 1]) : 300
  const outputIdx = args.indexOf('--output')
  const outputFile = outputIdx >= 0 ? args[outputIdx + 1] : `polytrader-training-${new Date().toISOString().slice(0, 10)}.jsonl`

  console.log(`\nPolytrader Synthetic Training Data Generator`)
  console.log(`  Generating ${count} synthetic BTC markets -> training pairs`)
  console.log(`  Output: ${outputFile}\n`)

  // Step 1: Generate synthetic markets with known outcomes
  const markets = generateSyntheticMarkets(count)
  console.log(`Generated ${markets.length} synthetic BTC Up/Down markets`)

  // Step 2: Build training pairs
  const entries: ChatMLEntry[] = []
  const stats: TrainingStats = {
    total: 0, confirms: 0, vetoes: 0, directions: 0,
    byDuration: {}, avgDisplacement: 0, avgConfidence: 0,
  }
  let totalDisplacement = 0
  let totalConfidence = 0

  for (const market of markets) {
    // 2-3 signal confirmation variations per market (different time/factor snapshots)
    const variations = 2 + Math.floor(Math.random() * 2)
    for (let v = 0; v < variations; v++) {
      const result = generateSyntheticSignal(market)
      if (!result) continue

      entries.push({
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: result.prompt },
          { role: 'assistant', content: result.response },
        ],
      })

      stats.total++
      if (result.isConfirm) stats.confirms++
      else stats.vetoes++
      stats.byDuration[result.duration] = (stats.byDuration[result.duration] || 0) + 1
      totalDisplacement += Math.abs(result.displacement)
      totalConfidence += result.confidence
    }

    // 1 direction prediction pair per market
    const dirPair = generateDirectionTrainingPair(market)
    if (dirPair) {
      entries.push(dirPair)
      stats.total++
      stats.directions++
    }
  }

  const confirmCount = stats.confirms + stats.vetoes
  stats.avgDisplacement = confirmCount > 0 ? totalDisplacement / confirmCount : 0
  stats.avgConfidence = confirmCount > 0 ? totalConfidence / confirmCount : 0

  // Step 3: Shuffle (avoid temporal clustering during training)
  for (let i = entries.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[entries[i], entries[j]] = [entries[j], entries[i]]
  }

  // Step 4: Write JSONL
  const jsonl = entries.map(e => JSON.stringify(e)).join('\n')
  const outputPath = resolve(process.cwd(), outputFile)
  writeFileSync(outputPath, jsonl + '\n')

  // Step 5: Report
  const sizeKB = (Buffer.byteLength(jsonl) / 1024).toFixed(1)
  console.log(`\nGenerated ${stats.total} training pairs:`)
  console.log(`  Signal confirmations: ${stats.confirms} confirms / ${stats.vetoes} vetoes (${confirmCount > 0 ? (stats.confirms / confirmCount * 100).toFixed(0) : 0}% confirm rate)`)
  console.log(`  Direction predictions: ${stats.directions}`)
  console.log(`  By duration: ${Object.entries(stats.byDuration).map(([k, v]) => `${k}=${v}`).join(', ')}`)
  console.log(`  Avg displacement: ${stats.avgDisplacement.toFixed(3)}%`)
  console.log(`  Avg mechanical confidence: ${stats.avgConfidence.toFixed(0)}%`)
  console.log(`\nWritten to: ${outputPath} (${sizeKB} KB)`)
  console.log(`\nNext steps:`)
  console.log(`  1. Run the full MLX fine-tuning pipeline:`)
  console.log(`     bash scripts/finetune.sh`)
  console.log(`  2. Or step-by-step:`)
  console.log(`     python3 scripts/prepare-training-data.py --input ${outputFile}`)
  console.log(`     python3 scripts/finetune-mlx.py`)
  console.log(`     bash scripts/export-to-ollama.sh`)
}

main()
