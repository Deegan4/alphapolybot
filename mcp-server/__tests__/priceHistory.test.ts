import { describe, it, expect } from 'vitest';
import {
  buildPriceHistoryQuery,
  normalizePriceHistory,
  toUnixSeconds,
  INTERVAL_FIDELITY,
} from '../src/utils/priceHistory.js';

describe('toUnixSeconds', () => {
  it('accepts seconds, milliseconds and ISO strings', () => {
    expect(toUnixSeconds(1_700_000_000)).toBe(1_700_000_000);
    expect(toUnixSeconds(1_700_000_000_123)).toBe(1_700_000_000);
    expect(toUnixSeconds('1700000000')).toBe(1_700_000_000);
    expect(toUnixSeconds('2023-11-14T22:13:20Z')).toBe(1_700_000_000);
  });
  it('rejects garbage', () => {
    expect(() => toUnixSeconds('yesterday')).toThrow(/invalid timestamp/);
    expect(() => toUnixSeconds(NaN)).toThrow();
  });
});

describe('buildPriceHistoryQuery', () => {
  it('defaults to INTERVAL_1D with its documented fidelity', () => {
    expect(buildPriceHistoryQuery({ market_slug: 'm' })).toEqual({ symbol: 'm', fixedInterval: 'INTERVAL_1D', fidelity: 5 });
  });

  it('uses the documented fidelity for every fixed interval', () => {
    for (const [interval, fidelity] of Object.entries(INTERVAL_FIDELITY)) {
      const q = buildPriceHistoryQuery({ market_slug: 'm', interval: interval as keyof typeof INTERVAL_FIDELITY });
      expect(q).toEqual({ symbol: 'm', fixedInterval: interval, fidelity });
    }
  });

  it('builds a custom range with fidelity 1 and dotted timestamp params', () => {
    const q = buildPriceHistoryQuery({ market_slug: 'm', start_time: 1_700_000_000, end_time: '2023-11-14T23:13:20Z' });
    expect(q).toEqual({
      symbol: 'm',
      'timestamp.startTimestamp': 1_700_000_000,
      'timestamp.endTimestamp': 1_700_003_600,
      fidelity: 1,
    });
  });

  it('rejects invalid combinations', () => {
    expect(() => buildPriceHistoryQuery({ market_slug: '' })).toThrow(/market_slug/);
    expect(() => buildPriceHistoryQuery({ market_slug: 'm', start_time: 1 })).toThrow(/both/);
    expect(() => buildPriceHistoryQuery({ market_slug: 'm', interval: 'INTERVAL_1H', start_time: 1, end_time: 2 })).toThrow(/cannot be combined/);
    expect(() => buildPriceHistoryQuery({ market_slug: 'm', start_time: 10, end_time: 5 })).toThrow(/after/);
    expect(() => buildPriceHistoryQuery({ market_slug: 'm', start_time: 0, end_time: 25 * 3600 })).toThrow(/24 hours/);
  });
});

describe('normalizePriceHistory', () => {
  const history = [
    { timestamp: 1_700_000_120, longPrice: 0.58, shortPrice: 0.44 },
    { timestamp: 1_700_000_000, longPrice: 0.55, shortPrice: 0.47 },
    { timestamp: 1_700_000_060, longPrice: 0.5, shortPrice: 0.52 },
    { timestamp: NaN, longPrice: 0.9, shortPrice: 0.1 },
  ];

  it('sorts, converts and summarizes points', () => {
    const { summary, points } = normalizePriceHistory({ history });
    expect(points.map(p => p.yes)).toEqual([0.55, 0.5, 0.58]);
    expect(points[0]).toEqual({ time: '2023-11-14T22:13:20.000Z', yes: 0.55, no: 0.47, implied_spread: 0.02 });
    expect(summary).toEqual({
      points: 3,
      returned: 3,
      from: '2023-11-14T22:13:20.000Z',
      to: '2023-11-14T22:15:20.000Z',
      yes_first: 0.55,
      yes_last: 0.58,
      yes_change: 0.03,
      yes_min: 0.5,
      yes_max: 0.58,
    });
  });

  it('down-samples long series keeping the endpoints', () => {
    const long = Array.from({ length: 1000 }, (_, i) => ({ timestamp: 1_700_000_000 + i * 60, longPrice: 0.5 + i / 10000, shortPrice: 0.5 }));
    const { summary, points } = normalizePriceHistory({ history: long }, 100);
    expect(summary.points).toBe(1000);
    expect(summary.returned).toBe(100);
    expect(points[0].time).toBe(new Date(1_700_000_000 * 1000).toISOString());
    expect(points[99].time).toBe(new Date((1_700_000_000 + 999 * 60) * 1000).toISOString());
  });

  it('handles an empty history', () => {
    expect(normalizePriceHistory({})).toEqual({ summary: { points: 0, returned: 0 }, points: [] });
  });
});
