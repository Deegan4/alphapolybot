/**
 * Output formatters for MCP tool responses.
 * Formats data into readable tables and summaries for Claude.
 */

export interface MarketSummary {
  id: string;
  question: string;
  outcomes: string[];
  prices: number[];
  volume24hr?: number;
  liquidity: number;
  category?: string;
  endDate?: string;
  spread?: number;
}

/** Format a number as USD */
export function formatUSD(amount: number): string {
  return `$${amount.toFixed(2)}`;
}

/** Format a number as a percentage */
export function formatPercent(value: number, decimals = 1): string {
  return `${(value * 100).toFixed(decimals)}%`;
}

/** Format a price (0-1 range) as cents */
export function formatPrice(price: number): string {
  return `$${price.toFixed(2)}`;
}

/** Format large numbers with K/M suffix */
export function formatCompact(n: number): string {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(1)}K`;
  return `$${n.toFixed(0)}`;
}

/** Truncate a string with ellipsis */
export function truncate(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen - 1) + '…';
}

/** Format a market summary for display */
export function formatMarketRow(m: MarketSummary, index?: number): string {
  const prefix = index != null ? `${index + 1}. ` : '';
  const priceStr = m.prices.map(p => formatPrice(p)).join(' / ');
  const vol = m.volume24hr != null ? formatCompact(m.volume24hr) : '—';
  const liq = formatCompact(m.liquidity);
  const spread = m.spread != null ? formatPercent(m.spread) : '—';

  return `${prefix}**${truncate(m.question, 60)}**\n` +
    `   Prices: ${priceStr} | Vol 24h: ${vol} | Liq: ${liq} | Spread: ${spread}`;
}

/** Format a date string to relative time */
export function formatRelativeTime(dateStr: string): string {
  const diff = new Date(dateStr).getTime() - Date.now();
  const absDiff = Math.abs(diff);
  const isPast = diff < 0;

  if (absDiff < 60_000) return 'just now';
  if (absDiff < 3600_000) {
    const mins = Math.floor(absDiff / 60_000);
    return isPast ? `${mins}m ago` : `in ${mins}m`;
  }
  if (absDiff < 86400_000) {
    const hours = Math.floor(absDiff / 3600_000);
    return isPast ? `${hours}h ago` : `in ${hours}h`;
  }
  const days = Math.floor(absDiff / 86400_000);
  return isPast ? `${days}d ago` : `in ${days}d`;
}
