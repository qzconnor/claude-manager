import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AccountTokenStats } from '@shared/types'
import { statsKey, useUsageStore } from './usage'

/** Answers to `usage.stats` that the test gives when it wants, in the order it wants. */
let answers: { days: number; resolve: (stats: AccountTokenStats) => void; reject: (error: Error) => void }[]

const api = {
  usage: {
    stats: vi.fn(
      (_accountId: string, days: number) =>
        new Promise<AccountTokenStats>((resolve, reject) => {
          answers.push({ days, resolve, reject })
        }),
    ),
    refresh: vi.fn(
      () =>
        new Promise<never[]>((resolve) => {
          refreshes.push(() => resolve([]))
        }),
    ),
    onChanged: () => () => {},
  },
}

/** Answers to `usage.refresh`, given when the test wants. */
let refreshes: (() => void)[]

const statsOf = (days: number, messages: number) =>
  ({ days: Array.from({ length: days }, () => ({})), totals: { messages } }) as unknown as AccountTokenStats

beforeEach(() => {
  answers = []
  refreshes = []
  vi.stubGlobal('window', { api })
  setActivePinia(createPinia())
})

describe('usage store: token statistics', () => {
  it('keeps each period apart: the 90 days coming in after the 7 don’t take their place', async () => {
    const usage = useUsageStore()
    const ninety = usage.loadStats('a', 90)
    const seven = usage.loadStats('a', 7)
    const [first, second] = answers.splice(0)
    second?.resolve(statsOf(7, 7))
    await seven
    first?.resolve(statsOf(90, 90))
    await ninety

    expect(usage.stats[statsKey('a', 7)]?.totals.messages).toBe(7)
    expect(usage.stats[statsKey('a', 90)]?.totals.messages).toBe(90)
    expect(usage.statsLoading[statsKey('a', 7)]).toBe(false)
  })

  it('keeps the newer answer of the same period', async () => {
    const usage = useUsageStore()
    const older = usage.loadStats('a', 30)
    const newer = usage.loadStats('a', 30)
    const [first, second] = answers.splice(0)
    second?.resolve(statsOf(30, 2))
    await newer
    first?.resolve(statsOf(30, 1))
    await older

    expect(usage.stats[statsKey('a', 30)]?.totals.messages).toBe(2)
  })

  it('says why it failed, until it works again', async () => {
    const usage = useUsageStore()
    const failing = usage.loadStats('a', 30)
    answers.shift()?.reject(new Error("Error invoking remote method 'usage:stats': Error: EACCES"))
    await failing

    expect(usage.statsErrors[statsKey('a', 30)]).toBe('EACCES')
    expect(usage.statsLoading[statsKey('a', 30)]).toBe(false)

    const again = usage.loadStats('a', 30)
    answers.shift()?.resolve(statsOf(30, 1))
    await again
    expect(usage.statsErrors[statsKey('a', 30)]).toBeUndefined()
  })
})

describe('usage store: refreshing', () => {
  it('turns only the asked account’s button, and all of them for „Alle aktualisieren“', async () => {
    const usage = useUsageStore()
    const one = usage.refresh('a')
    expect([usage.isRefreshing('a'), usage.isRefreshing('b')]).toEqual([true, false])
    refreshes.shift()?.()
    await one
    expect(usage.isRefreshing('a')).toBe(false)

    const all = usage.refresh()
    expect([usage.isRefreshing('a'), usage.isRefreshing('b')]).toEqual([true, true])
    refreshes.shift()?.()
    await all
    expect(usage.isRefreshing('b')).toBe(false)
  })
})
