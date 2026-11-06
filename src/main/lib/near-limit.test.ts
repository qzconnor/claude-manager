import { describe, expect, it } from 'vitest'
import type { AccountUsage, UsageWindow } from '@shared/types'
import { nearLimits, type WarnedWindows } from './near-limit'

const NOW = Date.parse('2026-11-06T12:00:00Z')
const LATER = '2026-11-06T15:00:00.255242+00:00'
const EARLIER = '2026-11-06T11:00:00+00:00'

function window(key: string, percent: number, resetsAt: string | null = LATER): UsageWindow {
  return { key, label: key, percent, resetsAt, severity: null }
}

function usage(windows: { fiveHour?: UsageWindow; sevenDay?: UsageWindow; scoped?: UsageWindow[] }, accountId = 'a'): AccountUsage {
  return {
    accountId,
    status: 'ok',
    source: 'live',
    fetchedAt: null,
    message: null,
    fiveHour: windows.fiveHour ?? null,
    sevenDay: windows.sevenDay ?? null,
    scoped: windows.scoped ?? [],
    extra: null,
    breakdown: [],
    nextRefreshAt: null,
  }
}

const keys = (reached: ReturnType<typeof nearLimits>) => reached.map((r) => `${r.window.key} ${r.percent}`)

describe('nearLimits', () => {
  it('warns about windows at or above the threshold, rounded like in the app', () => {
    const warned: WarnedWindows = {}
    const reached = nearLimits(usage({ fiveHour: window('five_hour', 79.6), sevenDay: window('seven_day', 79.4) }), 80, warned, NOW)
    expect(keys(reached)).toEqual(['five_hour 80'])
    expect(warned).toEqual({ 'a\nfive_hour': LATER })
  })

  it('clamps the percentage to 0–100', () => {
    expect(keys(nearLimits(usage({ fiveHour: window('five_hour', 130) }), 80, {}, NOW))).toEqual(['five_hour 100'])
  })

  it('sorts several windows highest first', () => {
    const reached = nearLimits(
      usage({ fiveHour: window('five_hour', 85), sevenDay: window('seven_day', 97), scoped: [window('opus', 90)] }),
      80,
      {},
      NOW,
    )
    expect(keys(reached)).toEqual(['seven_day 97', 'opus 90', 'five_hour 85'])
  })

  it('warns once per window, even when the value moves around the threshold', () => {
    const warned: WarnedWindows = {}
    expect(nearLimits(usage({ fiveHour: window('five_hour', 81) }), 80, warned, NOW)).toHaveLength(1)
    expect(nearLimits(usage({ fiveHour: window('five_hour', 79) }), 80, warned, NOW)).toHaveLength(0)
    expect(nearLimits(usage({ fiveHour: window('five_hour', 83) }), 80, warned, NOW)).toHaveLength(0)
  })

  it('warns again after the value fell more than the margin below the threshold', () => {
    const warned: WarnedWindows = {}
    nearLimits(usage({ fiveHour: window('five_hour', 81) }), 80, warned, NOW)
    nearLimits(usage({ fiveHour: window('five_hour', 74) }), 80, warned, NOW)
    expect(warned).toEqual({})
    expect(nearLimits(usage({ fiveHour: window('five_hour', 80) }), 80, warned, NOW)).toHaveLength(1)
  })

  it('warns again once the remembered reset has passed, e.g. after a restart', () => {
    const warned: WarnedWindows = { 'a\nfive_hour': EARLIER }
    expect(nearLimits(usage({ fiveHour: window('five_hour', 90) }), 80, warned, NOW)).toHaveLength(1)
    expect(warned['a\nfive_hour']).toBe(LATER)
  })

  it('stays quiet after a restart within the same window', () => {
    const warned: WarnedWindows = { 'a\nfive_hour': LATER }
    expect(nearLimits(usage({ fiveHour: window('five_hour', 90) }), 80, warned, NOW)).toHaveLength(0)
  })

  it('warns again when the threshold was raised past the margin', () => {
    const warned: WarnedWindows = {}
    nearLimits(usage({ sevenDay: window('seven_day', 82) }), 80, warned, NOW)
    expect(nearLimits(usage({ sevenDay: window('seven_day', 82) }), 90, warned, NOW)).toHaveLength(0)
    expect(warned).toEqual({})
    expect(nearLimits(usage({ sevenDay: window('seven_day', 91) }), 90, warned, NOW)).toHaveLength(1)
  })

  it('forgets windows that disappeared once they would have reset, but only of this account', () => {
    const warned: WarnedWindows = {
      'a\nopus': EARLIER,
      'a\nsonnet': LATER,
      'a\nunknown': null,
      'b\nopus': EARLIER,
    }
    nearLimits(usage({ fiveHour: window('five_hour', 10) }), 80, warned, NOW)
    expect(warned).toEqual({ 'a\nsonnet': LATER, 'b\nopus': EARLIER })
  })

  it('keeps a warning without a reset time until the value falls back', () => {
    const warned: WarnedWindows = {}
    nearLimits(usage({ fiveHour: window('five_hour', 85, null) }), 80, warned, NOW)
    expect(nearLimits(usage({ fiveHour: window('five_hour', 85, null) }), 80, warned, NOW)).toHaveLength(0)
    expect(warned).toEqual({ 'a\nfive_hour': null })
  })
})
