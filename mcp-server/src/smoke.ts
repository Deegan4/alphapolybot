#!/usr/bin/env node
/**
 * Live smoke test for the MCP server's tool handlers.
 *
 *   npm run smoke            # public gateway checks (no credentials)
 *   npm run smoke -- --auth  # also balance / positions / orders / order preview
 *
 * Node's fetch ignores HTTPS_PROXY unless NODE_USE_ENV_PROXY=1 (Node >= 22.21
 * or 24); set it when running behind a proxy.
 *
 * Never places a live order: place_order runs with dry_run=true (exchange
 * preview endpoint) at a 1¢ limit that could not fill even if it were sent.
 * Exits non-zero if any check fails.
 */

import { handleGetMarkets, handleGetMarketDetail, handleGetPriceHistory } from './tools/markets.js';
import { handleGetBalance } from './tools/balance.js';
import { handleGetOpenOrders, handleGetPositions, handlePlaceOrder } from './tools/trading.js';
import { hasCredentials } from './clients/polymarket-us.js';

type Check = { name: string; ok: boolean; detail: string };
const results: Check[] = [];

function isError(r: unknown): r is { error: string } {
  return typeof r === 'object' && r !== null && 'error' in r;
}

async function check<T extends object>(name: string, run: () => Promise<T | { error: string }>, describe: (r: T) => string, valid: (r: T) => boolean = () => true): Promise<T | null> {
  const started = Date.now();
  try {
    const r = await run();
    const ms = Date.now() - started;
    if (isError(r)) {
      results.push({ name, ok: false, detail: r.error });
      return null;
    }
    const ok = valid(r as T);
    results.push({ name, ok, detail: `${describe(r as T)} (${ms} ms)` });
    return ok ? (r as T) : null;
  } catch (e) {
    results.push({ name, ok: false, detail: e instanceof Error ? e.message : String(e) });
    return null;
  }
}

async function main() {
  const wantAuth = process.argv.includes('--auth');

  const markets = await check(
    'get_markets (top by volume, with BBO)',
    () => handleGetMarkets({ status: 'active', limit: 10, sort: 'volume', include_prices: true }),
    r => `${r.count} markets; with a quote: ${r.markets.filter(m => m.best_bid !== null || m.best_ask !== null).length}`,
    r => r.count > 0 && r.markets.some(m => m.best_bid != null) && r.markets.some(m => m.volume > 0),
  );

  const quoted = markets?.markets.find(m => m.best_bid !== null && m.best_ask !== null) ?? markets?.markets[0];
  if (!quoted) {
    report();
    return;
  }
  const slug = quoted.market_slug;

  await check(
    `get_market_detail market_slug=${slug}`,
    () => handleGetMarketDetail({ market_slug: slug }),
    r => ('book' in r && r.book ? `bid ${r.book.best_bid} / ask ${r.book.best_ask}, spread ${r.book.spread}, tick ${r.price_tick}` : 'no book'),
    r => 'book' in r && r.book !== null,
  );

  if (quoted.event_slug) {
    await check(
      `get_market_detail event_slug=${quoted.event_slug}`,
      () => handleGetMarketDetail({ event_slug: quoted.event_slug }),
      r => ('markets' in r ? `${r.markets.length} markets in event` : 'unexpected shape'),
      r => 'markets' in r && r.markets.length > 0,
    );
  }

  await check(
    `get_price_history ${slug} INTERVAL_1D`,
    () => handleGetPriceHistory({ market_slug: slug, interval: 'INTERVAL_1D', max_points: 50 }),
    r => `${r.summary.points} points, yes ${r.summary.yes_first} → ${r.summary.yes_last}`,
  );

  const end = Math.floor(Date.now() / 1000);
  await check(
    `get_price_history ${slug} last 2h custom range`,
    () => handleGetPriceHistory({ market_slug: slug, start_time: end - 7200, end_time: end, max_points: 50 }),
    r => `${r.summary.points} points`,
  );

  if (wantAuth) {
    if (!hasCredentials()) {
      results.push({ name: 'authenticated checks', ok: false, detail: 'POLYMARKET_KEY_ID / POLYMARKET_SECRET_KEY not set' });
    } else {
      await check('get_balance', () => handleGetBalance({}), r => JSON.stringify(r).slice(0, 160));
      await check('get_positions', () => handleGetPositions({}), r => JSON.stringify(r).slice(0, 160));
      await check('get_open_orders', () => handleGetOpenOrders({}), r => JSON.stringify(r).slice(0, 160));
      await check(
        `place_order DRY RUN ${slug} BUY yes 1 @ 0.01`,
        () => handlePlaceOrder({ market_slug: slug, side: 'BUY', outcome: 'yes', price: 0.01, quantity: 1, tif: 'GTC', dry_run: true }),
        r => JSON.stringify(r).slice(0, 200),
      );
    }
  }

  report();
}

function report() {
  for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}\n      ${r.detail}`);
  const failed = results.filter(r => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  process.exit(failed === 0 && results.length > 0 ? 0 : 1);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
