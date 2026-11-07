import { describe, expect, it } from 'vitest'
import type { UsageWindow } from './types'
import { addSample, forecastWindow, windowLengthMs, windowStart, type UsageSample } from './usage-forecast'

const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR
const RESET = Date.parse('2026-11-07T18:00:00.000Z')

function fiveHour(percent: number, resetsAt: number | null = RESET): UsageWindow {
  return {
    key: 'five_hour',
    label: '5-Stunden-Fenster',
    percent,
    resetsAt: resetsAt === null ? null : new Date(resetsAt).toISOString(),
    severity: null,
  }
}

/** Readings `minutesBeforeReset → percent`, oldest first. */
function readings(...points: [number, number][]): UsageSample[] {
  return points.map(([minutes, percent]) => [RESET - minutes * MIN, percent])
}

describe('windowLengthMs', () => {
  it('knows the five-hour and the weekly windows', () => {
    expect(windowLengthMs('five_hour')).toBe(5 * HOUR)
    expect(windowLengthMs('seven_day')).toBe(7 * DAY)
    expect(windowLengthMs('seven_day_opus')).toBe(7 * DAY)
    expect(windowLengthMs('weekly_opus:Opus')).toBe(7 * DAY)
    expect(windowLengthMs('extra')).toBeNull()
  })
})

describe('windowStart', () => {
  it('is the reset minus the length of the window', () => {
    expect(windowStart(fiveHour(10))).toBe(RESET - 5 * HOUR)
    expect(windowStart(fiveHour(10, null))).toBeNull()
  })
})

describe('addSample', () => {
  const start = RESET - 5 * HOUR

  it('appends newer readings and drops those of an earlier window', () => {
    const before: UsageSample[] = [
      [start - HOUR, 80],
      [start + HOUR, 10],
    ]
    expect(addSample(before, [start + 2 * HOUR, 20], start)).toEqual([
      [start + HOUR, 10],
      [start + 2 * HOUR, 20],
    ])
  })

  it('leaves out a reading that is not newer than the last one', () => {
    const before: UsageSample[] = [[start + HOUR, 10]]
    expect(addSample(before, [start + HOUR, 12], start)).toEqual(before)
    expect(addSample(before, [start + 30 * MIN, 5], start)).toEqual(before)
  })

  it('starts over when the usage drops clearly, but not for a small dip', () => {
    const before: UsageSample[] = [[start + HOUR, 40]]
    expect(addSample(before, [start + 2 * HOUR, 39.5], start)).toHaveLength(2)
    expect(addSample(before, [start + 2 * HOUR, 3], start)).toEqual([[start + 2 * HOUR, 3]])
  })

  it('keeps at most `max` readings', () => {
    let samples: UsageSample[] = []
    for (let i = 0; i < 10; i++) samples = addSample(samples, [start + i * MIN, i], start, 4)
    expect(samples.map(([, p]) => p)).toEqual([6, 7, 8, 9])
  })
})

describe('forecastWindow', () => {
  it('takes the pace of the last hour and tells when the five-hour window runs out', () => {
    // 4 h before the reset at 40 %, 3 h before at 60 %: 20 points an hour, 100 % in two more hours.
    const forecast = forecastWindow(fiveHour(60), readings([240, 40], [210, 50], [180, 60]))
    expect(forecast).toEqual({
      exhaustsAt: new Date(RESET - HOUR).toISOString(),
      atReset: 120,
      ratePerHour: 20,
      basis: 'recent',
    })
  })

  it('reports no time when the window lasts until the reset', () => {
    const forecast = forecastWindow(fiveHour(30), readings([120, 20], [60, 30]))
    expect(forecast?.exhaustsAt).toBeNull()
    expect(forecast?.atReset).toBe(40)
    expect(forecast?.basis).toBe('recent')
  })

  it('sees a pause: no usage in the last hour means the window lasts', () => {
    const forecast = forecastWindow(fiveHour(70), readings([240, 10], [200, 70], [130, 70], [120, 70]))
    expect(forecast).toMatchObject({ exhaustsAt: null, atReset: 70, ratePerHour: 0 })
  })

  it('falls back to the average since the window began without enough readings', () => {
    // The window began 5 h before the reset; 2 h in, at 50 %: 25 points an hour.
    const forecast = forecastWindow(fiveHour(50), readings([180, 50]))
    expect(forecast).toEqual({
      exhaustsAt: new Date(RESET - HOUR).toISOString(),
      atReset: 125,
      ratePerHour: 25,
      basis: 'window',
    })
  })

  it('waits while the window is too young to tell', () => {
    expect(forecastWindow(fiveHour(5), readings([290, 5]))).toBeNull()
  })

  it('has nothing to say at 100 %, without a reset or without readings', () => {
    expect(forecastWindow(fiveHour(100), readings([240, 40], [180, 100]))).toBeNull()
    expect(forecastWindow(fiveHour(40, null), readings([240, 40]))).toBeNull()
    expect(forecastWindow(fiveHour(40), [])).toBeNull()
  })

  it('takes a day of readings for a weekly window', () => {
    const week: UsageWindow = { ...fiveHour(50), key: 'seven_day', label: 'Woche' }
    // A day ago at 30 %, now at 50 %: 20 points a day; 2.5 more days to 100 %, the reset is in 2 days.
    const now = RESET - 2 * DAY
    const forecast = forecastWindow(week, [
      [now - 3 * DAY, 10],
      [now - DAY, 30],
      [now - 12 * HOUR, 40],
      [now, 50],
    ])
    expect(forecast).toMatchObject({ exhaustsAt: null, atReset: 90, basis: 'recent' })
  })
})
