import { describe, it, expect, vi, beforeEach } from 'vitest';

const bbo = vi.fn();
const list = vi.fn();

vi.mock('../src/clients/polymarket-us.js', () => ({
  getPublicSdk: () => ({ markets: { bbo }, events: { list }, search: { query: vi.fn() } }),
  errorMessage: (e: unknown) => String(e),
  mapLimit: async <T, R>(items: T[], _n: number, fn: (x: T) => Promise<R>) =>
    Promise.all(items.map(x => fn(x).catch(() => null))),
}));

import { handleGetMarkets, clearStatsCache } from '../src/tools/markets.js';

const market = (i: number) => ({
  slug: `m${i}`,
  question: `Market ${i}`,
  active: true,
  closed: false,
  bestBidQuote: { value: '0.50', currency: 'USD' },
  bestAskQuote: { value: (0.51 + i * 0.01).toFixed(2), currency: 'USD' }, // m0 tightest
});

describe('get_markets stats lookups', () => {
  beforeEach(() => {
    clearStatsCache();
    bbo.mockReset();
    list.mockReset();
    list.mockResolvedValue({ events: [{ slug: 'ev', title: 'Event', markets: Array.from({ length: 40 }, (_, i) => market(i)) }] });
    bbo.mockImplementation(async (slug: string) => ({
      marketData: {
        marketSlug: slug,
        bestBid: { value: '0.50', currency: 'USD' },
        bestAsk: { value: '0.52', currency: 'USD' },
        lastTradePx: { value: '0.51', currency: 'USD' },
        sharesTraded: '1000',
        openInterest: '2000',
      },
    }));
  });

  it('looks up about twice the requested markets, tightest first, and caches the stats', async () => {
    const first = await handleGetMarkets({ status: 'active', limit: 5, sort: 'volume', include_prices: true });
    expect('markets' in first && first.count).toBe(5);
    expect(bbo).toHaveBeenCalledTimes(10); // max(10, 5 × 2), not one per market
    expect(bbo.mock.calls.map(c => c[0])).toContain('m0');
    expect(bbo.mock.calls.map(c => c[0])).not.toContain('m39');

    bbo.mockClear();
    const second = await handleGetMarkets({ status: 'active', limit: 5, sort: 'volume', include_prices: true });
    // the 10 cached markets cost nothing; the next 10 uncached ones are fetched
    expect(bbo).toHaveBeenCalledTimes(10);
    expect(bbo.mock.calls.map(c => c[0])).not.toContain('m0');
    expect('markets' in second && second.markets.every(m => m.volume > 0)).toBe(true);
  });

  it('makes no quote calls when prices are not wanted', async () => {
    await handleGetMarkets({ status: 'active', limit: 5, sort: 'volume', include_prices: false });
    expect(bbo).not.toHaveBeenCalled();
  });

  it('sorted by end time, fetches stats only for the rows it returns', async () => {
    await handleGetMarkets({ status: 'active', limit: 3, sort: 'end_time', include_prices: true });
    expect(bbo).toHaveBeenCalledTimes(3);
  });
});
