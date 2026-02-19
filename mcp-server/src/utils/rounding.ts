/**
 * Rounding utilities for Polymarket order sizing.
 * Ported from CLOBClient.ts — matches the official Polymarket clob-client.
 */

/** Tick size → decimal precision for price, size, and collateral amounts */
export const ROUNDING_CONFIG: Record<string, { price: number; size: number; amount: number }> = {
  '0.1':    { price: 1, size: 2, amount: 3 },
  '0.01':   { price: 2, size: 2, amount: 4 },
  '0.001':  { price: 3, size: 2, amount: 5 },
  '0.0001': { price: 4, size: 2, amount: 6 },
};

/** Count decimal places of a number */
export function decimalPlaces(n: number): number {
  if (Number.isInteger(n)) return 0;
  const arr = n.toString().split('.');
  if (arr.length <= 1) return 0;
  return arr[1].length;
}

/** Round to nearest `decimals` places with EPSILON correction */
export function roundNormal(n: number, decimals: number): number {
  if (decimalPlaces(n) <= decimals) return n;
  return Math.round((n + Number.EPSILON) * 10 ** decimals) / 10 ** decimals;
}

/** Round down to `decimals` places */
export function roundDown(n: number, decimals: number): number {
  if (decimalPlaces(n) <= decimals) return n;
  return Math.floor(n * 10 ** decimals) / 10 ** decimals;
}

/** Round up to `decimals` places */
export function roundUp(n: number, decimals: number): number {
  if (decimalPlaces(n) <= decimals) return n;
  return Math.ceil(n * 10 ** decimals) / 10 ** decimals;
}

/** Get rounding config for a tick size, defaulting to 0.01 */
export function getRoundingConfig(tickSize: string): { price: number; size: number; amount: number } {
  return ROUNDING_CONFIG[tickSize] || ROUNDING_CONFIG['0.01'];
}
