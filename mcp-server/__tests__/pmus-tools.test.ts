/**
 * Tests for PM-US tools — intent resolution, price mapping, handler logic.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { resolveIntent, toApiPrice } from '../src/clients/pmus.js';

// ─── resolveIntent ──────────────────────────────────────────

describe('resolveIntent', () => {
  it('BUY + yes = BUY_LONG', () => {
    expect(resolveIntent('BUY', 'yes')).toBe('ORDER_INTENT_BUY_LONG');
  });

  it('SELL + yes = SELL_LONG', () => {
    expect(resolveIntent('SELL', 'yes')).toBe('ORDER_INTENT_SELL_LONG');
  });

  it('BUY + no = BUY_SHORT', () => {
    expect(resolveIntent('BUY', 'no')).toBe('ORDER_INTENT_BUY_SHORT');
  });

  it('SELL + no = SELL_SHORT', () => {
    expect(resolveIntent('SELL', 'no')).toBe('ORDER_INTENT_SELL_SHORT');
  });
});

// ─── toApiPrice ─────────────────────────────────────────────

describe('toApiPrice', () => {
  it('yes outcome: price passes through', () => {
    expect(toApiPrice(0.65, 'yes')).toBe(0.65);
  });

  it('no outcome: price is complemented', () => {
    expect(toApiPrice(0.65, 'no')).toBeCloseTo(0.35, 10);
  });

  it('boundary: 0.01 yes', () => {
    expect(toApiPrice(0.01, 'yes')).toBe(0.01);
  });

  it('boundary: 0.01 no → 0.99', () => {
    expect(toApiPrice(0.01, 'no')).toBeCloseTo(0.99, 10);
  });

  it('boundary: 0.99 no → 0.01', () => {
    expect(toApiPrice(0.99, 'no')).toBeCloseTo(0.01, 10);
  });

  it('midpoint: 0.50 no → 0.50', () => {
    expect(toApiPrice(0.50, 'no')).toBeCloseTo(0.50, 10);
  });
});

// ─── Handler Logic (mocked SDK) ─────────────────────────────

// Mock the pmusClient module
vi.mock('../src/clients/pmus.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/clients/pmus.js')>();
  return {
    ...actual,
    pmusClient: {
      getSDK: vi.fn(),
      isAuthenticated: true,
      requireAuth: vi.fn(),
      searchEvents: vi.fn().mockResolvedValue({ events: [] }),
      listEvents: vi.fn().mockResolvedValue({ events: [] }),
      getOrderBook: vi.fn().mockResolvedValue({ bids: [], offers: [] }),
      getBBO: vi.fn().mockResolvedValue({ bestBid: '0.45', bestAsk: '0.55', lastTradePx: '0.50' }),
      getBalances: vi.fn().mockResolvedValue({ balance: '1000.00', buyingPower: '800.00' }),
      getPositions: vi.fn().mockResolvedValue({ positions: [] }),
      getOpenOrders: vi.fn().mockResolvedValue({ orders: [] }),
      placeOrder: vi.fn().mockResolvedValue({ id: 'order-123', status: 'submitted' }),
      previewOrder: vi.fn().mockResolvedValue({ estimatedCost: '50.00', estimatedShares: '100' }),
      cancelOrder: vi.fn().mockResolvedValue(undefined),
      getActivities: vi.fn().mockResolvedValue({ activities: [] }),
    },
  };
});

// Import handlers AFTER mock setup
import { handlePmusInstruments, handlePmusOrderBook, handlePmusSearch } from '../src/tools/pmus-markets.js';
import {
  handlePmusBalances,
  handlePmusPositions,
  handlePmusOpenOrders,
  handlePmusPlaceOrder,
  handlePmusCancelOrder,
  handlePmusTradeStats,
} from '../src/tools/pmus-trading.js';
import { pmusClient } from '../src/clients/pmus.js';

describe('pmus market tools', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('pmus_instruments returns events from list', async () => {
    (pmusClient.listEvents as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      events: [{ slug: 'test-event', title: 'Test', markets: [] }],
    });
    const result = await handlePmusInstruments({ active: true, limit: 10 });
    expect(result.source).toBe('list');
    expect(result.events).toHaveLength(1);
    expect(result.events[0].slug).toBe('test-event');
  });

  it('pmus_instruments uses search when query provided', async () => {
    (pmusClient.searchEvents as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      events: [{ slug: 'btc-event', title: 'BTC', markets: [] }],
    });
    const result = await handlePmusInstruments({ search: 'btc', limit: 10 });
    expect(result.source).toBe('search');
    expect(pmusClient.searchEvents).toHaveBeenCalledWith('btc', 10);
  });

  it('pmus_order_book BBO returns spread', async () => {
    const result = await handlePmusOrderBook({ market_slug: 'test', bbo_only: true });
    expect(result.type).toBe('bbo');
    expect(result.best_bid).toBe(0.45);
    expect(result.best_ask).toBe(0.55);
    expect(result.spread).toBeCloseTo(0.1, 5);
  });

  it('pmus_search delegates to searchEvents', async () => {
    await handlePmusSearch({ query: 'bitcoin', limit: 5 });
    expect(pmusClient.searchEvents).toHaveBeenCalledWith('bitcoin', 5);
  });
});

describe('pmus trading tools', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('pmus_balances returns parsed amounts', async () => {
    const result = await handlePmusBalances({});
    expect(result.balance).toBe(1000);
    expect(result.buyingPower).toBe(800);
  });

  it('pmus_positions returns empty array when none', async () => {
    const result = await handlePmusPositions({});
    expect(result).toEqual([]);
  });

  it('pmus_open_orders returns empty array when none', async () => {
    const result = await handlePmusOpenOrders({});
    expect(result).toEqual([]);
  });

  it('pmus_place_order dry_run returns preview', async () => {
    const result = await handlePmusPlaceOrder({
      market_slug: 'btc-above-100k',
      outcome: 'yes',
      side: 'BUY',
      price: 0.65,
      size: 10,
      dry_run: true,
    });
    expect(result.dry_run).toBe(true);
    expect(result.preview.intent).toBe('ORDER_INTENT_BUY_LONG');
    expect(result.preview.display_price).toBe(0.65);
    expect(result.preview.api_price).toBe(0.65);
    expect(result.message).toContain('dry_run=false');
  });

  it('pmus_place_order dry_run with NO outcome complements price', async () => {
    const result = await handlePmusPlaceOrder({
      market_slug: 'btc-above-100k',
      outcome: 'no',
      side: 'BUY',
      price: 0.65,
      size: 10,
      dry_run: true,
    });
    expect(result.preview.intent).toBe('ORDER_INTENT_BUY_SHORT');
    expect(result.preview.api_price).toBeCloseTo(0.35, 10);
  });

  it('pmus_place_order live execution returns order', async () => {
    const result = await handlePmusPlaceOrder({
      market_slug: 'btc-above-100k',
      outcome: 'yes',
      side: 'BUY',
      price: 0.65,
      size: 10,
      dry_run: false,
    });
    expect(result.dry_run).toBe(false);
    expect(result.order.id).toBe('order-123');
    expect(result.order.status).toBe('submitted');
  });

  it('pmus_cancel_order returns success', async () => {
    const result = await handlePmusCancelOrder({
      order_id: 'order-123',
      market_slug: 'btc-above-100k',
    });
    expect(result.success).toBe(true);
  });

  it('pmus_cancel_order returns error on failure', async () => {
    (pmusClient.cancelOrder as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('Order not found'),
    );
    const result = await handlePmusCancelOrder({
      order_id: 'bad-id',
      market_slug: 'test',
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain('Order not found');
  });

  it('pmus_trade_stats returns empty activities', async () => {
    const result = await handlePmusTradeStats({ limit: 10 });
    expect(result).toEqual([]);
  });
});
