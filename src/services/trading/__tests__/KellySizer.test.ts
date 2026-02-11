import { describe, it, expect } from 'vitest'
import { KellySizer } from '../KellySizer'

describe('KellySizer', () => {
  // ── fullKelly() ──────────────────────────────────────────────

  describe('fullKelly()', () => {
    it('even money (b=1): f* = 2p - 1', () => {
      // p=0.6, b=1 → f* = (1×0.6 - 0.4)/1 = 0.2
      expect(KellySizer.fullKelly(0.6, 1)).toBeCloseTo(0.2, 6)
    })

    it('favorable odds (b=2, p=0.5): f* = 0.25', () => {
      // f* = (2×0.5 - 0.5)/2 = 0.5/2 = 0.25
      expect(KellySizer.fullKelly(0.5, 2)).toBeCloseTo(0.25, 6)
    })

    it('no edge (p=0.5, b=1): f* = 0', () => {
      expect(KellySizer.fullKelly(0.5, 1)).toBeCloseTo(0, 6)
    })

    it('negative edge: clamped to 0', () => {
      // p=0.3, b=1 → f* = (0.3 - 0.7)/1 = -0.4 → clamped to 0
      expect(KellySizer.fullKelly(0.3, 1)).toBe(0)
    })

    it('high confidence (p=0.9, b=1): f* = 0.8', () => {
      expect(KellySizer.fullKelly(0.9, 1)).toBeCloseTo(0.8, 6)
    })

    it('edge case: b=0 returns 0', () => {
      expect(KellySizer.fullKelly(0.6, 0)).toBe(0)
    })

    it('edge case: p=0 returns 0', () => {
      expect(KellySizer.fullKelly(0, 2)).toBe(0)
    })

    it('edge case: p=1 returns 0 (degenerate)', () => {
      expect(KellySizer.fullKelly(1, 2)).toBe(0)
    })
  })

  // ── polymarketKelly() ────────────────────────────────────────

  describe('polymarketKelly()', () => {
    it('price=0.50, model=0.65 → b=1, f*=0.3', () => {
      // b = 0.50/0.50 = 1, f* = (1×0.65 - 0.35)/1 = 0.3
      expect(KellySizer.polymarketKelly(0.65, 0.50)).toBeCloseTo(0.3, 6)
    })

    it('price=0.35, model=0.55 → b≈1.857, f*≈0.307', () => {
      // b = 0.65/0.35 ≈ 1.857
      // f* = (1.857×0.55 - 0.45)/1.857 ≈ (1.021 - 0.45)/1.857 ≈ 0.307
      const f = KellySizer.polymarketKelly(0.55, 0.35)
      expect(f).toBeCloseTo(0.307, 2)
    })

    it('no edge (model ≤ price) returns 0', () => {
      expect(KellySizer.polymarketKelly(0.40, 0.50)).toBe(0)
      expect(KellySizer.polymarketKelly(0.50, 0.50)).toBe(0)
    })

    it('extreme low price (0.05)', () => {
      // b = 0.95/0.05 = 19, model=0.10
      // f* = (19×0.10 - 0.90)/19 = (1.9 - 0.9)/19 ≈ 0.0526
      const f = KellySizer.polymarketKelly(0.10, 0.05)
      expect(f).toBeCloseTo(0.0526, 3)
    })

    it('extreme high price (0.95)', () => {
      // b = 0.05/0.95 ≈ 0.0526, model=0.98
      // f* = (0.0526×0.98 - 0.02)/0.0526 ≈ (0.0516 - 0.02)/0.0526 ≈ 0.60
      const f = KellySizer.polymarketKelly(0.98, 0.95)
      expect(f).toBeCloseTo(0.60, 1)
    })

    it('price=0 returns 0 (safety)', () => {
      expect(KellySizer.polymarketKelly(0.50, 0)).toBe(0)
    })

    it('price=1 returns 0 (safety)', () => {
      expect(KellySizer.polymarketKelly(0.50, 1)).toBe(0)
    })
  })

  // ── arbKelly() ───────────────────────────────────────────────

  describe('arbKelly()', () => {
    it('5% guaranteed profit → 0.10', () => {
      // 0.05 * 2 = 0.10, under default cap 0.20
      expect(KellySizer.arbKelly(0.05)).toBeCloseTo(0.10, 6)
    })

    it('0% profit returns 0', () => {
      expect(KellySizer.arbKelly(0)).toBe(0)
    })

    it('negative profit returns 0', () => {
      expect(KellySizer.arbKelly(-0.02)).toBe(0)
    })

    it('high profit ratio capped at maxFraction', () => {
      // 0.50 * 2 = 1.0, capped at 0.20
      expect(KellySizer.arbKelly(0.50)).toBeCloseTo(0.20, 6)
    })

    it('custom maxFraction respected', () => {
      expect(KellySizer.arbKelly(0.50, 0.10)).toBeCloseTo(0.10, 6)
    })
  })

  // ── sizeBet() ────────────────────────────────────────────────

  describe('sizeBet()', () => {
    it('quarter Kelly: $100 bankroll, f*=0.4 → $10', () => {
      const size = KellySizer.sizeBet({
        kellyFraction: 0.25,
        bankroll: 100,
        fullKelly: 0.4,
      })
      expect(size).toBe(10.00)
    })

    it('concentration cap: f*=0.8, $50 bankroll → caps at $10', () => {
      // 0.8 × 0.25 × 50 = $10, but cap = 50 × 0.20 = $10 → same
      // Use full Kelly fraction to exceed cap:
      const size = KellySizer.sizeBet({
        kellyFraction: 1.0,
        bankroll: 50,
        fullKelly: 0.8,
      })
      // 0.8 × 1.0 × 50 = $40, cap = 50 × 0.20 = $10
      expect(size).toBe(10.00)
    })

    it('min bet: tiny Kelly → returns $1', () => {
      const size = KellySizer.sizeBet({
        kellyFraction: 0.25,
        bankroll: 10,
        fullKelly: 0.01,
      })
      // 0.01 × 0.25 × 10 = $0.025 → floor at $1
      expect(size).toBe(1.00)
    })

    it('zero bankroll → returns minBet', () => {
      expect(KellySizer.sizeBet({
        kellyFraction: 0.25,
        bankroll: 0,
        fullKelly: 0.5,
      })).toBe(1.00)
    })

    it('full Kelly fraction', () => {
      const size = KellySizer.sizeBet({
        kellyFraction: 1.0,
        bankroll: 100,
        fullKelly: 0.15,
      })
      // 0.15 × 1.0 × 100 = $15, cap = 100 × 0.20 = $20 → $15
      expect(size).toBe(15.00)
    })

    it('Kelly fraction 0 → returns minBet', () => {
      expect(KellySizer.sizeBet({
        kellyFraction: 0,
        bankroll: 100,
        fullKelly: 0.5,
      })).toBe(1.00)
    })

    it('custom minBet and maxConcentration', () => {
      const size = KellySizer.sizeBet({
        kellyFraction: 0.5,
        bankroll: 200,
        fullKelly: 0.6,
        maxConcentration: 0.10,
        minBet: 2.00,
      })
      // 0.6 × 0.5 × 200 = $60, cap = 200 × 0.10 = $20 → $20
      expect(size).toBe(20.00)
    })

    it('rounds to cents', () => {
      const size = KellySizer.sizeBet({
        kellyFraction: 0.25,
        bankroll: 67.43,
        fullKelly: 0.307,
      })
      // 0.307 × 0.25 × 67.43 = 5.1752... → rounded to $5.18
      expect(size).toBe(5.18)
    })

    it('fullKelly=0 → returns minBet', () => {
      expect(KellySizer.sizeBet({
        kellyFraction: 0.25,
        bankroll: 100,
        fullKelly: 0,
      })).toBe(1.00)
    })

    it('negative bankroll → returns minBet', () => {
      expect(KellySizer.sizeBet({
        kellyFraction: 0.25,
        bankroll: -50,
        fullKelly: 0.5,
      })).toBe(1.00)
    })
  })

  // ── Integration scenarios ────────────────────────────────────

  describe('end-to-end scenarios', () => {
    it('LLM mispriced market: p=0.6, price=0.45, $6.70 bankroll', () => {
      // b = 0.55/0.45 ≈ 1.222
      // f* = (1.222×0.6 - 0.4)/1.222 = 0.333/1.222 ≈ 0.2727
      const fStar = KellySizer.polymarketKelly(0.6, 0.45)
      expect(fStar).toBeCloseTo(0.2727, 2)

      const size = KellySizer.sizeBet({
        kellyFraction: 0.25,
        bankroll: 6.70,
        fullKelly: fStar,
      })
      // 0.2727 × 0.25 × 6.70 = $0.457 → floor at $1
      expect(size).toBe(1.00)
    })

    it('DipArb: p=0.75, price=0.333, $100 bankroll', () => {
      // b = 0.667/0.333 ≈ 2.0, f* ≈ 0.625
      const fStar = KellySizer.polymarketKelly(0.75, 0.333)
      expect(fStar).toBeCloseTo(0.625, 2)

      const size = KellySizer.sizeBet({
        kellyFraction: 0.25,
        bankroll: 100,
        fullKelly: fStar,
      })
      // 0.625 × 0.25 × 100 = $15.63, cap = 100 × 0.20 = $20 → $15.63
      expect(size).toBe(15.63)
    })

    it('ProjectFW arb: 3% guaranteed, $100 bankroll', () => {
      const fStar = KellySizer.arbKelly(0.03)
      expect(fStar).toBeCloseTo(0.06, 6)

      const size = KellySizer.sizeBet({
        kellyFraction: 0.25,
        bankroll: 100,
        fullKelly: fStar,
      })
      // 0.06 × 0.25 × 100 = $1.50
      expect(size).toBe(1.50)
    })
  })
})
