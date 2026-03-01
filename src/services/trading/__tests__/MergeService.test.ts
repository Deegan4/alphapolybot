import { describe, it, expect, vi, beforeEach } from 'vitest'
import { MergeService } from '../MergeService'
import { ethers } from 'ethers'

// Mock ActivityLogger
vi.mock('../ActivityLogger', () => ({
  activityLogger: {
    logTrade: vi.fn(),
  },
}))

// ==========================================
// UNIT TESTS (no on-chain calls)
// ==========================================

describe('MergeService — computeMergeAmount', () => {
  const svc = new MergeService()

  it('returns minimum of YES and NO sizes in USDC.e base units', () => {
    // 1.40 YES, 0.60 NO → merge 0.60 (the minimum)
    const amount = svc.computeMergeAmount(1.40, 0.60)
    // 0.60 * 1e6 = 600_000
    expect(amount).toBe(ethers.parseUnits('0.600000', 6))
  })

  it('returns 0 when either size is 0', () => {
    expect(svc.computeMergeAmount(1.40, 0)).toBe(0n)
    expect(svc.computeMergeAmount(0, 0.60)).toBe(0n)
  })

  it('handles equal sizes', () => {
    const amount = svc.computeMergeAmount(1.00, 1.00)
    expect(amount).toBe(ethers.parseUnits('1.000000', 6))
  })

  it('handles small fractional sizes', () => {
    const amount = svc.computeMergeAmount(0.05, 0.03)
    expect(amount).toBe(ethers.parseUnits('0.030000', 6))
  })
})

describe('MergeService — isReady', () => {
  it('returns false before initialization', () => {
    const svc = new MergeService()
    expect(svc.isReady()).toBe(false)
  })
})

describe('MergeService — merge validation', () => {
  let svc: MergeService

  beforeEach(() => {
    svc = new MergeService()
  })

  it('returns error when not initialized', async () => {
    const result = await svc.merge('0xabc123', 1000000n)
    expect(result.success).toBe(false)
    expect(result.error).toContain('not initialized')
  })

  it('returns error for empty conditionId', async () => {
    // Pretend we're initialized by setting internal state
    svc['connectedWallet'] = {} as ethers.Wallet
    svc['ctfContract'] = {} as ethers.Contract

    const result = await svc.merge('', 1000000n)
    expect(result.success).toBe(false)
    expect(result.error).toContain('Invalid conditionId')
  })

  it('returns error for zero amount', async () => {
    svc['connectedWallet'] = {} as ethers.Wallet
    svc['ctfContract'] = {} as ethers.Contract

    const result = await svc.merge('0xabc1234567890', 0n)
    expect(result.success).toBe(false)
    expect(result.error).toContain('positive')
  })

  it('returns error for short conditionId', async () => {
    svc['connectedWallet'] = {} as ethers.Wallet
    svc['ctfContract'] = {} as ethers.Contract

    const result = await svc.merge('0x', 1000000n)
    expect(result.success).toBe(false)
    expect(result.error).toContain('Invalid conditionId')
  })
})

describe('MergeService — merge with mocked contract', () => {
  let svc: MergeService
  const mockMergePositions = vi.fn()

  beforeEach(() => {
    svc = new MergeService()
    // Set up minimal mocks to simulate initialized state
    svc['connectedWallet'] = {} as ethers.Wallet
    svc['ctfContract'] = {
      mergePositions: mockMergePositions,
    } as unknown as ethers.Contract
    mockMergePositions.mockReset()
  })

  it('calls mergePositions with correct args on success', async () => {
    const mockTx = {
      hash: '0xtxhash123',
      wait: vi.fn().mockResolvedValue({ status: 1 }),
    }
    mockMergePositions.mockResolvedValue(mockTx)

    const conditionId = '0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890'
    const amount = 2000000n // $2.00

    const result = await svc.merge(conditionId, amount)

    expect(result.success).toBe(true)
    expect(result.txHash).toBe('0xtxhash123')
    expect(result.amountMerged).toBe(2.0)

    // Verify contract call args
    expect(mockMergePositions).toHaveBeenCalledWith(
      '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174', // USDC.e
      ethers.ZeroHash,      // parentCollectionId
      conditionId,
      [1, 2],              // binary partition
      amount,
    )
  })

  it('returns failure when TX reverts', async () => {
    const mockTx = {
      hash: '0xfailedtx',
      wait: vi.fn().mockResolvedValue({ status: 0 }),
    }
    mockMergePositions.mockResolvedValue(mockTx)

    const result = await svc.merge(
      '0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890',
      1000000n,
    )

    expect(result.success).toBe(false)
    expect(result.error).toContain('reverted')
    expect(result.txHash).toBe('0xfailedtx')
  })

  it('handles insufficient funds error gracefully', async () => {
    mockMergePositions.mockRejectedValue(new Error('insufficient funds for gas'))

    const result = await svc.merge(
      '0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890',
      1000000n,
    )

    expect(result.success).toBe(false)
    expect(result.error).toContain('MATIC')
  })

  it('handles token balance error gracefully', async () => {
    mockMergePositions.mockRejectedValue(new Error('ERC1155: burn amount exceeds balance'))

    const result = await svc.merge(
      '0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890',
      1000000n,
    )

    expect(result.success).toBe(false)
    expect(result.error).toContain('token balance')
  })
})
