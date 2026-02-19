/**
 * CLOB Authentication — L1 (EIP-712) + L2 (HMAC) header builders.
 *
 * Ported from CLOBClient.ts buildL1Headers/buildL2Headers/buildPolyHmacSignature.
 * Node.js uses `node:crypto` createHmac() instead of browser's crypto.subtle.
 */

import { createHmac } from 'node:crypto';
import { ethers } from 'ethers';

// ─── Constants ───────────────────────────────────────────────

const CLOB_AUTH_DOMAIN = { name: 'ClobAuthDomain', version: '1', chainId: 137 };

const CLOB_AUTH_TYPES = {
  ClobAuth: [
    { name: 'address', type: 'address' },
    { name: 'timestamp', type: 'string' },
    { name: 'nonce', type: 'uint256' },
    { name: 'message', type: 'string' },
  ],
};

const MSG_TO_SIGN = 'This message attests that I control the given wallet';

// ─── API Key Credentials ────────────────────────────────────

export interface ApiKeyCreds {
  key: string;
  secret: string;
  passphrase: string;
}

// ─── HMAC Signature (Node.js native) ─────────────────────────

/**
 * Build HMAC-SHA256 signature for L2 auth.
 * Matches Polymarket's official clob-client:
 *   message = timestamp + method + requestPath [+ body]
 *   signature = base64url of HMAC-SHA256(secret, message), WITH '=' padding
 *
 * IMPORTANT: requestPath is the BARE endpoint (no query params).
 */
export function buildPolyHmacSignature(
  secret: string,
  timestamp: number,
  method: string,
  requestPath: string,
  body?: string,
): string {
  let message = `${timestamp}${method}${requestPath}`;
  if (body !== undefined) message += body;

  // Secret is base64-encoded; decode to raw bytes
  const keyBuf = Buffer.from(secret, 'base64');
  const hmac = createHmac('sha256', keyBuf);
  hmac.update(message);
  const sigBuf = hmac.digest();

  // Standard base64, then make URL-safe but KEEP '=' padding
  return sigBuf.toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

// ─── L1 Auth: EIP-712 ClobAuth Signing ──────────────────────

/**
 * Build L1 headers for auth endpoints (derive-api-key, create-api-key).
 * Uses EIP-712 typed data signature.
 */
export async function buildL1Headers(
  wallet: ethers.HDNodeWallet,
): Promise<Record<string, string>> {
  const address = wallet.address;
  const timestamp = Math.floor(Date.now() / 1000);
  const nonce = 0;

  const value = {
    address,
    timestamp: `${timestamp}`,
    nonce,
    message: MSG_TO_SIGN,
  };

  const sig = await wallet.signTypedData(CLOB_AUTH_DOMAIN, CLOB_AUTH_TYPES, value);

  return {
    POLY_ADDRESS: address,
    POLY_SIGNATURE: sig,
    POLY_TIMESTAMP: `${timestamp}`,
    POLY_NONCE: `${nonce}`,
  };
}

// ─── L2 Auth: HMAC Per-Request Headers ──────────────────────

/**
 * Build L2 headers for authenticated API requests.
 * Uses HMAC-SHA256 with derived API credentials.
 *
 * IMPORTANT: requestPath must be the BARE endpoint path, no query string.
 */
export function buildL2Headers(
  creds: ApiKeyCreds,
  signerAddress: string,
  method: string,
  requestPath: string,
  body?: string,
): Record<string, string> {
  const timestamp = Math.floor(Date.now() / 1000);

  const sig = buildPolyHmacSignature(
    creds.secret, timestamp, method, requestPath, body,
  );

  return {
    POLY_ADDRESS: signerAddress,
    POLY_SIGNATURE: sig,
    POLY_TIMESTAMP: `${timestamp}`,
    POLY_API_KEY: creds.key,
    POLY_PASSPHRASE: creds.passphrase,
  };
}
