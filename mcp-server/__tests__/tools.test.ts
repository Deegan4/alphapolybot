import { describe, it, expect } from 'vitest';
import { handleComputeKelly, handleScoreOpportunities } from '../src/tools/analysis.js';

describe('handleComputeKelly', () => {
  it('returns profitable result when model_prob > market_price', () => {
    const result = handleComputeKelly({
      model_prob: 0.60,
      market_price: 0.50,
      bankroll: 100,
      kelly_fraction: 0.25,
    });

    expect(result.profitable).toBe(true);
    expect(result.full_kelly).toBeGreaterThan(0);
    expect(result.fractional_kelly).toBeGreaterThan(0);
    expect(result.bet_size_usd).toBeGreaterThan(0);
    expect(result.edge_percent).toBeGreaterThan(0);
  });

  it('returns zero when no edge', () => {
    const result = handleComputeKelly({
      model_prob: 0.40,
      market_price: 0.50,
      bankroll: 100,
    });

    expect(result.profitable).toBe(false);
    expect(result.full_kelly).toBe(0);
    expect(result.bet_size_usd).toBe(0);
    expect(result.edge_percent).toBeLessThan(0);
  });

  it('accounts for fee rate reducing profitability', () => {
    // Without fees: profitable
    const noFee = handleComputeKelly({
      model_prob: 0.55,
      market_price: 0.50,
      bankroll: 100,
      fee_rate_bps: 0,
    });

    // With high fees: less profitable or unprofitable
    const highFee = handleComputeKelly({
      model_prob: 0.55,
      market_price: 0.50,
      bankroll: 100,
      fee_rate_bps: 1000, // 10% fee (15-min crypto)
    });

    expect(noFee.profitable).toBe(true);
    expect(highFee.bet_size_usd).toBeLessThan(noFee.bet_size_usd);
  });

  it('extreme 10% fee makes effective_payout <= price unprofitable', () => {
    const result = handleComputeKelly({
      model_prob: 0.95,
      market_price: 0.92,
      bankroll: 100,
      fee_rate_bps: 1000, // effective payout = 0.90, price = 0.92 → impossible
    });

    expect(result.profitable).toBe(false);
    expect(result.effective_payout).toBe(0.9);
  });

  it('caps bet at 20% concentration limit', () => {
    const result = handleComputeKelly({
      model_prob: 0.90,
      market_price: 0.50,
      bankroll: 100,
      kelly_fraction: 1.0, // full Kelly — would be huge
    });

    expect(result.bet_size_usd).toBeLessThanOrEqual(20); // 20% of $100
  });

  it('uses quarter-Kelly default', () => {
    const quarter = handleComputeKelly({
      model_prob: 0.70,
      market_price: 0.50,
      bankroll: 100,
    });

    const full = handleComputeKelly({
      model_prob: 0.70,
      market_price: 0.50,
      bankroll: 100,
      kelly_fraction: 1.0,
    });

    // Quarter Kelly should have lower fractional_kelly
    expect(quarter.fractional_kelly).toBeLessThan(full.fractional_kelly);
  });

  it('returns correct effective_payout', () => {
    const result = handleComputeKelly({
      model_prob: 0.60,
      market_price: 0.50,
      bankroll: 100,
      fee_rate_bps: 100, // 1%
    });

    expect(result.effective_payout).toBe(0.99);
  });
});

describe('handleScoreOpportunities', () => {
  const sampleMarkets = [
    {
      id: '1',
      question: 'Market A — tight spread',
      prices: [0.502, 0.503],
      volume24hr: 50000,
      liquidity: 30000,
      spread: 0.005,
    },
    {
      id: '2',
      question: 'Market B — wide spread',
      prices: [0.51, 0.52],
      volume24hr: 5000,
      liquidity: 2000,
      spread: 0.03,
    },
    {
      id: '3',
      question: 'Market C — high volume',
      prices: [0.505, 0.510],
      volume24hr: 300000,
      liquidity: 100000,
      spread: 0.015,
    },
  ];

  it('returns markets ranked by score', () => {
    const { ranked } = handleScoreOpportunities({ markets: sampleMarkets });
    expect(ranked.length).toBe(3);
    expect(ranked[0].score).toBeGreaterThanOrEqual(ranked[1].score);
    expect(ranked[1].score).toBeGreaterThanOrEqual(ranked[2].score);
  });

  it('calculates askSum correctly', () => {
    const { ranked } = handleScoreOpportunities({ markets: sampleMarkets });
    const marketA = ranked.find((m) => m.id === '1')!;
    expect(marketA.askSum).toBeCloseTo(1.005, 3);
  });

  it('skips non-binary markets', () => {
    const markets = [
      ...sampleMarkets,
      {
        id: '4',
        question: 'Ternary market',
        prices: [0.3, 0.3, 0.4],
        liquidity: 10000,
      },
    ];

    const { ranked } = handleScoreOpportunities({ markets });
    expect(ranked.find((m) => m.id === '4')).toBeUndefined();
  });

  it('includes reason for each market', () => {
    const { ranked } = handleScoreOpportunities({ markets: sampleMarkets });
    for (const m of ranked) {
      expect(m.reason).toBeTruthy();
      expect(typeof m.reason).toBe('string');
    }
  });

  it('returns at most 20 markets', () => {
    const manyMarkets = Array.from({ length: 30 }, (_, i) => ({
      id: `${i}`,
      question: `Market ${i}`,
      prices: [0.50, 0.51],
      liquidity: 5000,
    }));

    const { ranked } = handleScoreOpportunities({ markets: manyMarkets });
    expect(ranked.length).toBeLessThanOrEqual(20);
  });
});
