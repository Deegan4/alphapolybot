import { describe, it, expect } from 'vitest'
import { fuseBtcSignals } from '../signalEngine'
import type { Signal } from '../signalEngine'
import type { LLMDirectionSignal } from '../signalEngine'

function makeSignal(direction: 'up' | 'down', confidence: number): Signal {
  return { direction, confidence }
}

function makeLLM(direction: 'up' | 'down', confidence: number): LLMDirectionSignal {
  return { direction, confidence }
}

describe('fuseBtcSignals', () => {
  it('returns mechanical unchanged when LLM is null', () => {
    const result = fuseBtcSignals(makeSignal('up', 0.60), null, 0.30)
    expect(result.direction).toBe('up')
    expect(result.confidence).toBe(0.60)
    expect(result.fusionApplied).toBe(false)
  })

  it('agreement boosts confidence', () => {
    const mech = makeSignal('up', 0.50)
    const llm = makeLLM('up', 0.70)
    const result = fuseBtcSignals(mech, llm, 0.30)
    expect(result.fusionApplied).toBe(true)
    expect(result.confidence).toBeGreaterThan(0.50) // boosted above mechanical
    expect(result.direction).toBe('up')
  })

  it('agreement is capped at 0.95', () => {
    const mech = makeSignal('up', 0.95)
    const llm = makeLLM('up', 0.99)
    const result = fuseBtcSignals(mech, llm, 0.30)
    expect(result.confidence).toBeLessThanOrEqual(0.95)
  })

  it('disagreement reduces confidence', () => {
    const mech = makeSignal('up', 0.60)
    const llm = makeLLM('down', 0.70)
    const result = fuseBtcSignals(mech, llm, 0.30)
    expect(result.fusionApplied).toBe(true)
    expect(result.confidence).toBeLessThan(0.60) // penalized
    expect(result.direction).toBe('up') // direction follows mechanical
  })

  it('direction always follows mechanical', () => {
    const mech = makeSignal('down', 0.40)
    const llm = makeLLM('up', 0.90)
    const result = fuseBtcSignals(mech, llm, 0.30)
    expect(result.direction).toBe('down')
  })

  it('zero weight = pure mechanical', () => {
    const mech = makeSignal('up', 0.55)
    const llm = makeLLM('down', 0.90)
    const result = fuseBtcSignals(mech, llm, 0.00)
    // weight=0: agreement formula = 1.0 * mechConf + 0 * llmConf, but direction disagrees
    // Disagreement: mechConf * (1 - llmConf * 0) = mechConf
    expect(result.confidence).toBeCloseTo(0.55, 2)
  })

  it('low LLM confidence + agreement = mild boost', () => {
    const mech = makeSignal('up', 0.50)
    const llm = makeLLM('up', 0.20)
    const result = fuseBtcSignals(mech, llm, 0.30)
    // Mild boost: geo mean of 0.50 and 0.20 is low, weighted avg = 0.41
    expect(result.confidence).toBeGreaterThan(0.38)
    expect(result.confidence).toBeLessThan(0.55)
  })

  it('both at high confidence + agreement', () => {
    const mech = makeSignal('down', 0.85)
    const llm = makeLLM('down', 0.90)
    const result = fuseBtcSignals(mech, llm, 0.30)
    expect(result.confidence).toBeGreaterThan(0.85)
    expect(result.confidence).toBeLessThanOrEqual(0.95)
  })

  it('disagreement with low LLM confidence = small penalty', () => {
    const mech = makeSignal('up', 0.60)
    const llm = makeLLM('down', 0.20)
    const result = fuseBtcSignals(mech, llm, 0.30)
    // penalty = 0.20 * 0.30 = 0.06 → confidence = 0.60 * 0.94 = 0.564
    expect(result.confidence).toBeCloseTo(0.564, 2)
  })

  it('confidence never goes negative', () => {
    const mech = makeSignal('up', 0.10)
    const llm = makeLLM('down', 0.99)
    const result = fuseBtcSignals(mech, llm, 1.0)
    // penalty = 0.99 * 1.0 → confidence = 0.10 * 0.01 = 0.001
    expect(result.confidence).toBeGreaterThanOrEqual(0)
  })

  it('weight=1.0 edge case (all LLM)', () => {
    const mech = makeSignal('up', 0.50)
    const llm = makeLLM('up', 0.80)
    const result = fuseBtcSignals(mech, llm, 1.0)
    // weightedAvg = 0 * 0.50 + 1.0 * 0.80 = 0.80
    // geoMean = sqrt(0.50 * 0.80) ≈ 0.632
    // blended = 0.80 * 0.80 + 0.20 * 0.632 ≈ 0.766
    expect(result.confidence).toBeGreaterThan(0.70)
    expect(result.confidence).toBeLessThanOrEqual(0.95)
  })

  it('symmetry: UP/UP == DOWN/DOWN at same confidence values', () => {
    const resultUU = fuseBtcSignals(makeSignal('up', 0.60), makeLLM('up', 0.70), 0.30)
    const resultDD = fuseBtcSignals(makeSignal('down', 0.60), makeLLM('down', 0.70), 0.30)
    expect(resultUU.confidence).toBeCloseTo(resultDD.confidence, 10)
    expect(resultUU.fusionApplied).toBe(resultDD.fusionApplied)
  })
})
