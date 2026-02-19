/**
 * EIP-712 Order Signing for Polymarket CLOB.
 *
 * Ported from CLOBClient.ts signOrder() + placeOrder() pipeline.
 * All the critical type normalization is preserved exactly.
 */

import { ethers } from 'ethers';
import { appConfig } from '../config.js';
import { roundNormal, roundDown, decimalPlaces, getRoundingConfig } from '../utils/rounding.js';

// ─── Exchange Contract Addresses ────────────────────────────

const CTF_EXCHANGE = appConfig.exchangeAddress;
const NEG_RISK_CTF_EXCHANGE = appConfig.negRiskCtfExchange;

// ─── EIP-712 Domains ────────────────────────────────────────

const ORDER_DOMAIN = {
  name: 'Polymarket CTF Exchange',
  version: '1',
  chainId: 137,
  verifyingContract: CTF_EXCHANGE,
};

const ORDER_DOMAIN_NEG_RISK = {
  name: 'Polymarket CTF Exchange',
  version: '1',
  chainId: 137,
  verifyingContract: NEG_RISK_CTF_EXCHANGE,
};

const ORDER_TYPES = {
  Order: [
    { name: 'salt', type: 'uint256' },
    { name: 'maker', type: 'address' },
    { name: 'signer', type: 'address' },
    { name: 'taker', type: 'address' },
    { name: 'tokenId', type: 'uint256' },
    { name: 'makerAmount', type: 'uint256' },
    { name: 'takerAmount', type: 'uint256' },
    { name: 'expiration', type: 'uint256' },
    { name: 'nonce', type: 'uint256' },
    { name: 'feeRateBps', type: 'uint256' },
    { name: 'side', type: 'uint8' },
    { name: 'signatureType', type: 'uint8' },
  ],
};

// ─── Order Building + Signing ────────────────────────────────

export interface OrderParams {
  tokenId: string;
  side: 'BUY' | 'SELL';
  price: number;
  size: number;
  tickSize: string;
  feeRateBps: number;
  negRisk: boolean;
  expiration?: number;
  type?: 'GTC' | 'GTD' | 'FOK' | 'FAK';
  postOnly?: boolean;
}

export interface SignedOrderPayload {
  order: Record<string, unknown>;
  owner: string;
  orderType: string;
  deferExec?: boolean;
  postOnly?: boolean;
}

export interface OrderPreview {
  tokenId: string;
  side: string;
  price: number;
  size: number;
  makerAmount: string;
  takerAmount: string;
  feeRateBps: number;
  negRisk: boolean;
  tickSize: string;
  orderType: string;
  estimatedCost: number;
}

/**
 * Build and sign a complete order payload ready for POST /order.
 */
export async function buildSignedOrder(
  wallet: ethers.HDNodeWallet,
  signerAddress: string,
  makerAddress: string,
  signatureType: number,
  apiKey: string,
  params: OrderParams,
): Promise<{ payload: SignedOrderPayload; preview: OrderPreview }> {
  const roundConfig = getRoundingConfig(params.tickSize);
  const tickFloat = parseFloat(params.tickSize);

  // Snap price to tick grid, clamp to valid range
  const tickPrice = Math.min(
    1 - tickFloat,
    Math.max(tickFloat, roundNormal(params.price, roundConfig.price)),
  );

  // Round size down
  const rawSize = roundDown(params.size, roundConfig.size);
  if (rawSize <= 0) {
    throw new Error(`Order size too small after rounding: ${params.size} → ${rawSize}`);
  }

  // Calculate amounts
  const makerMaxDp = roundConfig.size;
  const takerMaxDp = roundConfig.amount;
  let rawMakerAmt: number;
  let rawTakerAmt: number;

  if (params.side === 'BUY') {
    rawTakerAmt = roundDown(rawSize, takerMaxDp);
    rawMakerAmt = rawTakerAmt * tickPrice;
    if (decimalPlaces(rawMakerAmt) > makerMaxDp) {
      rawMakerAmt = roundDown(rawMakerAmt, makerMaxDp);
    }
  } else {
    rawMakerAmt = roundDown(rawSize, makerMaxDp);
    rawTakerAmt = rawMakerAmt * tickPrice;
    if (decimalPlaces(rawTakerAmt) > takerMaxDp) {
      rawTakerAmt = roundDown(rawTakerAmt, takerMaxDp);
    }
  }

  // Convert to USDC base units (6 decimals) as BigInt
  const makerAmount = ethers.parseUnits(rawMakerAmt.toFixed(6), 6);
  const takerAmount = ethers.parseUnits(rawTakerAmt.toFixed(6), 6);

  const salt = Date.now();
  const orderData = {
    salt,
    maker: makerAddress,
    signer: signerAddress,
    taker: ethers.ZeroAddress,
    tokenId: params.tokenId,
    makerAmount,
    takerAmount,
    expiration: params.expiration ?? 0,
    nonce: 0,
    feeRateBps: params.feeRateBps,
    side: params.side === 'BUY' ? 0 : 1,
    signatureType,
  };

  // Sign via EIP-712
  const domain = params.negRisk ? ORDER_DOMAIN_NEG_RISK : ORDER_DOMAIN;

  // Normalize ALL fields to strings (official SDK requirement)
  const normalizedOrder = {
    salt: String(orderData.salt),
    maker: orderData.maker,
    signer: orderData.signer,
    taker: orderData.taker,
    tokenId: orderData.tokenId,
    makerAmount: makerAmount.toString(),
    takerAmount: takerAmount.toString(),
    expiration: String(orderData.expiration),
    nonce: String(orderData.nonce),
    feeRateBps: String(orderData.feeRateBps),
    side: String(orderData.side),
    signatureType: String(orderData.signatureType),
  };

  const signature = await wallet.signTypedData(domain, ORDER_TYPES, normalizedOrder);

  // Build API request body (official SDK format)
  const orderType = params.type || 'FOK';
  const payload: SignedOrderPayload = {
    order: {
      salt: orderData.salt,
      maker: orderData.maker,
      signer: orderData.signer,
      taker: orderData.taker,
      tokenId: orderData.tokenId,
      makerAmount: makerAmount.toString(),
      takerAmount: takerAmount.toString(),
      expiration: String(orderData.expiration),
      nonce: '0',
      feeRateBps: String(params.feeRateBps),
      side: params.side,
      signatureType: orderData.signatureType,
      signature,
    },
    owner: apiKey,
    orderType,
  };

  if (params.postOnly != null) {
    if (orderType !== 'GTC' && orderType !== 'GTD') {
      throw new Error('postOnly is only supported for GTC and GTD orders');
    }
    payload.postOnly = params.postOnly;
  }

  const estimatedCost = params.side === 'BUY'
    ? rawTakerAmt * tickPrice
    : rawMakerAmt;

  const preview: OrderPreview = {
    tokenId: params.tokenId,
    side: params.side,
    price: tickPrice,
    size: rawSize,
    makerAmount: makerAmount.toString(),
    takerAmount: takerAmount.toString(),
    feeRateBps: params.feeRateBps,
    negRisk: params.negRisk,
    tickSize: params.tickSize,
    orderType,
    estimatedCost: Math.round(estimatedCost * 100) / 100,
  };

  return { payload, preview };
}
