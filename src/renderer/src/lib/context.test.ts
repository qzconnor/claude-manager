import { describe, expect, it } from 'vitest'
import { contextGauge, modelName, shortTokens } from './context'

describe('contextGauge', () => {
  it('measures the context against where Claude Code compacts', () => {
    const gauge = contextGauge({ tokens: 183_500, compactAt: 367_000, window: 400_000, configured: true, model: null })
    expect(gauge).toEqual({ limit: 367_000, percent: 50, left: 183_500, buffer: 33_000 })
  })

  it('is empty before the first answer', () => {
    const gauge = contextGauge({ tokens: null, compactAt: 367_000, window: 400_000, configured: true, model: null })
    expect(gauge).toEqual({ limit: 367_000, percent: 0, left: 367_000, buffer: 33_000 })
  })

  it('takes the whole window when auto-compact is off, and stops at full', () => {
    expect(contextGauge({ tokens: 100_000, compactAt: null, window: 200_000, configured: false, model: null })).toMatchObject({
      limit: 200_000,
      percent: 50,
      buffer: 0,
    })
    expect(contextGauge({ tokens: 380_000, compactAt: 367_000, window: 400_000, configured: true, model: null })).toMatchObject({
      percent: 100,
      left: 0,
    })
  })
})

describe('shortTokens', () => {
  it('writes tokens as Claude Code does', () => {
    expect(shortTokens(850)).toBe('850')
    expect(shortTokens(136_004)).toBe('136k')
    expect(shortTokens(367_000)).toBe('367k')
    expect(shortTokens(1_000_000)).toBe('1M')
    expect(shortTokens(1_250_000)).toBe('1,3M')
  })
})

describe('modelName', () => {
  it('names Claude models short', () => {
    expect(modelName('claude-opus-5-5')).toBe('Opus 5.5')
    expect(modelName('claude-sonnet-5')).toBe('Sonnet 5')
    expect(modelName('claude-haiku-4-5-20251001')).toBe('Haiku 4.5')
    expect(modelName('claude-fable-5-2')).toBe('Fable 5.2')
    expect(modelName('gpt-4')).toBeNull()
    expect(modelName(null)).toBeNull()
  })
})
