import type { UsageReading } from './types'
import { windowLengthMs } from './usage-forecast'

/**
 * The history of a usage window: readings of the last days for the curves on the usage page. Unlike
 * the readings for the forecast it reaches over resets: each reading names the reset of its window,
 * so the curve can tell where one window ended and the next began.
 */

const MINUTE_MS = 60_000
const DAY_MS = 24 * 60 * MINUTE_MS

/** How long readings of a window are kept, and how far apart they are at least (the latest is always kept). */
export function historyPolicy(key: string): { keepMs: number; spacingMs: number } | null {
  const length = windowLengthMs(key)
  if (length === null) return null
  // A day of five-hour windows; the weekly windows of this week and the last.
  return length < DAY_MS ? { keepMs: 2 * DAY_MS, spacingMs: 5 * MINUTE_MS } : { keepMs: 15 * DAY_MS, spacingMs: 30 * MINUTE_MS }
}

/**
 * Whether two resets belong to the same window. The usage API doesn't always name the reset to the
 * millisecond, and a new window can only reset a whole window length after the last one.
 */
export function sameWindow(a: number, b: number, key: string): boolean {
  const length = windowLengthMs(key)
  return length !== null && Math.abs(a - b) < length / 10
}

/**
 * Adds a reading to the history of a window (oldest first). A reading that isn't newer than the last
 * one is left out, those older than the window keeps them are dropped. Within a window the readings
 * keep about `spacingMs` apart: a new one takes the place of the latest while it is closer than that
 * to the one before, so the curve keeps its shape at a steady size.
 */
export function addReading(history: UsageReading[], reading: UsageReading, key: string): UsageReading[] {
  const policy = historyPolicy(key)
  if (!policy) return history
  const [time] = reading
  const kept = history.filter(([t]) => t > time - policy.keepMs)
  const last = kept.at(-1)
  if (last && time <= last[0]) return kept
  const before = kept.at(-2)
  if (
    last &&
    before &&
    sameWindow(last[2], reading[2], key) &&
    sameWindow(before[2], reading[2], key) &&
    time - before[0] < policy.spacingMs
  ) {
    return [...kept.slice(0, -1), reading]
  }
  return [...kept, reading]
}

export function isUsageReading(value: unknown): value is UsageReading {
  return Array.isArray(value) && value.length === 3 && value.every((n) => typeof n === 'number' && Number.isFinite(n))
}
