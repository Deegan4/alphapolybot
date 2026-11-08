#!/usr/bin/env node
/**
 * AlphaPolyBot MCP Server — Polymarket US trading tools for LLM agents.
 *
 * Read-only tools (no credentials): markets, order books, crypto prices, analysis.
 * Authenticated tools (POLYMARKET_KEY_ID / POLYMARKET_SECRET_KEY): balance,
 * positions, open orders, place / cancel orders, close position.
 *
 * Runs on stdio transport for Claude Code integration.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { getMarketsSchema, getMarketDetailSchema, handleGetMarkets, handleGetMarketDetail } from './tools/markets.js';
import { getCryptoPricesSchema, handleGetCryptoPrices } from './tools/prices.js';
import {
  computeKellySchema,
  scoreOpportunitiesSchema,
  handleComputeKelly,
  handleScoreOpportunities,
} from './tools/analysis.js';
import { getBalanceSchema, handleGetBalance } from './tools/balance.js';
import {
  getOpenOrdersSchema,
  cancelOrderSchema,
  cancelAllOrdersSchema,
  placeOrderSchema,
  getPositionsSchema,
  closePositionSchema,
  handleGetOpenOrders,
  handleCancelOrder,
  handleCancelAllOrders,
  handlePlaceOrder,
  handleGetPositions,
  handleClosePosition,
} from './tools/trading.js';
import { hasCredentials } from './clients/polymarket-us.js';

// ─── Server Setup ─────────────────────────────────────────────

const server = new McpServer({
  name: 'polymarket-us',
  version: '2.0.0',
});

const json = (result: unknown) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
});

// ─── Read-only tools ─────────────────────────────────────────

server.tool(
  'get_markets',
  'Browse or search Polymarket US markets. Returns one row per tradeable market slug with its event, outcome, liquidity, volume and (by default) best bid/ask. Prices are YES-side.',
  getMarketsSchema,
  async (args) => json(await handleGetMarkets(args)),
);

server.tool(
  'get_market_detail',
  'Detailed market data by market_slug: order book summary (best bid/ask, spread, depth, state, last trade). Pass event_slug instead to list every market in an event with prices.',
  getMarketDetailSchema,
  async (args) => json(await handleGetMarketDetail(args)),
);

server.tool(
  'get_crypto_prices',
  'Get live crypto prices with 24h change. Supports BTC, ETH, SOL, XRP, MATIC. Binance primary, CoinGecko fallback.',
  getCryptoPricesSchema,
  async (args) => json(await handleGetCryptoPrices(args)),
);

server.tool(
  'compute_kelly',
  'Compute optimal bet size using Kelly criterion. Takes model probability, market price, fees, and bankroll. Returns full/fractional Kelly, bet size in USD, edge%, and profitability.',
  computeKellySchema,
  async (args) => json(handleComputeKelly(args)),
);

server.tool(
  'score_opportunities',
  'Score and rank binary markets by composite metric: spread tightness, volume, liquidity, and incoherence opportunity. Returns top 20 ranked markets with reasons.',
  scoreOpportunitiesSchema,
  async (args) => json(handleScoreOpportunities(args)),
);

// ─── Authenticated tools ─────────────────────────────────────

server.tool(
  'get_balance',
  'Get Polymarket US account balance and buying power. Requires POLYMARKET_KEY_ID and POLYMARKET_SECRET_KEY in .env.',
  getBalanceSchema,
  async (args) => json(await handleGetBalance(args)),
);

server.tool(
  'get_positions',
  'List open positions (net shares, cost, average entry, cash value, unrealized and realized P&L). Optionally filter by market_slug.',
  getPositionsSchema,
  async (args) => json(await handleGetPositions(args)),
);

server.tool(
  'get_open_orders',
  'List open orders. Optionally filter by market_slugs. Shows side/outcome, YES-side price, quantity, filled, remaining and state.',
  getOpenOrdersSchema,
  async (args) => json(await handleGetOpenOrders(args)),
);

server.tool(
  'cancel_order',
  'Cancel a specific open order by order_id (market_slug required).',
  cancelOrderSchema,
  async (args) => json(await handleCancelOrder(args)),
);

server.tool(
  'cancel_all_orders',
  'Cancel ALL open orders, or only those in market_slugs. Requires confirm: true.',
  cancelAllOrdersSchema,
  async (args) => json(await handleCancelAllOrders(args)),
);

server.tool(
  'place_order',
  'Place a limit order on Polymarket US. DEFAULTS TO DRY RUN: validates locally and asks the exchange preview endpoint, without placing. Quote the price in the chosen outcome\'s terms (NO prices are converted to YES-side automatically). Set dry_run=false only after explicit user confirmation.',
  placeOrderSchema,
  async (args) => json(await handlePlaceOrder(args)),
);

server.tool(
  'close_position',
  'Close an open position in a market by selling all contracts held (live order). Requires confirm: true. Optional slippage_bips tolerance.',
  closePositionSchema,
  async (args) => json(await handleClosePosition(args)),
);

// ─── Start Server ─────────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write(
    `[polymarket-mcp] Server started on stdio (${hasCredentials() ? 'authenticated' : 'read-only — no API credentials'})\n`,
  );
}

main().catch((err) => {
  process.stderr.write(`[polymarket-mcp] Fatal: ${err}\n`);
  process.exit(1);
});
