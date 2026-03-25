#!/usr/bin/env node
/**
 * AlphaPolyBot MCP Server — Polymarket Trading Master
 *
 * Phase 1: Read-only market data, crypto prices, analysis tools.
 * Phase 2+: Authenticated trading, portfolio, strategy management.
 *
 * Runs on stdio transport for Claude Code integration.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

// Tool schemas + handlers
import {
  getMarketsSchema,
  getMarketDetailSchema,
  handleGetMarkets,
  handleGetMarketDetail,
} from './tools/markets.js';

import {
  getCryptoPricesSchema,
  handleGetCryptoPrices,
} from './tools/prices.js';

import {
  computeKellySchema,
  scoreOpportunitiesSchema,
  handleComputeKelly,
  handleScoreOpportunities,
} from './tools/analysis.js';

import {
  getBalanceSchema,
  handleGetBalance,
} from './tools/balance.js';

import {
  getOpenOrdersSchema,
  cancelOrderSchema,
  cancelAllOrdersSchema,
  placeOrderSchema,
  handleGetOpenOrders,
  handleCancelOrder,
  handleCancelAllOrders,
  handlePlaceOrder,
} from './tools/trading.js';

// ─── Server Setup ─────────────────────────────────────────────

const server = new McpServer({
  name: 'polymarket',
  version: '1.0.0',
});

// ─── Phase 1: Read-Only Tools ─────────────────────────────────

// 1) get_markets — browse and search active Polymarket markets
server.tool(
  'get_markets',
  'Browse active Polymarket markets. Search by keyword, sort by volume/liquidity/date. Returns prices, volume, liquidity for each market.',
  getMarketsSchema,
  async (args) => {
    const result = await handleGetMarkets(args);
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
    };
  },
);

// 2) get_market_detail — deep dive into a specific market
server.tool(
  'get_market_detail',
  'Get detailed market data including order book, tick size, fee rate, and neg risk status. Provide either market_id (Gamma) or token_id (CLOB).',
  getMarketDetailSchema,
  async (args) => {
    const result = await handleGetMarketDetail(args);
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
    };
  },
);

// 3) get_crypto_prices — live crypto prices from Binance/CoinGecko
server.tool(
  'get_crypto_prices',
  'Get live crypto prices with 24h change. Supports BTC, ETH, SOL, XRP, MATIC. Binance primary, CoinGecko fallback.',
  getCryptoPricesSchema,
  async (args) => {
    const result = await handleGetCryptoPrices(args);
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
    };
  },
);

// 4) compute_kelly — Kelly criterion position sizing
server.tool(
  'compute_kelly',
  'Compute optimal bet size using Kelly criterion. Takes model probability, market price, fees, and bankroll. Returns full/fractional Kelly, bet size in USDC, edge%, and profitability.',
  computeKellySchema,
  async (args) => {
    const result = handleComputeKelly(args);
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
    };
  },
);

// 5) score_opportunities — rank markets by composite score
server.tool(
  'score_opportunities',
  'Score and rank markets by composite metric: spread tightness, volume, liquidity, and incoherence opportunity. Returns top 20 ranked markets with reasons.',
  scoreOpportunitiesSchema,
  async (args) => {
    const result = handleScoreOpportunities(args as any);
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
    };
  },
);

// ─── Phase 2: Authenticated Tools ─────────────────────────────

// 6) get_balance — wallet balance and auth status
server.tool(
  'get_balance',
  'Get USDC.e balance, signer/proxy addresses, and auth status. Requires WALLET_SEED_PHRASE in .env or secure runtime entry.',
  getBalanceSchema,
  async (args) => {
    const result = await handleGetBalance(args);
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
    };
  },
);

// 7) get_open_orders — list active orders
server.tool(
  'get_open_orders',
  'List open orders on the CLOB. Optionally filter by token_id. Shows price, size, fill status.',
  getOpenOrdersSchema,
  async (args) => {
    const result = await handleGetOpenOrders(args);
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
    };
  },
);

// 8) cancel_order — cancel a single order
server.tool(
  'cancel_order',
  'Cancel a specific open order by its order ID.',
  cancelOrderSchema,
  async (args) => {
    const result = await handleCancelOrder(args);
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
    };
  },
);

// 9) cancel_all_orders — cancel all open orders
server.tool(
  'cancel_all_orders',
  'Cancel ALL open orders. Requires confirm: true as safety check.',
  cancelAllOrdersSchema,
  async (args) => {
    const result = await handleCancelAllOrders(args);
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
    };
  },
);

// ─── Phase 3: Trade Execution ─────────────────────────────────

// 10) place_order — build, sign, and submit an order (dry_run=true by default)
server.tool(
  'place_order',
  'Place a limit order on Polymarket CLOB. DEFAULTS TO DRY RUN (preview only). You MUST query get_market_detail first to get tick_size, fee_rate_bps, and neg_risk. Set dry_run=false only after explicit user confirmation.',
  placeOrderSchema,
  async (args) => {
    const result = await handlePlaceOrder(args);
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
    };
  },
);

// ─── Start Server ─────────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write('[polymarket-mcp] Server started on stdio\n');
}

main().catch((err) => {
  process.stderr.write(`[polymarket-mcp] Fatal: ${err}\n`);
  process.exit(1);
});
