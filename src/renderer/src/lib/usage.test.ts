import { describe, expect, it } from 'vitest'
import type { UsageWindow } from '@shared/types'
import { clampPercent, forecastHint, usageLevel, windowIdle } from './usage'

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

describe('forecastHint', () => {
  const NOW = Date.parse('2026-11-07T12:00:00Z')
  const window = (percent: number, forecast: UsageWindow['forecast']): UsageWindow => ({
    key: 'five_hour',
    label: '5h',
    percent,
    resetsAt: '2026-11-07T15:00:00Z',
    severity: null,
    forecast,
  })

  it('warns when the limit comes before the reset, and says how much earlier', () => {
    const hint = forecastHint(
      window(60, { exhaustsAt: '2026-11-07T13:00:00Z', atReset: 120, ratePerHour: 40, basis: 'recent' }),
      NOW,
    )
    expect(hint?.warn).toBe(true)
    expect(hint?.text).toMatch(/^Limit ≈ \d\d:00$/)
    expect(hint?.title).toContain('40 Punkte pro Stunde')
    expect(hint?.title).toContain('2 Std. vor dem Reset')
  })

  it('tells how full the window will be at the reset otherwise', () => {
    const hint = forecastHint(window(30, { exhaustsAt: null, atReset: 52.4, ratePerHour: 7.5, basis: 'window' }), NOW)
    expect(hint).toMatchObject({ text: '≈ 52 % zum Reset', warn: false })
    expect(hint?.title).toContain('Schnitt seit Beginn des Fensters')
  })

  it('says nothing without a forecast, without growth or once the time has passed', () => {
    expect(forecastHint(window(30, null), NOW)).toBeNull()
    expect(forecastHint(window(30, { exhaustsAt: null, atReset: 30, ratePerHour: 0, basis: 'recent' }), NOW)).toBeNull()
    expect(
      forecastHint(window(90, { exhaustsAt: '2026-11-07T11:00:00Z', atReset: 140, ratePerHour: 20, basis: 'recent' }), NOW),
    ).toBeNull()
  })
})
