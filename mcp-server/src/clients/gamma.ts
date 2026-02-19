/**
 * Gamma API client for market discovery.
 * Direct HTTP to https://gamma-api.polymarket.com (no Vite proxy).
 *
 * Ported from src/services/api/GammaClient.ts with the same
 * JSON-string normalization and event flattening logic.
 */

import { HttpClient } from './http.js';
import { appConfig } from '../config.js';

export interface Market {
  id: string;
  question: string;
  description?: string;
  outcomes: string[];
  clobTokenIds: string[];
  outcomePrices: number[];
  conditionId: string;
  active: boolean;
  closed: boolean;
  endDate: string;
  createdAt: string;
  updatedAt?: string;
  volume: number;
  volume24hr?: number;
  liquidity: number;
  category?: string;
  tags?: string[];
  negRisk?: boolean;
  resolutionSource?: string;
  groupItemTitle?: string;
}

/** Parse JSON-string arrays from Gamma API: '["Yes","No"]' → ["Yes","No"] */
function parseJsonArray(val: unknown): unknown[] {
  if (Array.isArray(val)) return val;
  if (typeof val === 'string') {
    try {
      const parsed = JSON.parse(val);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

/** Normalize a raw market object from Gamma API */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function normalizeMarket(raw: any): Market {
  const outcomes = parseJsonArray(raw.outcomes).map(String);
  const clobTokenIds = parseJsonArray(raw.clobTokenIds).map(String);
  const outcomePrices = parseJsonArray(raw.outcomePrices).map(
    (p: unknown) => typeof p === 'string' ? parseFloat(p) : Number(p),
  );

  return {
    ...raw,
    outcomes,
    clobTokenIds,
    outcomePrices,
    volume: typeof raw.volume === 'string' ? parseFloat(raw.volume) || 0 : (raw.volume ?? 0),
    volume24hr: raw.volume24hr != null
      ? (typeof raw.volume24hr === 'string' ? parseFloat(raw.volume24hr) || 0 : raw.volume24hr)
      : undefined,
    liquidity: typeof raw.liquidity === 'string' ? parseFloat(raw.liquidity) || 0 : (raw.liquidity ?? 0),
    negRisk: Boolean(raw.negRisk ?? raw.enableNegRisk ?? raw.neg_risk ?? false),
  };
}

export class GammaClient {
  private http: HttpClient;

  constructor() {
    this.http = new HttpClient({
      baseUrl: appConfig.gammaBaseUrl,
      maxRequestsPerMinute: 100,
      timeout: 15000,
      maxRetries: 3,
    });
  }

  /** Get markets with filtering */
  async getMarkets(options: {
    active?: boolean;
    closed?: boolean;
    limit?: number;
    offset?: number;
  } = {}): Promise<Market[]> {
    const { active = true, closed = false, limit = 100, offset } = options;

    const params: Record<string, string> = {
      active: String(active),
      closed: String(closed),
      limit: String(Math.min(limit, 100)),
    };
    if (offset != null && offset > 0) {
      params.offset = String(offset);
    }

    const response = await this.http.get<Market[] | { markets?: Market[] }>(
      '/markets', { params },
    );

    const markets = Array.isArray(response) ? response : (response.markets || []);
    return markets.map(normalizeMarket);
  }

  /** Get a single market by ID */
  async getMarket(marketId: string): Promise<Market | null> {
    try {
      const response = await this.http.get<Market>(`/markets/${marketId}`);
      return normalizeMarket(response);
    } catch {
      return null;
    }
  }

  /** Search markets by query string */
  async searchMarkets(query: string, limit = 20): Promise<Market[]> {
    try {
      const response = await this.http.get<{ markets?: Market[] }>(
        `/search`, { params: { q: query, limit: String(limit) } },
      );
      return (response.markets || []).map(normalizeMarket);
    } catch {
      return [];
    }
  }

  /**
   * Get active markets by fetching from /events endpoint.
   * The /markets endpoint only returns ~16 standalone markets,
   * but /events contains thousands nested inside event objects.
   */
  async getActiveMarkets(maxAgeHours?: number): Promise<Market[]> {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const response = await this.http.get<any[]  | { events?: any[] }>(
        '/events', { params: { active: 'true', closed: 'false', limit: '100' } },
      );

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const events: any[] = Array.isArray(response) ? response : (response.events || []);
      const allMarkets: Market[] = [];
      const seenIds = new Set<string>();

      for (const event of events) {
        const markets = event.markets || [];
        const eventNegRisk = Boolean(event.enableNegRisk ?? event.negRisk ?? false);

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        for (const raw of markets as any[]) {
          if (seenIds.has(raw.id)) continue;
          if (eventNegRisk && !raw.negRisk && !raw.enableNegRisk && !raw.neg_risk) {
            raw.negRisk = true;
          }
          const m = normalizeMarket(raw);
          if (!m.active || m.closed) continue;
          seenIds.add(m.id);
          allMarkets.push(m);
        }
      }

      if (maxAgeHours == null) return allMarkets;

      const cutoff = new Date(Date.now() - maxAgeHours * 60 * 60 * 1000);
      return allMarkets.filter(m => new Date(m.createdAt) > cutoff);
    } catch (error) {
      process.stderr.write(`[gamma] Failed to fetch active markets: ${error}\n`);
      return [];
    }
  }

  /** Get binary markets (exactly 2 outcomes with CLOB token IDs) */
  async getBinaryMarkets(): Promise<Market[]> {
    const all = await this.getActiveMarkets();
    return all.filter(m =>
      m.outcomes?.length === 2 &&
      m.clobTokenIds?.length === 2 &&
      m.outcomePrices?.length === 2,
    );
  }
}

export const gammaClient = new GammaClient();
