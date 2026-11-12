import { describe, expect, it } from 'vitest'
import type { UsageForecast, UsageReading, UsageWindow } from '@shared/types'
import { formatHistoryTick, formatHistoryTime, historyChart, historySummary, historyTicks } from './usage-history'

const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR
// Thursday, 12 November 2026, 13:00 in Berlin (the tests run in its time zone).
const NOW = Date.parse('2026-11-12T12:00:00.000Z')
const RESET = NOW + 2 * HOUR

function fiveHour(percent: number, forecast: Partial<UsageForecast> | null = null, resetsAt: number | null = RESET): UsageWindow {
  return {
    key: 'five_hour',
    label: '5-Stunden-Fenster',
    percent,
    resetsAt: resetsAt === null ? null : new Date(resetsAt).toISOString(),
    severity: null,
    forecast: forecast && { exhaustsAt: null, atReset: percent, ratePerHour: 1, basis: 'recent', ...forecast },
  }
}

describe('historyChart', () => {
  it('reaches a day back from the reset of the current window', () => {
    const chart = historyChart([], fiveHour(10), 'five_hour', NOW)
    expect(chart).toMatchObject({ from: RESET - DAY, to: RESET, points: [], resets: [], latest: null, peak: null })
    // Without a current window, up to now.
    expect(historyChart([], null, 'five_hour', NOW)).toMatchObject({ from: NOW - DAY, to: NOW })
    expect(historyChart([], fiveHour(0, null, null), 'five_hour', NOW)).toMatchObject({ from: NOW - DAY, to: NOW })
    expect(historyChart([], null, 'seven_day', NOW)).toMatchObject({ from: NOW - 14 * DAY, to: NOW })
  })

  it('breaks the line at the reset between two windows and marks it', () => {
    const earlier = NOW - 4 * HOUR
    const readings: UsageReading[] = [
      [NOW - 26 * HOUR, 99, NOW - 23 * HOUR],
      [NOW - 6 * HOUR, 20, earlier],
      [NOW - 5 * HOUR, 70, earlier],
      [NOW - 2 * HOUR, 5, RESET + 1000],
      [NOW - HOUR, 30, RESET],
    ]
    const chart = historyChart(readings, fiveHour(30), 'five_hour', NOW)
    expect(chart.points).toEqual([
      { time: NOW - 6 * HOUR, used: 20 },
      { time: NOW - 5 * HOUR, used: 70 },
      { time: earlier, reset: true },
      { time: NOW - 2 * HOUR, used: 5 },
      { time: NOW - HOUR, used: 30 },
    ])
    expect(chart.resets).toEqual([earlier])
    expect(chart).toMatchObject({ latest: 30, peak: 70 })
  })

  it('puts the reset no later than the first reading of the next window', () => {
    // The window ended earlier than it said it would.
    const readings: UsageReading[] = [
      [NOW - 3 * HOUR, 50, NOW - HOUR],
      [NOW - 2 * HOUR, 5, RESET],
    ]
    const chart = historyChart(readings, fiveHour(5), 'five_hour', NOW)
    expect(chart.points.map((p) => p.time)).toEqual([NOW - 3 * HOUR, NOW - 2 * HOUR, NOW - 2 * HOUR])
    expect(chart.resets).toEqual([NOW - 2 * HOUR])
  })

  it('marks the end of the latest window when no new one has begun', () => {
    const readings: UsageReading[] = [
      [NOW - 6 * HOUR, 40, NOW - 3 * HOUR],
      [NOW - 4 * HOUR, 90, NOW - 3 * HOUR],
    ]
    const chart = historyChart(readings, fiveHour(0, { atReset: 50 }, null), 'five_hour', NOW)
    expect(chart.points.at(-1)).toEqual({ time: NOW - 3 * HOUR, reset: true })
    expect(chart.resets).toEqual([NOW - 3 * HOUR])
  })

  it('goes on with the forecast to the reset, or to the moment the window is full', () => {
    const readings: UsageReading[] = [
      [NOW - 2 * HOUR, 10, RESET],
      [NOW - 10 * MIN, 40, RESET],
    ]
    const toReset = historyChart(readings, fiveHour(40, { atReset: 72.5 }), 'five_hour', NOW)
    expect(toReset.points.slice(-2)).toEqual([
      { time: NOW - 10 * MIN, used: 40, forecast: 40 },
      { time: RESET, forecast: 72.5 },
    ])
    const full = NOW + HOUR
    const toFull = historyChart(readings, fiveHour(40, { atReset: 160, exhaustsAt: new Date(full).toISOString() }), 'five_hour', NOW)
    expect(toFull.points.slice(-2)).toEqual([
      { time: NOW - 10 * MIN, used: 40, forecast: 40 },
      { time: full, forecast: 100 },
    ])
    expect(historySummary(toFull, 'five_hour')).toBe(
      'Verlauf der letzten 24 Stunden: zuletzt 40 %, höchstens 40 %, kein Reset, Prognose 100 %',
    )
  })

  it('has no forecast without one, or when the latest reading is of an earlier window', () => {
    const readings: UsageReading[] = [[NOW - HOUR, 30, NOW - 30 * MIN]]
    expect(historyChart(readings, fiveHour(30), 'five_hour', NOW).points.some((p) => 'forecast' in p)).toBe(false)
    const other = historyChart(readings, fiveHour(1, { atReset: 20 }), 'five_hour', NOW)
    expect(other.points.some((p) => 'forecast' in p)).toBe(false)
  })

  it('keeps the values within 0–100', () => {
    const readings: UsageReading[] = [[NOW - HOUR, 104, RESET]]
    const chart = historyChart(readings, fiveHour(104, { atReset: 130 }), 'five_hour', NOW)
    expect(chart.points).toEqual([
      { time: NOW - HOUR, used: 100, forecast: 100 },
      { time: RESET, forecast: 100 },
    ])
  })
})

describe('historyTicks', () => {
  it('names every sixth full hour of the day', () => {
    const ticks = historyTicks('five_hour', RESET - DAY, RESET)
    expect(ticks.map((t) => formatHistoryTick('five_hour', t))).toEqual(['18:00', '00:00', '06:00', '12:00'])
  })

  it('names nothing for a span it cannot tell', () => {
    expect(historyTicks('five_hour', Number.NaN, NOW)).toEqual([])
    expect(historyTicks('seven_day', NOW, Number.NaN)).toEqual([])
  })

  it('names every other day of the weekly window, the newest included', () => {
    const ticks = historyTicks('seven_day', NOW - 14 * DAY, NOW)
    expect(ticks.map((t) => formatHistoryTick('seven_day', t))).toEqual(['31.10.', '2.11.', '4.11.', '6.11.', '8.11.', '10.11.', '12.11.'])
  })
})

describe('formatHistoryTime', () => {
  it('names the weekday, and for the weekly window the day too', () => {
    expect(formatHistoryTime('five_hour', NOW)).toBe('Do., 13:00')
    expect(formatHistoryTime('seven_day', NOW)).toBe('Do., 12.11., 13:00')
  })
})

describe('historySummary', () => {
  it('tells the latest and highest reading and the resets', () => {
    expect(historySummary(historyChart([], null, 'seven_day', NOW), 'seven_day')).toBe('Keine Messwerte der letzten zwei Wochen')
    const readings: UsageReading[] = [
      [NOW - 9 * DAY, 80, NOW - 8 * DAY],
      [NOW - 2 * DAY, 30.4, NOW + 6 * DAY],
    ]
    const chart = historyChart(readings, null, 'seven_day', NOW)
    expect(historySummary(chart, 'seven_day')).toBe('Verlauf der letzten zwei Wochen: zuletzt 30 %, höchstens 80 %, ein Reset')
  })
})
