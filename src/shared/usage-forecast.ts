import type { UsageForecast, UsageWindow } from './types'

/**
 * Where a usage window heads at the current pace: when it reaches 100 % and how full it is at the
 * reset. The pace comes from the readings of the last while (an hour for the five-hour window, a day
 * for the weekly ones); without enough of them, from the average since the window began.
 */

const HOUR_MS = 3_600_000

/** A reading of a window: [time in ms, percent]. */
export type UsageSample = [number, number]

/** How long a window lasts, by its key; null for windows of unknown length. */
export function windowLengthMs(key: string): number | null {
  if (key === 'five_hour') return 5 * HOUR_MS
  if (key === 'seven_day' || key.startsWith('seven_day_') || key.startsWith('weekly_')) return 7 * 24 * HOUR_MS
  return null
}

/** The stretch of readings the current pace is taken from. */
function lookbackMs(length: number): number {
  return Math.min(length / 5, 24 * HOUR_MS)
}

/**
 * Adds a reading and keeps those of the current window, oldest first. A reading that isn't newer
 * than the last one is left out. One clearly below the one before it means the window started over:
 * the older ones are dropped then.
 */
export function addSample(samples: UsageSample[], sample: UsageSample, windowStart: number, max = 500): UsageSample[] {
  const [time, percent] = sample
  const current = samples.filter(([t]) => t >= windowStart)
  const last = current.at(-1)
  if (time < windowStart || (last && time <= last[0])) return current
  const kept = last && percent < last[1] - 1 ? [] : current
  return [...kept, sample].slice(-max)
}

/** The start of a window that resets at `resetsAt`; null for windows of unknown length or without reset. */
export function windowStart(window: Pick<UsageWindow, 'key' | 'resetsAt'>): number | null {
  const length = windowLengthMs(window.key)
  const reset = window.resetsAt ? Date.parse(window.resetsAt) : NaN
  return length === null || Number.isNaN(reset) ? null : reset - length
}

/**
 * The forecast for a window from its readings (oldest first, the latest being the window's current
 * value). Null without a reset time, at 100 % already, or while there is too little to go by.
 */
export function forecastWindow(window: UsageWindow, samples: UsageSample[]): UsageForecast | null {
  const length = windowLengthMs(window.key)
  const reset = window.resetsAt ? Date.parse(window.resetsAt) : NaN
  if (length === null || Number.isNaN(reset)) return null
  const start = reset - length
  const readings = samples.filter(([t]) => t >= start && t < reset)
  const last = readings.at(-1)
  if (!last) return null
  const [now, percent] = last
  if (percent >= 100) return null

  const lookback = lookbackMs(length)
  const minSpan = lookback / 3
  // The reading a lookback ago, or the oldest one when they don't reach back that far.
  const from = readings.filter(([t]) => t <= now - lookback).at(-1) ?? readings[0]!
  let rate: number
  let basis: UsageForecast['basis']
  if (now - from[0] >= minSpan) {
    rate = Math.max(0, (percent - from[1]) / (now - from[0]))
    basis = 'recent'
  } else if (now - start >= minSpan) {
    // The window begins with the first message: before that, nothing was used.
    rate = percent / (now - start)
    basis = 'window'
  } else {
    return null
  }

  const exhaustsAt = rate > 0 ? now + (100 - percent) / rate : Infinity
  return {
    exhaustsAt: exhaustsAt < reset ? new Date(Math.round(exhaustsAt)).toISOString() : null,
    atReset: Math.round((percent + rate * (reset - now)) * 10) / 10,
    ratePerHour: Math.round(rate * HOUR_MS * 100) / 100,
    basis,
  }
}
