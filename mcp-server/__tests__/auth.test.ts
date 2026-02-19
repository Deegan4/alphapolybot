import { describe, it, expect } from 'vitest';
import { buildPolyHmacSignature } from '../src/auth/clob-auth.js';

describe('buildPolyHmacSignature', () => {
  // Use a known base64-encoded secret for deterministic testing
  const testSecret = Buffer.from('test-secret-key-1234567890', 'utf8').toString('base64');

  it('builds signature for GET request without body', () => {
    const sig = buildPolyHmacSignature(testSecret, 1700000000, 'GET', '/orders');
    expect(typeof sig).toBe('string');
    expect(sig.length).toBeGreaterThan(0);
    // base64url: no + or /, may have = padding
    expect(sig).not.toMatch(/[+/]/);
  });

  it('builds signature for POST request with body', () => {
    const body = JSON.stringify({ orderID: 'abc-123' });
    const sig = buildPolyHmacSignature(testSecret, 1700000000, 'POST', '/order', body);
    expect(typeof sig).toBe('string');
    expect(sig.length).toBeGreaterThan(0);
  });

  it('produces different signatures for different timestamps', () => {
    const sig1 = buildPolyHmacSignature(testSecret, 1700000000, 'GET', '/orders');
    const sig2 = buildPolyHmacSignature(testSecret, 1700000001, 'GET', '/orders');
    expect(sig1).not.toBe(sig2);
  });

  it('produces different signatures for different methods', () => {
    const sigGet = buildPolyHmacSignature(testSecret, 1700000000, 'GET', '/orders');
    const sigPost = buildPolyHmacSignature(testSecret, 1700000000, 'POST', '/orders');
    expect(sigGet).not.toBe(sigPost);
  });

  it('produces different signatures for different paths', () => {
    const sig1 = buildPolyHmacSignature(testSecret, 1700000000, 'GET', '/orders');
    const sig2 = buildPolyHmacSignature(testSecret, 1700000000, 'GET', '/balance-allowance');
    expect(sig1).not.toBe(sig2);
  });

  it('body affects the signature', () => {
    const sigNoBody = buildPolyHmacSignature(testSecret, 1700000000, 'POST', '/order');
    const sigBody = buildPolyHmacSignature(testSecret, 1700000000, 'POST', '/order', '{"test":1}');
    expect(sigNoBody).not.toBe(sigBody);
  });

  it('is deterministic — same inputs produce same output', () => {
    const sig1 = buildPolyHmacSignature(testSecret, 1700000000, 'GET', '/orders');
    const sig2 = buildPolyHmacSignature(testSecret, 1700000000, 'GET', '/orders');
    expect(sig1).toBe(sig2);
  });

  it('output is valid base64url with padding', () => {
    const sig = buildPolyHmacSignature(testSecret, 1700000000, 'DELETE', '/cancel-all');
    // base64url chars: A-Z, a-z, 0-9, -, _  plus = padding
    expect(sig).toMatch(/^[A-Za-z0-9_=-]+$/);
  });
});
