import type { UsageEntry } from './transcript-parser'

const pad = (n: number) => String(n).padStart(2, '0')

/** The first of the last `days` days, today included, as `YYYY-MM-DD` in local time like the usage. */
export function firstStatsDay(now: Date, days: number): string {
  const since = new Date(now)
  since.setHours(0, 0, 0, 0)
  since.setDate(since.getDate() - (days - 1))
  return `${since.getFullYear()}-${pad(since.getMonth() + 1)}-${pad(since.getDate())}`
}

/**
 * Drops the usage of days before `firstDay`, which the statistics no longer reach. The index holds a
 * line for every answer in every transcript; with transcripts kept for years (`cleanupPeriodDays`)
 * it would grow without end.
 *
 * @returns Whether anything was dropped.
 */
export function dropOldUsage(entries: Iterable<{ usage: UsageEntry[] }>, firstDay: string): boolean {
  let dropped = false
  for (const entry of entries) {
    if (!entry.usage.some((usage) => usage[1] < firstDay)) continue
    entry.usage = entry.usage.filter((usage) => usage[1] >= firstDay)
    dropped = true
  }
  return dropped
}
