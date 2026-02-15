/**
 * Analysis tools — Kelly sizing and opportunity scoring.
 * Pure math, no API calls.
 */

import { z } from 'zod';

// ─── Schemas ─────────────────────────────────────────────────

export const computeKellySchema = {
  model_prob: z.number().min(0.01).max(0.99).describe(
    'Your estimated true probability of the outcome (0.01-0.99)',
  ),
  market_price: z.number().min(0.01).max(0.99).describe(
    'Current market price for the outcome (0.01-0.99)',
  ),
  fee_rate_bps: z.number().optional().default(0).describe(
    'Taker fee in basis points (100 = 1%, 1000 = 10% for 15-min crypto)',
  ),
  bankroll: z.number().min(0).describe('Available USDC.e balance'),
  kelly_fraction: z.number().optional().default(0.25).describe(
    'Fraction of Kelly to use (0.25 = quarter Kelly, conservative default)',
  ),
};

export const scoreOpportunitiesSchema = {
  markets: z.array(z.object({
    id: z.string(),
    question: z.string(),
    prices: z.array(z.number()),
    volume24hr: z.number().optional(),
    liquidity: z.number(),
    spread: z.number().optional(),
  })).describe('Markets to score and rank'),
};

// ─── Handlers ────────────────────────────────────────────────

export interface KellyResult {
  full_kelly: number;
  fractional_kelly: number;
  bet_size_usd: number;
  edge_percent: number;
  odds: number;
  effective_payout: number;
  profitable: boolean;
}

export function handleComputeKelly(args: {
  model_prob: number;
  market_price: number;
  fee_rate_bps?: number;
  bankroll: number;
  kelly_fraction?: number;
}): KellyResult {
  const { model_prob, market_price, bankroll } = args;
  const feeRateBps = args.fee_rate_bps ?? 0;
  const kellyFraction = args.kelly_fraction ?? 0.25;

  // Effective payout after fees: buying at `market_price`, payout = 1 - fee
  const effectivePayout = 1.0 - feeRateBps / 10_000;

  // No possible profit if effective payout ≤ price
  if (effectivePayout <= market_price) {
    return {
      full_kelly: 0,
      fractional_kelly: 0,
      bet_size_usd: 0,
      edge_percent: ((model_prob - market_price) / market_price) * 100,
      odds: market_price > 0 ? (1 - market_price) / market_price : 0,
      effective_payout: effectivePayout,
      profitable: false,
    };
  }

  // Odds: how much you profit per dollar risked if you win
  const b = (effectivePayout - market_price) / market_price;
  const q = 1 - model_prob;

  // Full Kelly: f* = (b·p - q) / b
  const fullKelly = Math.max(0, (b * model_prob - q) / b);

  // Fractional Kelly with concentration cap
  const maxConcentration = 0.20;
  let betSize = fullKelly * kellyFraction * bankroll;
  betSize = Math.min(betSize, bankroll * maxConcentration);
  betSize = Math.max(betSize, 0);
  betSize = Math.round(betSize * 100) / 100;

  // Edge: how much better our estimate is vs market
  const edgePercent = ((model_prob - market_price) / market_price) * 100;

  return {
    full_kelly: Math.round(fullKelly * 10000) / 10000,
    fractional_kelly: Math.round(fullKelly * kellyFraction * 10000) / 10000,
    bet_size_usd: betSize,
    edge_percent: Math.round(edgePercent * 100) / 100,
    odds: Math.round(b * 1000) / 1000,
    effective_payout: effectivePayout,
    profitable: fullKelly > 0,
  };
}

export interface ScoredMarket {
  id: string;
  question: string;
  score: number;
  spread: number;
  askSum: number;
  volume24hr: number;
  liquidity: number;
  reason: string;
}

export function handleScoreOpportunities(args: {
  markets: Array<{
    id: string;
    question: string;
    prices: number[];
    volume24hr?: number;
    liquidity: number;
    spread?: number;
  }>;
}): { ranked: ScoredMarket[] } {
  const scored: ScoredMarket[] = [];

  for (const m of args.markets) {
    // Only score binary markets
    if (m.prices.length !== 2) continue;

    const askSum = m.prices[0] + m.prices[1];
    const spread = m.spread ?? Math.abs(1 - askSum);
    const vol = m.volume24hr ?? 0;
    const liq = m.liquidity;

    // Composite score: incoherence opportunity + liquidity + volume
    // Lower ask sum = more opportunity (but typically 1.005-1.02)
    const incoherenceScore = askSum < 1.005 ? 40 : askSum < 1.01 ? 30 : askSum < 1.02 ? 20 : 10;
    const volumeScore = Math.min(vol / 10000, 30); // Up to 30 points for $300K+ volume
    const liquidityScore = Math.min(liq / 5000, 20); // Up to 20 points for $100K+ liq
    const spreadScore = spread < 0.01 ? 10 : spread < 0.02 ? 5 : 0; // Tight spread bonus

    const score = Math.round(incoherenceScore + volumeScore + liquidityScore + spreadScore);

    let reason = '';
    if (askSum < 1.005) reason = 'Very tight spread — potential arb';
    else if (askSum < 1.01) reason = 'Tight spread — good execution';
    else if (vol > 50000) reason = 'High volume — active market';
    else if (liq > 20000) reason = 'Deep liquidity';
    else reason = 'Standard market';

    scored.push({
      id: m.id,
      question: m.question,
      score,
      spread,
      askSum: Math.round(askSum * 10000) / 10000,
      volume24hr: vol,
      liquidity: liq,
      reason,
    });
  }

  // Sort by score descending
  scored.sort((a, b) => b.score - a.score);

  return { ranked: scored.slice(0, 20) };
}
