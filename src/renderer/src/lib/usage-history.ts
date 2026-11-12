import type { UsageReading, UsageWindow } from '@shared/types'
import { sameWindow } from '@shared/usage-history'

/** The curve of a usage window on the usage page: its readings, where it reset, and where it heads. */

const HOUR_MS = 3_600_000
const DAY_MS = 24 * HOUR_MS

export type HistoryKind = 'five_hour' | 'seven_day'

/** How far a curve reaches back from the reset of the current window: a day of five-hour windows, this week and the last. */
export const HISTORY_SPAN_MS: Record<HistoryKind, number> = { five_hour: DAY_MS, seven_day: 14 * DAY_MS }

export interface HistoryPoint {
  time: number
  /** How full the window was. Missing where the line breaks (a reset) and on the forecast. */
  used?: number
  /** Where the window heads at the current pace, from the latest reading on. */
  forecast?: number
  /** A window reset here. */
  reset?: true
}

export interface HistoryChart {
  points: HistoryPoint[]
  /** The resets within the curve that are past. */
  resets: number[]
  from: number
  /** The reset of the current window, or now when there is none. */
  to: number
  /** Where the axis names the time. */
  ticks: number[]
  /** The latest reading and the highest one of the curve, in percent; null without readings. */
  latest: number | null
  peak: number | null
}

const clamp = (percent: number) => Math.min(100, Math.max(0, percent))

/**
 * The curve of a window from its readings (oldest first) and its current state. A window's line ends
 * at its reset, the next one begins with its first reading. The forecast goes on from the latest
 * reading to the moment the window is full, or to its reset.
 */
export function historyChart(readings: UsageReading[], window: UsageWindow | null, kind: HistoryKind, now: number): HistoryChart {
  const upcoming = window?.resetsAt ? Date.parse(window.resetsAt) : NaN
  const to = upcoming > now ? upcoming : now
  const from = to - HISTORY_SPAN_MS[kind]
  const shown = readings.filter(([time]) => time >= from && time <= now)
  const points: HistoryPoint[] = []
  const resets: number[] = []
  const resetAt = (time: number) => {
    points.push({ time, reset: true })
    resets.push(time)
  }
  shown.forEach(([time, percent, reset], index) => {
    const before = shown[index - 1]
    // The window before ended at its reset (between its last reading and this one).
    if (before && !sameWindow(before[2], reset, kind)) resetAt(Math.min(Math.max(before[2], before[0]), time))
    points.push({ time, used: clamp(percent) })
  })
  const last = shown.at(-1)
  // The latest window is over too, and no new one has begun.
  if (last && last[2] <= now) resetAt(Math.max(last[2], last[0]))

  const forecast = window?.forecast
  if (last && forecast && upcoming > now && sameWindow(last[2], upcoming, kind)) {
    const full = forecast.exhaustsAt ? Date.parse(forecast.exhaustsAt) : NaN
    const end = full < upcoming ? full : upcoming
    if (end > last[0]) {
      points[points.length - 1]!.forecast = clamp(last[1])
      points.push({ time: end, forecast: full < upcoming ? 100 : clamp(forecast.atReset) })
    }
  }

  const used = shown.map(([, percent]) => clamp(percent))
  return {
    points,
    resets,
    from,
    to,
    ticks: historyTicks(kind, from, to),
    latest: used.at(-1) ?? null,
    peak: used.length ? Math.max(...used) : null,
  }
}

/** Full local hours every six hours, or every other local midnight for the weekly window. */
export function historyTicks(kind: HistoryKind, from: number, to: number): number[] {
  const ticks: number[] = []
  if (!Number.isFinite(from) || !Number.isFinite(to)) return ticks
  const cursor = new Date(from)
  if (kind === 'five_hour') {
    cursor.setMinutes(0, 0, 0)
    while (cursor.getTime() < from || cursor.getHours() % 6 !== 0) cursor.setHours(cursor.getHours() + 1)
    for (; cursor.getTime() <= to; cursor.setHours(cursor.getHours() + 6)) ticks.push(cursor.getTime())
  } else {
    cursor.setHours(0, 0, 0, 0)
    if (cursor.getTime() < from) cursor.setDate(cursor.getDate() + 1)
    // Every other day, counted back from the last one, so the newest days are named.
    const days: number[] = []
    for (; cursor.getTime() <= to; cursor.setDate(cursor.getDate() + 1)) days.push(cursor.getTime())
    ticks.push(...days.filter((_, index) => (days.length - 1 - index) % 2 === 0))
  }
  return ticks
}

const hourFormat = new Intl.DateTimeFormat('de', { hour: '2-digit', minute: '2-digit' })
const dayFormat = new Intl.DateTimeFormat('de', { day: 'numeric', month: 'numeric' })
const pointFormat = {
  five_hour: new Intl.DateTimeFormat('de', { weekday: 'short', hour: '2-digit', minute: '2-digit' }),
  seven_day: new Intl.DateTimeFormat('de', { weekday: 'short', day: 'numeric', month: 'numeric', hour: '2-digit', minute: '2-digit' }),
}

/** What the axis says at a tick: the hour, or the day. */
export function formatHistoryTick(kind: HistoryKind, time: number): string {
  return kind === 'five_hour' ? hourFormat.format(time) : dayFormat.format(time)
}

/** When a point of the curve was, for its tooltip. */
export function formatHistoryTime(kind: HistoryKind, time: number): string {
  return pointFormat[kind].format(time)
}

/** The curve in words, for screen readers. */
export function historySummary(chart: HistoryChart, kind: HistoryKind): string {
  const span = kind === 'five_hour' ? 'der letzten 24 Stunden' : 'der letzten zwei Wochen'
  if (chart.latest === null) return `Keine Messwerte ${span}`
  const count = chart.resets.length
  const resets = count === 0 ? 'kein Reset' : count === 1 ? 'ein Reset' : `${count} Resets`
  const ahead = chart.points.at(-1)?.forecast
  const forecast = ahead === undefined ? '' : `, Prognose ${Math.round(ahead)} %`
  return `Verlauf ${span}: zuletzt ${Math.round(chart.latest)} %, höchstens ${Math.round(chart.peak!)} %, ${resets}${forecast}`
}
