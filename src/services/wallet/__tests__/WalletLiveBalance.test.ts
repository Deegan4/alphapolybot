import { describe, it, expect, vi } from 'vitest'

vi.mock('@/services/api', () => ({ polymarketUSClient: {} }))

import { shouldPollBalanceRest, BALANCE_REST_FALLBACK_MS, WalletService } from '../WalletService'

describe('shouldPollBalanceRest', () => {
  it('polls REST when the private feed has no balance', () => {
    expect(shouldPollBalanceRest({ wsHasBalance: false, lastRestSyncMs: 0, nowMs: 1000 })).toBe(true)
  })

  it('only polls every fallback interval while the feed is live', () => {
    expect(shouldPollBalanceRest({ wsHasBalance: true, lastRestSyncMs: null, nowMs: 0 })).toBe(true)
    expect(shouldPollBalanceRest({ wsHasBalance: true, lastRestSyncMs: 0, nowMs: 15_000 })).toBe(false)
    expect(shouldPollBalanceRest({ wsHasBalance: true, lastRestSyncMs: 0, nowMs: BALANCE_REST_FALLBACK_MS })).toBe(true)
  })
})

describe('WalletService.applyLiveBalance', () => {
  it('updates balance only while connected and for finite values', () => {
    const w = new WalletService()
    w.applyLiveBalance(50, 40)
    expect(w.getBalance()).toBe(0) // not connected
    ;(w as unknown as { state: { isConnected: boolean } }).state.isConnected = true
    w.applyLiveBalance(50, 40)
    expect(w.getBalance()).toBe(50)
    expect(w.getBuyingPower()).toBe(40)
    w.applyLiveBalance(NaN, 1)
    expect(w.getBalance()).toBe(50)
  })
})
