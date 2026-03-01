/**
 * Authenticated CLOB client for Polymarket.
 * Direct HTTP to https://clob.polymarket.com with L1/L2 auth.
 *
 * Phase 2: Balance, open orders (read-only).
 * Phase 3: Place order, cancel order (write).
 */

import { HttpClient } from './http.js';
import { appConfig } from '../config.js';
import { initWallet, type WalletInfo } from '../auth/wallet.js';
import { buildL1Headers, buildL2Headers, type ApiKeyCreds } from '../auth/clob-auth.js';
import { buildSignedOrder, type OrderParams, type OrderPreview } from '../auth/order-signer.js';

// ─── Client ─────────────────────────────────────────────────

export class ClobClient {
  private http: HttpClient;
  private walletInfo: WalletInfo | null = null;
  private creds: ApiKeyCreds | null = null;
  private _initPromise: Promise<void> | null = null;

  constructor() {
    this.http = new HttpClient({
      baseUrl: appConfig.clobBaseUrl,
      maxRequestsPerMinute: 50,
      timeout: 15000,
      maxRetries: 2,
    });
  }

  /**
   * Lazy initialization — derives wallet and API key on first authenticated call.
   * Subsequent calls reuse cached credentials.
   */
  async init(): Promise<boolean> {
    if (this.creds) return true;
    if (this._initPromise) {
      await this._initPromise;
      return this.creds !== null;
    }

    this._initPromise = this._doInit();
    await this._initPromise;
    return this.creds !== null;
  }

  private async _doInit(): Promise<void> {
    this.walletInfo = initWallet();
    if (!this.walletInfo) {
      process.stderr.write('[clob] No wallet seed phrase — authenticated endpoints unavailable\n');
      return;
    }

    // Derive API key using L1 auth (EIP-712)
    try {
      const l1Headers = await buildL1Headers(this.walletInfo.wallet);

      const response = await this.http.get<{
        apiKey: string;
        secret: string;
        passphrase: string;
      }>('/auth/derive-api-key', { headers: l1Headers });

      this.creds = {
        key: response.apiKey,
        secret: response.secret,
        passphrase: response.passphrase,
      };

      process.stderr.write(`[clob] API key derived: ${this.creds.key.slice(0, 12)}…\n`);
    } catch (error) {
      process.stderr.write(`[clob] Failed to derive API key: ${error}\n`);
    }
  }

  // ─── Authenticated HTTP helpers ─────────────────────────────

  private async authGet<T>(
    endpoint: string,
    params?: Record<string, string>,
  ): Promise<T> {
    if (!await this.init()) throw new Error('CLOB auth not initialized');

    const headers = buildL2Headers(
      this.creds!, this.walletInfo!.signerAddress, 'GET', endpoint,
    );

    return this.http.get<T>(endpoint, { headers, params });
  }

  private async authPost<T>(
    endpoint: string,
    data?: unknown,
  ): Promise<T> {
    if (!await this.init()) throw new Error('CLOB auth not initialized');

    const body = data ? JSON.stringify(data) : undefined;
    const headers = buildL2Headers(
      this.creds!, this.walletInfo!.signerAddress, 'POST', endpoint, body,
    );

    return this.http.post<T>(endpoint, data, { headers });
  }

  private async authDelete<T>(
    endpoint: string,
    data?: unknown,
  ): Promise<T> {
    if (!await this.init()) throw new Error('CLOB auth not initialized');

    const body = data ? JSON.stringify(data) : undefined;
    const headers = buildL2Headers(
      this.creds!, this.walletInfo!.signerAddress, 'DELETE', endpoint, body,
    );

    return this.http.del<T>(endpoint, { headers, body });
  }

  // ─── Public Methods ────────────────────────────────────────

  /** Get wallet info (addresses, signature type) */
  getWalletInfo(): WalletInfo | null {
    return this.walletInfo;
  }

  /** Get API credentials for WebSocket auth */
  getCredentials(): ApiKeyCreds | null {
    return this.creds;
  }

  /**
   * Get USDC.e balance (exchange-visible, may differ from on-chain).
   * Uses /balance-allowance endpoint with COLLATERAL asset type.
   */
  async getBalance(): Promise<{
    balance: number;
    allowance: string;
  }> {
    const response = await this.authGet<{
      balance?: string;
      allowance?: string;
    }>('/balance-allowance', {
      asset_type: 'COLLATERAL',
      signature_type: `${this.walletInfo?.signatureType ?? 0}`,
    });

    return {
      balance: parseFloat(response.balance || '0'),
      allowance: response.allowance || '0',
    };
  }

  /** Get open orders, optionally filtered by token_id */
  async getOpenOrders(tokenId?: string): Promise<OpenOrder[]> {
    const params: Record<string, string> = {};
    if (tokenId) params.asset_id = tokenId;

    const response = await this.authGet<OpenOrder[] | { orders?: OpenOrder[] }>(
      '/orders', params,
    );

    return Array.isArray(response) ? response : (response.orders || []);
  }

  /** Cancel a single order by ID */
  async cancelOrder(orderId: string): Promise<{ success: boolean; error?: string }> {
    try {
      await this.authDelete('/order', { orderID: orderId });
      return { success: true };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Place an order — builds, signs, and submits to CLOB.
   * Returns preview + result. Use dry_run=true for preview only.
   */
  async placeOrder(
    params: OrderParams,
    dryRun = true,
  ): Promise<{
    preview: OrderPreview;
    result?: { success: boolean; orderId?: string; txHash?: string; error?: string };
  }> {
    if (!await this.init()) throw new Error('CLOB auth not initialized');

    const { payload, preview } = await buildSignedOrder(
      this.walletInfo!.wallet,
      this.walletInfo!.signerAddress,
      this.walletInfo!.proxyAddress,
      this.walletInfo!.signatureType,
      this.creds!.key,
      params,
    );

    if (dryRun) {
      return { preview };
    }

    // Submit the signed order
    try {
      const response = await this.authPost<{
        success?: boolean;
        orderID?: string;
        transactionsHashes?: string[];
        errorMsg?: string;
      }>('/order', payload);

      if (response.success || response.orderID) {
        return {
          preview,
          result: {
            success: true,
            orderId: response.orderID,
            txHash: response.transactionsHashes?.[0],
          },
        };
      }

      return {
        preview,
        result: {
          success: false,
          error: response.errorMsg || 'Order placement failed',
        },
      };
    } catch (error) {
      return {
        preview,
        result: {
          success: false,
          error: error instanceof Error ? error.message : String(error),
        },
      };
    }
  }

  /** Cancel all open orders */
  async cancelAllOrders(): Promise<{ success: boolean; count: number; error?: string }> {
    try {
      const result = await this.authDelete<{ canceled?: string[] }>('/cancel-all');
      return { success: true, count: result.canceled?.length ?? 0 };
    } catch (error) {
      return {
        success: false,
        count: 0,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
}

// ─── Types ──────────────────────────────────────────────────

export interface OpenOrder {
  id: string;
  asset_id: string;
  market?: string;
  side: string;
  price: string;
  original_size: string;
  size_matched: string;
  status: string;
  type: string;
  created_at: string;
  expiration?: string;
  associate_trades?: unknown[];
}

// ─── Singleton ──────────────────────────────────────────────

export const clobClient = new ClobClient();
