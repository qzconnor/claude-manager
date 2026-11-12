import { describe, expect, it } from 'vitest'
import type { UsageReading } from './types'
import { addReading, historyPolicy, isUsageReading, sameWindow } from './usage-history'

const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR
const T0 = Date.parse('2026-11-07T08:00:00.000Z')
const RESET = T0 + 5 * HOUR

/** Adds readings `[minutes after T0, percent, reset]` one after another. */
function feed(key: string, readings: [number, number, number][], start: UsageReading[] = []): UsageReading[] {
  return readings.reduce((history, [minutes, percent, reset]) => addReading(history, [T0 + minutes * MIN, percent, reset], key), start)
}

describe('historyPolicy', () => {
  it('keeps two days of the five-hour window and fifteen of the weekly ones', () => {
    expect(historyPolicy('five_hour')).toEqual({ keepMs: 2 * DAY, spacingMs: 5 * MIN })
    expect(historyPolicy('seven_day')).toEqual({ keepMs: 15 * DAY, spacingMs: 30 * MIN })
    expect(historyPolicy('seven_day_opus')).toEqual({ keepMs: 15 * DAY, spacingMs: 30 * MIN })
    expect(historyPolicy('extra')).toBeNull()
  })
})

describe('sameWindow', () => {
  it('allows the reset to wobble a little, but not by a window', () => {
    expect(sameWindow(RESET, RESET + 1234, 'five_hour')).toBe(true)
    expect(sameWindow(RESET, RESET - 29 * MIN, 'five_hour')).toBe(true)
    expect(sameWindow(RESET, RESET + 30 * MIN, 'five_hour')).toBe(false)
    expect(sameWindow(RESET, RESET + 5 * HOUR, 'five_hour')).toBe(false)
    expect(sameWindow(RESET, RESET + 12 * HOUR, 'seven_day')).toBe(true)
    expect(sameWindow(RESET, RESET + 7 * DAY, 'seven_day')).toBe(false)
    expect(sameWindow(RESET, RESET, 'extra')).toBe(false)
  })
})

describe('addReading', () => {
  it('adds readings that are far enough apart', () => {
    const history = feed('five_hour', [
      [0, 1, RESET],
      [5, 4, RESET],
      [10, 9, RESET],
    ])
    expect(history).toEqual([
      [T0, 1, RESET],
      [T0 + 5 * MIN, 4, RESET],
      [T0 + 10 * MIN, 9, RESET],
    ])
  })

  it('lets a new reading take the place of the latest while that is too close to the one before', () => {
    // Claude Code's own cache is read every 30 seconds.
    const history = feed(
      'five_hour',
      Array.from({ length: 13 }, (_, i): [number, number, number] => [i / 2, i, RESET]),
    )
    // The one of 5:00 is far enough from 0:00: the one of 4:30 stays, and the next ones take turns after it.
    expect(history).toEqual([
      [T0, 0, RESET],
      [T0 + 4.5 * MIN, 9, RESET],
      [T0 + 6 * MIN, 12, RESET],
    ])
  })

  it('keeps the last reading of a window and the first of the next', () => {
    const next = RESET + 5 * HOUR + 20 * MIN
    const history = feed('five_hour', [
      [0, 10, RESET],
      [4, 80, RESET],
      [320, 2, next],
      [321, 3, next],
      [322, 4, next],
    ])
    expect(history).toEqual([
      [T0, 10, RESET],
      [T0 + 4 * MIN, 80, RESET],
      [T0 + 320 * MIN, 2, next],
      [T0 + 322 * MIN, 4, next],
    ])
    // Also when the next window follows within minutes.
    const close = feed('five_hour', [
      [0, 10, RESET],
      [1, 80, RESET],
      [2, 2, next],
      [3, 3, next],
    ])
    expect(close.map(([time]) => (time - T0) / MIN)).toEqual([0, 1, 2, 3])
  })

  it('counts a reset that wobbles a little as the same window', () => {
    const history = feed('five_hour', [
      [0, 1, RESET],
      [1, 2, RESET + 800],
      [2, 3, RESET - 400],
    ])
    expect(history).toEqual([
      [T0, 1, RESET],
      [T0 + 2 * MIN, 3, RESET - 400],
    ])
  })

  it('leaves out readings that are not newer than the latest', () => {
    const start = feed('five_hour', [
      [0, 1, RESET],
      [10, 5, RESET],
    ])
    expect(addReading(start, [T0 + 10 * MIN, 6, RESET], 'five_hour')).toEqual(start)
    expect(addReading(start, [T0 + 3 * MIN, 6, RESET], 'five_hour')).toEqual(start)
  })

  it('drops what is older than the window keeps', () => {
    const weekly = (days: number, percent: number): UsageReading => [T0 + days * DAY, percent, T0 + 7 * DAY]
    let history: UsageReading[] = []
    for (const day of [0, 1, 14, 15, 16]) history = addReading(history, weekly(day, day), 'seven_day')
    expect(history.map(([time]) => (time - T0) / DAY)).toEqual([14, 15, 16])
    history = feed('five_hour', [
      [0, 1, RESET],
      [2 * 24 * 60 - 1, 2, RESET + 2 * DAY],
      [2 * 24 * 60, 3, RESET + 2 * DAY],
    ])
    expect(history.map(([, percent]) => percent)).toEqual([2, 3])
  })

  it('keeps nothing for windows of unknown length', () => {
    expect(addReading([], [T0, 1, RESET], 'extra')).toEqual([])
  })
})

describe('isUsageReading', () => {
  it('takes three finite numbers', () => {
    expect(isUsageReading([T0, 1, RESET])).toBe(true)
    expect(isUsageReading([T0, 1])).toBe(false)
    expect(isUsageReading([T0, Number.NaN, RESET])).toBe(false)
    expect(isUsageReading([T0, '1', RESET])).toBe(false)
    expect(isUsageReading(null)).toBe(false)
  })
})
