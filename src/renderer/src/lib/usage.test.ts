import { describe, expect, it } from 'vitest'
import type { UsageWindow } from '@shared/types'
import { clampPercent, usageLevel, windowIdle } from './usage'

describe('clampPercent', () => {
  it('rounds to whole percent', () => {
    expect(clampPercent(49.4)).toBe(49)
    expect(clampPercent(49.5)).toBe(50)
  })

  it('clamps to 0–100', () => {
    expect(clampPercent(-5)).toBe(0)
    expect(clampPercent(100.4)).toBe(100)
    expect(clampPercent(130)).toBe(100)
  })
})

describe('usageLevel', () => {
  it('is low below 60, medium from 60 and high from 85', () => {
    expect(usageLevel(0)).toBe('low')
    expect(usageLevel(59.9)).toBe('low')
    expect(usageLevel(60)).toBe('medium')
    expect(usageLevel(84.9)).toBe('medium')
    expect(usageLevel(85)).toBe('high')
    expect(usageLevel(100)).toBe('high')
  })
})

describe('windowIdle', () => {
  const usageWindow = (percent: number, resetsAt: string | null): UsageWindow => ({
    key: 'five_hour',
    label: '5h',
    percent,
    resetsAt,
    severity: null,
  })

  it('is idle without a reset time and without usage', () => {
    expect(windowIdle(usageWindow(0, null))).toBe(true)
    expect(windowIdle(usageWindow(0.4, null))).toBe(true)
  })

  it('is not idle once used or with a reset time', () => {
    expect(windowIdle(usageWindow(1, null))).toBe(false)
    expect(windowIdle(usageWindow(0, '2026-11-06T15:00:00Z'))).toBe(false)
  })
})
