import type { AccountUsage, UsageWindow } from '@shared/types'

/**
 * A window that was warned about only warns again once its usage fell this many points below the
 * threshold (its reset, a higher threshold), so values around the threshold don't warn twice.
 */
const REARM_MARGIN = 5

/** Windows that were warned about: `<account>\n<window>` → when that window resets (ISO), if known. */
export type WarnedWindows = Record<string, string | null>

export interface NearLimit {
  window: UsageWindow
  /** Rounded like in the app, 0–100. */
  percent: number
}

/**
 * The limit windows of an account that reached `threshold` since they were last warned about,
 * highest first. `warned` is updated: they are added, and windows whose reset passed or whose
 * usage fell back below the threshold are removed, so their next window warns again.
 */
export function nearLimits(usage: AccountUsage, threshold: number, warned: WarnedWindows, now: number): NearLimit[] {
  const windows = [usage.fiveHour, usage.sevenDay, ...usage.scoped].filter((w): w is UsageWindow => w !== null)
  const prefix = `${usage.accountId}\n`
  const seen = new Set<string>()
  const reached: NearLimit[] = []
  for (const window of windows) {
    const key = prefix + window.key
    seen.add(key)
    const percent = Math.max(0, Math.min(100, Math.round(window.percent)))
    if (key in warned && (resetPassed(warned[key], now) || percent < threshold - REARM_MARGIN)) delete warned[key]
    if (percent >= threshold && !(key in warned)) {
      warned[key] = window.resetsAt
      reached.push({ window, percent })
    }
  }
  // Windows the data no longer has (e.g. a model's limit) are forgotten once they would have reset.
  for (const key of Object.keys(warned)) {
    if (key.startsWith(prefix) && !seen.has(key) && (warned[key] === null || resetPassed(warned[key], now))) delete warned[key]
  }
  return reached.sort((a, b) => b.percent - a.percent)
}

function resetPassed(resetsAt: string | null, now: number): boolean {
  if (!resetsAt) return false
  const time = Date.parse(resetsAt)
  return Number.isFinite(time) && time <= now
}
