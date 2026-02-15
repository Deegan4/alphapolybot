import { describe, it, expect } from 'vitest';
import {
  decimalPlaces,
  roundNormal,
  roundDown,
  roundUp,
  getRoundingConfig,
  ROUNDING_CONFIG,
} from '../src/utils/rounding.js';

describe('decimalPlaces', () => {
  it('returns 0 for integers', () => {
    expect(decimalPlaces(5)).toBe(0);
    expect(decimalPlaces(0)).toBe(0);
    expect(decimalPlaces(100)).toBe(0);
  });

  it('counts decimal digits correctly', () => {
    expect(decimalPlaces(0.1)).toBe(1);
    expect(decimalPlaces(0.01)).toBe(2);
    expect(decimalPlaces(0.001)).toBe(3);
    expect(decimalPlaces(1.23456)).toBe(5);
  });
});

describe('roundNormal', () => {
  it('rounds to specified decimals', () => {
    expect(roundNormal(0.456, 2)).toBe(0.46);
    expect(roundNormal(0.454, 2)).toBe(0.45);
    expect(roundNormal(0.455, 2)).toBe(0.46);
  });

  it('returns exact if already within precision', () => {
    expect(roundNormal(0.45, 2)).toBe(0.45);
    expect(roundNormal(0.4, 1)).toBe(0.4);
    expect(roundNormal(5, 0)).toBe(5);
  });

  it('handles 1 decimal place (tick_size=0.1)', () => {
    expect(roundNormal(0.456, 1)).toBe(0.5);
    expect(roundNormal(0.44, 1)).toBe(0.4);
  });
});

describe('roundDown', () => {
  it('rounds down (floor)', () => {
    expect(roundDown(0.459, 2)).toBe(0.45);
    expect(roundDown(0.999, 2)).toBe(0.99);
    expect(roundDown(1.999, 0)).toBe(1);
  });

  it('returns exact if already within precision', () => {
    expect(roundDown(0.45, 2)).toBe(0.45);
    expect(roundDown(3, 0)).toBe(3);
  });
});

describe('roundUp', () => {
  it('rounds up (ceil)', () => {
    expect(roundUp(0.451, 2)).toBe(0.46);
    expect(roundUp(0.001, 2)).toBe(0.01);
    expect(roundUp(1.001, 0)).toBe(2);
  });

  it('returns exact if already within precision', () => {
    expect(roundUp(0.45, 2)).toBe(0.45);
  });
});

describe('getRoundingConfig', () => {
  it('returns config for known tick sizes', () => {
    expect(getRoundingConfig('0.01')).toEqual({ price: 2, size: 2, amount: 4 });
    expect(getRoundingConfig('0.001')).toEqual({ price: 3, size: 2, amount: 5 });
    expect(getRoundingConfig('0.1')).toEqual({ price: 1, size: 2, amount: 3 });
    expect(getRoundingConfig('0.0001')).toEqual({ price: 4, size: 2, amount: 6 });
  });

  it('falls back to 0.01 for unknown tick sizes', () => {
    expect(getRoundingConfig('0.05')).toEqual(ROUNDING_CONFIG['0.01']);
    expect(getRoundingConfig('invalid')).toEqual(ROUNDING_CONFIG['0.01']);
  });
});
