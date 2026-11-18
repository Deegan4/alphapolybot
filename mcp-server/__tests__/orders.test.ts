import { describe, it, expect } from 'vitest';
import type { MarketBBO, MarketBook, Order, Event as USEvent } from 'polymarket-us';
import live from './fixtures/pmus-live.json';
import {
  resolveIntent,
  outcomeOfIntent,
  sideOfIntent,
  toApiPrice,
  snapPrice,
  toTimeInForce,
  buildCreateOrderParams,
  formatOrder,
  summarizeBook,
  flattenEvents,
  sortRows,
  unwrapMarketData,
  statsFromBbo,
} from '../src/utils/orders.js';

describe('intent mapping', () => {
  it('maps side+outcome to Polymarket US intents', () => {
    expect(resolveIntent('BUY', 'yes')).toBe('ORDER_INTENT_BUY_LONG');
    expect(resolveIntent('SELL', 'yes')).toBe('ORDER_INTENT_SELL_LONG');
    expect(resolveIntent('BUY', 'no')).toBe('ORDER_INTENT_BUY_SHORT');
    expect(resolveIntent('SELL', 'no')).toBe('ORDER_INTENT_SELL_SHORT');
  });

  it('round-trips intents back to side/outcome', () => {
    for (const side of ['BUY', 'SELL'] as const) {
      for (const outcome of ['yes', 'no'] as const) {
        const intent = resolveIntent(side, outcome);
        expect(sideOfIntent(intent)).toBe(side);
        expect(outcomeOfIntent(intent)).toBe(outcome);
      }
    }
  });
});

describe('prices', () => {
  it('quotes NO prices in YES terms', () => {
    expect(toApiPrice(0.55, 'yes')).toBe(0.55);
    expect(toApiPrice(0.3, 'no')).toBeCloseTo(0.7, 10);
  });

  it('snaps to 1¢ and clamps to (0, 1)', () => {
    expect(snapPrice(0.554)).toBe(0.55);
    expect(snapPrice(0.555)).toBe(0.56);
    expect(snapPrice(0.001)).toBe(0.01);
    expect(snapPrice(0.999)).toBe(0.99);
    expect(snapPrice(1.5)).toBe(0.99);
  });

  it('maps time-in-force', () => {
    expect(toTimeInForce('GTC')).toBe('TIME_IN_FORCE_GOOD_TILL_CANCEL');
    expect(toTimeInForce('GTD')).toBe('TIME_IN_FORCE_GOOD_TILL_DATE');
    expect(toTimeInForce('IOC')).toBe('TIME_IN_FORCE_IMMEDIATE_OR_CANCEL');
    expect(toTimeInForce('FOK')).toBe('TIME_IN_FORCE_FILL_OR_KILL');
  });
});

describe('buildCreateOrderParams', () => {
  const base = { marketSlug: 'chiefs-super-bowl', side: 'BUY' as const, outcome: 'yes' as const, price: 0.55, quantity: 10, tif: 'GTC' as const };

  it('builds a limit GTC buy-long order', () => {
    const { params, preview } = buildCreateOrderParams(base);
    expect(params).toMatchObject({
      marketSlug: 'chiefs-super-bowl',
      intent: 'ORDER_INTENT_BUY_LONG',
      type: 'ORDER_TYPE_LIMIT',
      price: { value: '0.55', currency: 'USD' },
      quantity: 10,
      tif: 'TIME_IN_FORCE_GOOD_TILL_CANCEL',
      manualOrderIndicator: 'MANUAL_ORDER_INDICATOR_MANUAL',
    });
    expect(params.goodTillTime).toBeUndefined();
    expect(params.participateDontInitiate).toBeUndefined();
    expect(preview.estimated_notional_usd).toBe(5.5);
    expect(preview.api_price).toBe(0.55);
  });

  it('converts a NO price to the YES-side API price', () => {
    const { params, preview } = buildCreateOrderParams({ ...base, outcome: 'no', price: 0.3 });
    expect(params.intent).toBe('ORDER_INTENT_BUY_SHORT');
    expect(params.price.value).toBe('0.70');
    expect(preview.price).toBe(0.3);
    expect(preview.api_price).toBe(0.7);
    expect(preview.estimated_notional_usd).toBe(3); // 10 shares × $0.30 NO price
  });

  it('snaps off-grid prices', () => {
    const { params } = buildCreateOrderParams({ ...base, price: 0.5549 });
    expect(params.price.value).toBe('0.55');
  });

  it('passes goodTillTime for GTD and rejects GTD without it', () => {
    const gtt = new Date(Date.now() + 60_000).toISOString();
    expect(buildCreateOrderParams({ ...base, tif: 'GTD', goodTillTime: gtt }).params.goodTillTime).toBe(gtt);
    expect(() => buildCreateOrderParams({ ...base, tif: 'GTD' })).toThrow(/good_till_time/);
    expect(() => buildCreateOrderParams({ ...base, tif: 'GTD', goodTillTime: 'not-a-date' })).toThrow(/ISO-8601/);
    expect(() => buildCreateOrderParams({ ...base, tif: 'GTD', goodTillTime: '2000-01-01T00:00:00Z' })).toThrow(/future/);
  });

  it('maps post_only to participateDontInitiate and restricts it to GTC/GTD', () => {
    expect(buildCreateOrderParams({ ...base, postOnly: true }).params.participateDontInitiate).toBe(true);
    expect(() => buildCreateOrderParams({ ...base, tif: 'FOK', postOnly: true })).toThrow(/post_only/);
  });

  it('rejects invalid price, quantity and slug', () => {
    expect(() => buildCreateOrderParams({ ...base, price: 0 })).toThrow(/price/);
    expect(() => buildCreateOrderParams({ ...base, price: 1 })).toThrow(/price/);
    expect(() => buildCreateOrderParams({ ...base, quantity: 0 })).toThrow(/quantity/);
    expect(() => buildCreateOrderParams({ ...base, quantity: NaN })).toThrow(/quantity/);
    expect(() => buildCreateOrderParams({ ...base, marketSlug: ' ' })).toThrow(/market_slug/);
  });
});

describe('formatOrder', () => {
  it('flattens an SDK order for display', () => {
    const order: Order = {
      id: 'o-1',
      marketSlug: 'chiefs-super-bowl',
      side: 'ORDER_SIDE_BUY',
      type: 'ORDER_TYPE_LIMIT',
      price: { value: '0.55', currency: 'USD' },
      quantity: 10,
      cumQuantity: 4,
      leavesQuantity: 6,
      tif: 'TIME_IN_FORCE_GOOD_TILL_CANCEL',
      intent: 'ORDER_INTENT_BUY_SHORT',
      state: 'ORDER_STATE_PARTIALLY_FILLED',
      avgPx: { value: '0.54', currency: 'USD' },
      createTime: '2026-11-01T00:00:00Z',
      marketMetadata: { slug: 'chiefs-super-bowl', title: 'Chiefs win the Super Bowl?' },
    };
    expect(formatOrder(order)).toEqual({
      id: 'o-1',
      market_slug: 'chiefs-super-bowl',
      market_title: 'Chiefs win the Super Bowl?',
      side: 'BUY',
      outcome: 'no',
      intent: 'ORDER_INTENT_BUY_SHORT',
      type: 'LIMIT',
      price: 0.55,
      quantity: 10,
      filled: 4,
      remaining: 6,
      avg_price: 0.54,
      tif: 'GOOD_TILL_CANCEL',
      good_till_time: undefined,
      state: 'PARTIALLY_FILLED',
      created_at: '2026-11-01T00:00:00Z',
    });
  });
});

describe('summarizeBook', () => {
  const book: MarketBook = {
    marketSlug: 'm',
    state: 'MARKET_STATE_OPEN',
    // Deliberately unsorted to check defensive sorting
    bids: [
      { px: { value: '0.550', currency: 'USD' }, qty: '2.50' },
      { px: { value: '0.555', currency: 'USD' }, qty: '0.50' },
    ],
    offers: [
      { px: { value: '0.565', currency: 'USD' }, qty: '1.50' },
      { px: { value: '0.560', currency: 'USD' }, qty: '0.80' },
    ],
    stats: { lastTradePx: { value: '0.55', currency: 'USD' }, sharesTraded: '150000', openInterest: '500000' },
  };

  it('computes best bid/ask, spread and depth from a book', () => {
    const s = summarizeBook(book);
    expect(s.state).toBe('OPEN');
    expect(s.best_bid).toBe(0.555);
    expect(s.best_ask).toBe(0.56);
    expect(s.mid).toBeCloseTo(0.5575, 4);
    expect(s.spread).toBeCloseTo(0.005, 4);
    expect(s.bid_depth_usd).toBeCloseTo(0.555 * 0.5 + 0.55 * 2.5, 2);
    expect(s.ask_depth_usd).toBeCloseTo(0.56 * 0.8 + 0.565 * 1.5, 2);
    expect(s.bids[0].price).toBe(0.555);
    expect(s.asks[0].price).toBe(0.56);
    expect(s.last_trade_price).toBe(0.55);
    expect(s.shares_traded).toBe(150000);
    expect(s.open_interest).toBe(500000);
  });

  it('handles an empty side', () => {
    const s = summarizeBook({ ...book, offers: [] });
    expect(s.best_ask).toBeNull();
    expect(s.mid).toBeNull();
    expect(s.spread).toBeNull();
    expect(s.ask_levels).toBe(0);
  });
});

describe('flattenEvents / sortRows', () => {
  const events: USEvent[] = [
    {
      id: 1, slug: 'super-bowl', title: 'Super Bowl winner', active: true, closed: false, archived: false, featured: true,
      liquidity: 1000, volume: 50_000, endTime: '2027-02-10T00:00:00Z',
      tags: [{ id: 1, slug: 'nfl', label: 'NFL' }],
      markets: [
        { id: 10, slug: 'chiefs-super-bowl', title: 'Chiefs', outcome: 'Chiefs', active: true, closed: false, liquidity: 600, volume: 30_000 },
        { id: 11, slug: 'eagles-super-bowl', title: 'Eagles', outcome: 'Eagles', active: true, closed: false, liquidity: 400, volume: 20_000 },
        { id: 11, slug: 'eagles-super-bowl', title: 'dupe', outcome: 'Eagles', active: true, closed: false },
      ],
    },
    {
      id: 2, slug: 'btc-100k', title: 'BTC above 100k?', active: true, closed: false, archived: false, featured: false,
      liquidity: 200, volume: 90_000, endTime: '2026-12-31T00:00:00Z',
      markets: [{ id: 20, slug: 'btc-100k', title: 'BTC above 100k?', outcome: 'Yes', active: true, closed: false }],
    },
  ];

  it('produces one row per unique market slug with event context', () => {
    const rows = flattenEvents(events);
    expect(rows.map(r => r.market_slug)).toEqual(['chiefs-super-bowl', 'eagles-super-bowl', 'btc-100k']);
    expect(rows[0]).toMatchObject({ event_slug: 'super-bowl', event_title: 'Super Bowl winner', outcome: 'Chiefs', liquidity: 600, volume: 30_000, tags: ['NFL'] });
    // Event-level totals are NOT attributed to a single market; BBO stats fill these later
    expect(rows[2]).toMatchObject({ liquidity: 0, volume: 0 });
  });

  it('sorts by volume, liquidity and end_time', () => {
    const rows = flattenEvents(events);
    expect(sortRows(rows, 'volume')[0].market_slug).toBe('chiefs-super-bowl');
    expect(sortRows(rows, 'liquidity')[0].market_slug).toBe('chiefs-super-bowl');
    expect(sortRows(rows, 'end_time')[0].market_slug).toBe('btc-100k');
  });
});

describe('live wire shapes (fixtures captured from gateway.polymarket.us)', () => {
  it('unwraps { marketData } BBO / book envelopes', () => {
    const bbo = unwrapMarketData<MarketBBO>(live.bboOpen);
    expect(bbo.marketSlug).toBe('tec-mls-winner-2026-11-07-nas');
    const book = summarizeBook(unwrapMarketData<MarketBook>(live.book));
    expect(book.best_bid).toBe(0.274);
    expect(book.best_ask).toBe(0.34);
    expect(book.state).toBe('OPEN');
  });

  it('flattens markets with no `outcome` using title and inline quotes / tick', () => {
    const rows = flattenEvents([live.eventMultiMarket as unknown as USEvent]);
    expect(rows[0]).toMatchObject({
      market_slug: 'tec-mls-winner-2026-11-07-nas',
      outcome: 'Nashville SC',
      event_slug: 'mls-winner-2026-11-07',
      best_bid: 0.274,
      best_ask: 0.34,
      mid: 0.307,
      price_tick: 0.001,
      volume: 0,
    });
  });

  it('derives USD activity proxies from a BBO', () => {
    expect(statsFromBbo(unwrapMarketData<MarketBBO>(live.bboOpen))).toEqual({
      volume: Math.round(1719969 * 0.307),
      liquidity: Math.round(36241 * 0.307),
    });
    expect(statsFromBbo(unwrapMarketData<MarketBBO>(live.bboExpired)).liquidity).toBe(0);
  });
});
