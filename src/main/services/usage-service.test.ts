import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AccountUsage, UsageStatus } from '@shared/types'

vi.mock('electron', () => ({ app: { getPath: () => '', getVersion: () => '0.0.0' }, net: {} }))

import { dueNow, nextReset, UsageService, type LiveRecord } from './usage-service'

const MINUTE = 60_000
const T = Date.parse('2026-11-11T12:00:00Z')

function record(status: UsageStatus, fetchedAt: number, nextAllowedAt: number, tokenKey = 'tok'): LiveRecord {
  return { usage: { status, fetchedAt: new Date(fetchedAt).toISOString() } as AccountUsage, nextAllowedAt, loginKey: null, tokenKey }
}

describe('dueNow', () => {
  it('asks in every regular round, also when the round comes a moment early', () => {
    const last = record('ok', T, T + 5 * MINUTE)
    // The round before asked this account 300 ms later than this round does.
    expect(dueNow(last, 'tok', false, T + 5 * MINUTE - 300)).toBe(true)
    expect(dueNow(last, 'tok', false, T + 2 * MINUTE)).toBe(false)
  })

  it('waits for the usage API after its rate limit, to the moment it named', () => {
    const limited = record('rate-limited', T, T + 10 * MINUTE)
    expect(dueNow(limited, 'tok', false, T + 10 * MINUTE - 300)).toBe(false)
    expect(dueNow(limited, 'tok', true, T + 9 * MINUTE)).toBe(false)
    expect(dueNow(limited, 'tok', false, T + 10 * MINUTE)).toBe(true)
  })

  it('asks by hand at most once a minute, and at once for a new token', () => {
    const last = record('ok', T, T + 5 * MINUTE)
    expect(dueNow(last, 'tok', true, T + 30_000)).toBe(false)
    expect(dueNow(last, 'tok', true, T + MINUTE)).toBe(true)
    expect(dueNow(record('expired', T, T + 5 * MINUTE), 'new-token', false, T + 1000)).toBe(true)
    expect(dueNow(undefined, 'tok', false, T)).toBe(true)
  })
})

describe('nextReset', () => {
  const at = (minutes: number) => new Date(T + minutes * MINUTE).toISOString()
  const usage = (fiveHour: number | null, sevenDay: number | null, ...scoped: number[]) =>
    ({
      fiveHour: fiveHour === null ? null : { resetsAt: at(fiveHour) },
      sevenDay: sevenDay === null ? null : { resetsAt: at(sevenDay) },
      scoped: scoped.map((m) => ({ resetsAt: at(m) })),
    }) as unknown as AccountUsage

  it('finds the next window to reset, of all accounts, past ones left out', () => {
    expect(nextReset([usage(90, 5000), usage(-5, 3000, 40)], T)).toBe(T + 40 * MINUTE)
    expect(nextReset([usage(-1, null)], T)).toBeNull()
    expect(nextReset([], T)).toBeNull()
  })
})

describe('UsageService and removed accounts', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'cm-usage-'))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true, maxRetries: 3 })
  })

  it('forgets the usage of removed accounts, also in the cache file', async () => {
    const file = join(dir, 'cache', 'usage.json')
    await mkdir(join(dir, 'cache'))
    const usage = (accountId: string) => ({ accountId, status: 'ok', fetchedAt: new Date(T).toISOString() })
    await writeFile(
      file,
      JSON.stringify({
        version: 2,
        records: { a: { usage: usage('a'), loginKey: null }, gone: { usage: usage('gone'), loginKey: null } },
        samples: { 'a\nfive_hour': [], 'gone\nfive_hour': [] },
      }),
    )
    let list = [{ id: 'a' }, { id: 'b' }]
    let onAccounts: () => void = () => undefined
    const accounts = {
      list: () => list,
      on: (_event: string, listener: () => void) => (onAccounts = listener),
      credentials: () => ({ kind: 'apiKey' }),
      resolveLogin: async () => undefined,
    }
    const settings = { get: () => ({ claude: { usageRefreshMinutes: 5 } }), on: () => undefined }
    const service = new UsageService(accounts as never, settings as never, {} as never, dir, 'test')
    await service.init()
    try {
      await vi.waitFor(async () => {
        const saved = JSON.parse(await readFile(file, 'utf8'))
        expect(Object.keys(saved.records)).toEqual(['a'])
        expect(Object.keys(saved.samples)).toEqual(['a\nfive_hour'])
      })
      list = [{ id: 'b' }]
      onAccounts()
      await vi.waitFor(async () => expect(JSON.parse(await readFile(file, 'utf8')).records).toEqual({}))
    } finally {
      service.dispose()
    }
  })
})
