import { describe, it, expect } from 'vitest'
import { MakerFillTracker, type StorageLike } from '../MakerFillTracker'
import { takerFee } from '../pmusFees'

function memoryStorage(): StorageLike & { data: Map<string, string> } {
  const data = new Map<string, string>()
  return { data, getItem: k => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v) }
}

describe('MakerFillTracker', () => {
  it('starts empty with no fill rate', () => {
    const s = new MakerFillTracker(memoryStorage(), () => 1000).getStats()
    expect(s).toMatchObject({ placed: 0, filled: 0, fillRate: null, avgTimeToFillMs: null, feesSavedUSD: 0, since: 1000 })
  })

  it('computes fill rate, time to fill and taker fees avoided', () => {
    let now = 0
    const t = new MakerFillTracker(memoryStorage(), () => now)
    for (let i = 0; i < 4; i++) t.recordPlaced()
    now = 30_000
    t.recordResolved('filled', { placedAt: 0, price: 0.40, size: 10 })
    now = 90_000
    t.recordResolved('filled', { placedAt: 0, price: 0.60, size: 5, feeCoefficient: 0.0695 })
    t.recordResolved('expired', { placedAt: 0, price: 0.5, size: 10 })
    t.recordResolved('cancelled', { placedAt: 0, price: 0.5, size: 10 })
    t.recordRejected()

    const s = t.getStats()
    expect(s).toMatchObject({ placed: 4, filled: 2, expired: 1, cancelled: 1, rejected: 1 })
    expect(s.fillRate).toBe(0.5)
    expect(s.avgTimeToFillMs).toBe(60_000)
    expect(s.feesSavedUSD).toBeCloseTo(Math.round((takerFee(10, 0.4) + takerFee(5, 0.6, 0.0695)) * 100) / 100, 10)
    expect(s.filledNotionalUSD).toBe(7)
  })

  it('persists across instances and resets', () => {
    const storage = memoryStorage()
    const a = new MakerFillTracker(storage, () => 5)
    a.recordPlaced()
    a.recordResolved('filled', { placedAt: 0, price: 0.5, size: 2 })
    const b = new MakerFillTracker(storage, () => 9)
    expect(b.getStats()).toMatchObject({ placed: 1, filled: 1, since: 5 })
    b.reset()
    expect(new MakerFillTracker(storage, () => 9).getStats()).toMatchObject({ placed: 0, since: 9 })
  })

  it('survives corrupt or unavailable storage', () => {
    const storage = memoryStorage()
    storage.data.set('alphapolybot:maker-fill-stats:v1', '{not json')
    expect(new MakerFillTracker(storage).getStats().placed).toBe(0)
    const t = new MakerFillTracker(null)
    t.recordPlaced()
    expect(t.getStats().placed).toBe(1)
  })

  it('notifies listeners on every change', () => {
    const t = new MakerFillTracker(memoryStorage())
    const seen: number[] = []
    const off = t.onChange(s => seen.push(s.placed))
    t.recordPlaced()
    t.recordPlaced()
    off()
    t.recordPlaced()
    expect(seen).toEqual([1, 2])
  })
})
