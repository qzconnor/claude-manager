import { describe, expect, it } from 'vitest'
import { dropOldUsage, firstStatsDay } from './index-cache'
import type { UsageEntry } from './transcript-parser'

const usage = (day: string): UsageEntry => [`msg-${day}`, day, 'claude-opus', 1, 2, 3, 4, 0, 0]

describe('firstStatsDay', () => {
  it('counts today as the first of the days', () => {
    const now = new Date(2026, 10, 11, 23, 59)
    expect(firstStatsDay(now, 1)).toBe('2026-11-11')
    expect(firstStatsDay(now, 30)).toBe('2026-10-13')
    expect(firstStatsDay(now, 365)).toBe('2025-11-12')
  })
})

describe('dropOldUsage', () => {
  it('drops only the days before the first, and says whether it dropped anything', () => {
    const old = { usage: [usage('2024-03-01'), usage('2025-11-11'), usage('2025-11-12'), usage('2026-11-11')] }
    const recent = { usage: [usage('2026-01-01')] }
    const before = recent.usage
    expect(dropOldUsage([old, recent], '2025-11-12')).toBe(true)
    expect(old.usage.map((u) => u[1])).toEqual(['2025-11-12', '2026-11-11'])
    // Untouched where there was nothing to drop.
    expect(recent.usage).toBe(before)
    expect(dropOldUsage([old, recent], '2025-11-12')).toBe(false)
  })
})
