import { describe, expect, it } from 'vitest'
import { answerCost, modelKey, modelPrice, type PricedTokens } from './model-prices'

const tokens = (extra: Partial<PricedTokens>): PricedTokens => ({
  input: 0,
  output: 0,
  cacheCreation: 0,
  cacheCreation1h: 0,
  cacheRead: 0,
  fast: false,
  ...extra,
})
const MILLION = 1_000_000

describe('modelKey', () => {
  it.each([
    ['claude-fable-5-2', 'fable-5.2'],
    ['claude-fable-5', 'fable-5'],
    ['claude-opus-5-5', 'opus-5.5'],
    ['claude-opus-4-1-20250805', 'opus-4.1'],
    ['claude-opus-4-20250514', 'opus-4'],
    ['claude-sonnet-4-5-20250929', 'sonnet-4.5'],
    ['claude-haiku-4-5-20251001', 'haiku-4.5'],
    ['claude-opus-4-6[1m]', 'opus-4.6'],
    ['us.anthropic.claude-opus-4-6-v1:0', 'opus-4.6'],
    ['claude-opus-4-5@20251101', 'opus-4.5'],
    ['claude-3-7-sonnet-20250219', 'sonnet-3.7'],
    ['claude-3-haiku-20240307', 'haiku-3'],
    ['Claude-Opus-4-6', 'opus-4.6'],
  ])('knows %s as %s', (model, key) => {
    expect(modelKey(model)).toBe(key)
  })

  it('knows no other models', () => {
    expect(modelKey('gpt-5')).toBeNull()
    expect(modelKey('unknown')).toBeNull()
    expect(modelKey('<synthetic>')).toBeNull()
  })
})

describe('modelPrice', () => {
  it('has the prices of the API', () => {
    expect(modelPrice('claude-opus-5-5')).toMatchObject({ input: 4, output: 20, cacheRead: 0.2, fast: 2 })
    expect(modelPrice('claude-sonnet-4-6')).toMatchObject({ input: 3, output: 15, cacheRead: 0.3 })
    expect(modelPrice('claude-opus-4-1-20250805')).toMatchObject({ input: 15, output: 75 })
    expect(modelPrice('claude-opus-9-9')).toBeNull()
  })
})

describe('answerCost', () => {
  it('adds input, output and cache at their prices', () => {
    const cost = answerCost('claude-opus-4-6', tokens({ input: MILLION, output: MILLION, cacheRead: MILLION }))
    expect(cost).toBeCloseTo(5 + 25 + 0.5)
  })

  it('prices cache writes for five minutes at 1.25 times the input, for an hour at twice', () => {
    expect(answerCost('claude-opus-4-6', tokens({ cacheCreation: MILLION }))).toBeCloseTo(6.25)
    expect(answerCost('claude-opus-4-6', tokens({ cacheCreation: MILLION, cacheCreation1h: MILLION }))).toBeCloseTo(10)
    expect(answerCost('claude-opus-4-6', tokens({ cacheCreation: 2 * MILLION, cacheCreation1h: MILLION }))).toBeCloseTo(16.25)
  })

  it('doubles everything in fast mode on the models that have it', () => {
    expect(answerCost('claude-opus-5-5', tokens({ output: MILLION, cacheRead: MILLION, fast: true }))).toBeCloseTo(40.4)
    // Without fast mode of its own, the normal price.
    expect(answerCost('claude-sonnet-4-6', tokens({ output: MILLION, fast: true }))).toBeCloseTo(15)
  })

  it('prices long prompts of Claude Haiku 5.5 higher, cache included', () => {
    expect(answerCost('claude-haiku-5-5', tokens({ input: 100_000, output: MILLION }))).toBeCloseTo(0.01 + 0.5)
    expect(answerCost('claude-haiku-5-5', tokens({ input: 1000, cacheRead: 100_000, output: MILLION }))).toBeCloseTo(0.0005 + 0.005 + 2.5)
  })

  it('knows no cost for models without a price', () => {
    expect(answerCost('unknown', tokens({ output: 10 }))).toBeNull()
  })
})
