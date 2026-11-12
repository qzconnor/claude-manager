import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AccountUsage, UsageStatus } from '@shared/types'

const fetchMock = vi.hoisted(() => vi.fn<(url: string, init?: RequestInit) => Promise<Response>>())
vi.mock('electron', () => ({ app: { getPath: () => '', getVersion: () => '0.0.0' }, net: { fetch: fetchMock } }))

import { writeJsonAtomic } from '../lib/json-file'
import type { AccountCredentials } from './account-service'
import { dueNow, nextReset, UsageService, type LiveRecord } from './usage-service'
import type { TokenStatsResult } from '../workers/indexer-protocol'

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const T = Date.parse('2026-11-11T12:00:00Z')

function record(status: UsageStatus, fetchedAt: number, nextAllowedAt: number, tokenKey = 'tok'): LiveRecord {
  return { usage: { status, fetchedAt: new Date(fetchedAt).toISOString() } as AccountUsage, nextAllowedAt, askedAt: fetchedAt, loginKey: null, tokenKey }
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
        history: {
          'a\nfive_hour': [[T - HOUR, 20, T + HOUR], [T - 30 * MINUTE, 'x', T + HOUR], [T, 25, T + HOUR]],
          'gone\nseven_day': [[T, 1, T + 24 * HOUR]],
        },
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
        expect(Object.keys(saved.history)).toEqual(['a\nfive_hour'])
      })
      expect(service.history('a')).toEqual({
        accountId: 'a',
        fiveHour: [
          [T - HOUR, 20, T + HOUR],
          [T, 25, T + HOUR],
        ],
        sevenDay: [],
      })
      expect(service.history('gone')).toEqual({ accountId: 'gone', fiveHour: [], sevenDay: [] })
      list = [{ id: 'b' }]
      onAccounts()
      await vi.waitFor(async () => expect(JSON.parse(await readFile(file, 'utf8')).records).toEqual({}))
    } finally {
      service.dispose()
    }
  })
})

// --- the service against a fake usage API -------------------------------------

/** Timers of the test's own, untouched by the fake clock: for file writes and parsing answers. */
const realSetTimeout = globalThis.setTimeout

/** Lets the service's promise chains, the parsing of answers and file writes run, without moving the fake clock. */
function settle(ms = 25): Promise<void> {
  return new Promise((resolve) => realSetTimeout(resolve, ms))
}

/** Moves the fake clock and runs the timers due by then, then lets what they started finish. */
async function advance(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms)
  await settle()
}

/** Retries `check` in real time until it passes (for files written in the background). */
async function eventually(check: () => unknown): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await check()
      return
    } catch (error) {
      if (attempt >= 100) throw error
    }
    await settle(10)
  }
}

function usagePayload(fiveHour: number, sevenDay = 40) {
  return {
    five_hour: { utilization: fiveHour, resets_at: new Date(T + 3 * HOUR).toISOString() },
    seven_day: { utilization: sevenDay, resets_at: new Date(T + 5 * 24 * HOUR).toISOString() },
  }
}

function answer(status: number, body: unknown = {}, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers })
}

function deferred<V>() {
  let resolve!: (value: V) => void
  const promise = new Promise<V>((done) => (resolve = done))
  return { promise, resolve }
}

/** The token each request to the usage API was sent with, in order. */
function askedWith(): string[] {
  return fetchMock.mock.calls.map(([, init]) => (init?.headers as Record<string, string>).Authorization.replace('Bearer ', ''))
}

interface Login {
  /** `token`: a long-lived token of `claude setup-token`; `oauth`: a browser login. */
  kind: 'oauth' | 'token'
  token: string
  loginKey: string | null
}

let workDir: string
let running: UsageService | null = null

/**
 * A usage service over fake accounts (`logins`, by account id) and settings. Changing a login and
 * then calling `accountsChanged` is what the account service does when another login takes over.
 */
function setup(logins: Record<string, Login>, minutes = 5) {
  let refreshMinutes = minutes
  const accountListeners: (() => void)[] = []
  const settingsListeners: ((next: unknown, previous: unknown) => void)[] = []
  const hooks = { onResolveLogin: (_id: string): void => undefined }
  const credentials = (id: string): AccountCredentials => {
    const login = logins[id]
    if (!login) throw new Error(`unknown account ${id}`)
    const configDir = join(workDir, id)
    return {
      kind: login.kind,
      accessToken: login.kind === 'oauth' ? login.token : null,
      accessTokenExpiresAt: null,
      secret: login.kind === 'token' ? login.token : null,
      paths: {
        configDir,
        credentialsFile: join(configDir, '.credentials.json'),
        globalConfigFile: join(configDir, '.claude.json'),
        projectsDir: join(configDir, 'projects'),
        sessionsDir: join(configDir, 'sessions'),
      },
      accountUuid: null,
      loginKey: login.loginKey,
    }
  }
  const accounts = {
    list: () => Object.keys(logins).map((id) => ({ id })),
    on: (_event: string, listener: () => void) => {
      accountListeners.push(listener)
      return () => undefined
    },
    credentials,
    resolveLogin: async (id: string) => hooks.onResolveLogin(id),
    refresh: () => [],
  }
  const settings = {
    get: () => ({ claude: { usageRefreshMinutes: refreshMinutes } }),
    on: (_event: string, listener: (next: unknown, previous: unknown) => void) => {
      settingsListeners.push(listener)
      return () => undefined
    },
  }
  const service = new UsageService(accounts as never, settings as never, {} as never, workDir, 'test')
  running = service
  return {
    service,
    hooks,
    usage: (id: string) => service.getAll().find((u) => u.accountId === id)!,
    accountsChanged: () => accountListeners.forEach((listener) => listener()),
    setMinutes: (next: number) => {
      const previous = { claude: { usageRefreshMinutes: refreshMinutes } }
      refreshMinutes = next
      settingsListeners.forEach((listener) => listener({ claude: { usageRefreshMinutes: next } }, previous))
    },
  }
}

const cacheFile = () => join(workDir, 'cache', 'usage.json')

async function readCache(): Promise<{
  records: Record<string, { usage: AccountUsage; loginKey: string | null }>
  samples: Record<string, unknown>
  history: Record<string, unknown>
}> {
  return JSON.parse(await readFile(cacheFile(), 'utf8'))
}

describe('UsageService against the usage API', () => {
  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), 'cm-usage-'))
    fetchMock.mockReset()
    fetchMock.mockImplementation(async () => answer(200, usagePayload(12)))
    vi.useFakeTimers({ now: T, toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
  })

  afterEach(async () => {
    running?.dispose()
    running = null
    vi.useRealTimers()
    // Writes to one file are queued: this one ends after any the service started.
    await writeJsonAtomic(cacheFile(), {})
    await rm(workDir, { recursive: true, force: true, maxRetries: 3 })
  })

  describe('throttling', () => {
    it('asks each account once per round, one after another, and again only with the next round', async () => {
      const { service, accountsChanged } = setup({
        a: { kind: 'oauth', token: 'tok-a', loginKey: 'login-a' },
        b: { kind: 'oauth', token: 'tok-b', loginKey: 'login-b' },
      })
      const askedAt: number[] = []
      fetchMock.mockImplementation(async () => {
        askedAt.push(Date.now())
        return answer(200, usagePayload(12))
      })
      await service.init()
      await settle()
      // The accounts are asked with a short pause in between, not all at once.
      expect(askedWith()).toEqual(['tok-a'])
      await advance(1000)
      expect(askedWith()).toEqual(['tok-a', 'tok-b'])
      expect(askedAt[1] - askedAt[0]).toBeGreaterThanOrEqual(100)
      expect(askedAt[1] - askedAt[0]).toBeLessThan(1000)

      // Account changes, the local recomputes every 30 s and a refresh by hand right away ask nobody again.
      accountsChanged()
      accountsChanged()
      const manual = service.refresh()
      await advance(1000)
      await manual
      await advance(5 * MINUTE - 2000 - 1)
      expect(askedWith()).toEqual(['tok-a', 'tok-b'])

      // The next round, five minutes after the first.
      await advance(1)
      expect(askedWith()).toEqual(['tok-a', 'tok-b', 'tok-a'])
      await advance(1000)
      expect(askedWith()).toEqual(['tok-a', 'tok-b', 'tok-a', 'tok-b'])
    })

    it('asks by hand at most once a minute per account and shares a request that is under way', async () => {
      const { service } = setup({ a: { kind: 'oauth', token: 'tok-a', loginKey: 'login-a' } })
      await service.init()
      await settle()
      expect(fetchMock).toHaveBeenCalledOnce()

      await service.refresh('a')
      await advance(MINUTE - 1)
      await service.refresh('a')
      expect(fetchMock).toHaveBeenCalledOnce()
      await advance(1)
      const [usage] = await service.refresh('a')
      expect(fetchMock).toHaveBeenCalledTimes(2)
      expect(usage.nextRefreshAt).toBe(new Date(T + MINUTE + 5 * MINUTE).toISOString())

      await advance(MINUTE)
      const pending = deferred<Response>()
      fetchMock.mockReturnValueOnce(pending.promise)
      const refreshes = [service.refresh('a'), service.refresh('a'), service.refresh()]
      await settle()
      expect(fetchMock).toHaveBeenCalledTimes(3)
      pending.resolve(answer(200, usagePayload(30)))
      for (const result of await Promise.all(refreshes)) expect(result[0].fiveHour?.percent).toBe(30)
      expect(fetchMock).toHaveBeenCalledTimes(3)
    })

    it('asks by hand at most once a minute also after a failed request, which leaves the last data', async () => {
      const { service, usage } = setup({
        setup: { kind: 'token', token: 'tok-setup', loginKey: 'login-setup' },
        broken: { kind: 'oauth', token: 'tok-broken', loginKey: 'login-broken' },
      })
      fetchMock.mockImplementation(async (_url, init) =>
        (init?.headers as Record<string, string>).Authorization === 'Bearer tok-setup' ? answer(403) : answer(500),
      )
      await service.init()
      await advance(1000)
      expect(askedWith()).toEqual(['tok-setup', 'tok-broken'])
      expect(usage('broken').fetchedAt).toBeNull()

      // „Alle aktualisieren“ and the REST API, clicked again and again (the accounts one after another).
      const refreshAll = async () => {
        const done = service.refresh()
        await advance(500)
        await done
      }
      for (let i = 0; i < 5; i++) await refreshAll()
      await service.refresh('broken')
      await advance(MINUTE - 4000)
      await refreshAll()
      expect(askedWith()).toEqual(['tok-setup', 'tok-broken'])
      // More than a minute after the last request, by hand: both once more.
      await advance(1000)
      await refreshAll()
      expect(askedWith()).toEqual(['tok-setup', 'tok-broken', 'tok-setup', 'tok-broken'])
    })

    it('asks at the new interval once the setting changes', async () => {
      const { service, setMinutes } = setup({ a: { kind: 'oauth', token: 'tok-a', loginKey: 'login-a' } })
      await service.init()
      await settle()
      setMinutes(1)
      // The usage fetched before stays valid for the interval it was fetched with.
      await advance(4 * MINUTE)
      expect(fetchMock).toHaveBeenCalledOnce()
      await advance(MINUTE)
      expect(fetchMock).toHaveBeenCalledTimes(2)
      await advance(MINUTE)
      await advance(MINUTE)
      expect(fetchMock).toHaveBeenCalledTimes(4)
    })
  })

  describe('backoff', () => {
    it('waits as long as the rate limit names, also by hand and with a new token', async () => {
      const logins = { a: { kind: 'oauth' as const, token: 'tok-a', loginKey: 'login-a' } }
      const { service, usage, accountsChanged } = setup(logins)
      fetchMock.mockResolvedValueOnce(answer(429, {}, { 'Retry-After': '120' }))
      await service.init()
      await settle()
      expect(usage('a')).toMatchObject({ status: 'rate-limited', nextRefreshAt: new Date(T + 2 * MINUTE).toISOString() })

      await advance(MINUTE + 1000)
      await service.refresh('a')
      logins.a.token = 'tok-a2'
      accountsChanged()
      await settle()
      await service.refresh()
      expect(askedWith()).toEqual(['tok-a'])

      await advance(MINUTE - 1000)
      await service.refresh('a')
      expect(askedWith()).toEqual(['tok-a', 'tok-a2'])
      expect(usage('a')).toMatchObject({ status: 'ok', fiveHour: { percent: 12 } })
    })

    it('waits five minutes after a rate limit without Retry-After, even with a shorter interval', async () => {
      const { service, usage } = setup({ a: { kind: 'oauth', token: 'tok-a', loginKey: 'login-a' } }, 1)
      fetchMock.mockResolvedValueOnce(answer(429))
      await service.init()
      await settle()
      expect(usage('a').nextRefreshAt).toBe(new Date(T + 5 * MINUTE).toISOString())
      for (let round = 1; round <= 4; round++) await advance(MINUTE)
      expect(fetchMock).toHaveBeenCalledOnce()
      await advance(MINUTE)
      expect(fetchMock).toHaveBeenCalledTimes(2)
      expect(usage('a').status).toBe('ok')
    })

    it('keeps the last usage after a network error and tries again within two minutes', async () => {
      const { service, usage } = setup({ a: { kind: 'oauth', token: 'tok-a', loginKey: 'login-a' } })
      await service.init()
      await settle()
      fetchMock.mockRejectedValueOnce(new TypeError('fetch failed'))
      await advance(5 * MINUTE)
      expect(fetchMock).toHaveBeenCalledTimes(2)
      expect(usage('a')).toMatchObject({
        status: 'error',
        message: 'Usage konnte nicht geladen werden: fetch failed',
        fetchedAt: new Date(T).toISOString(),
        fiveHour: { percent: 12 },
        sevenDay: { percent: 40 },
        nextRefreshAt: new Date(T + 7 * MINUTE).toISOString(),
      })
      await advance(5 * MINUTE)
      expect(fetchMock).toHaveBeenCalledTimes(3)
      expect(usage('a').status).toBe('ok')
    })

    it('stops asking for a day with a token the usage API refuses for good, but asks again after other errors', async () => {
      const { service, usage } = setup({
        setup: { kind: 'token', token: 'tok-setup', loginKey: 'login-setup' },
        broken: { kind: 'oauth', token: 'tok-broken', loginKey: 'login-broken' },
      })
      fetchMock.mockImplementation(async (_url, init) =>
        (init?.headers as Record<string, string>).Authorization === 'Bearer tok-setup' ? answer(403) : answer(500),
      )
      await service.init()
      await advance(1000)
      expect(askedWith()).toEqual(['tok-setup', 'tok-broken'])
      expect(usage('setup')).toMatchObject({ status: 'unsupported', nextRefreshAt: new Date(T + 24 * HOUR).toISOString() })
      expect(usage('broken')).toMatchObject({ status: 'error', message: 'Usage-API antwortete mit HTTP 500.' })

      await advance(5 * MINUTE - 1000)
      await advance(1000)
      await advance(5 * MINUTE)
      expect(askedWith()).toEqual(['tok-setup', 'tok-broken', 'tok-broken', 'tok-broken'])
    })
  })

  describe('a login change', () => {
    it('keeps the usage when the same login gets a new token, and asks with it in the next round', async () => {
      const logins = { a: { kind: 'oauth' as const, token: 'tok-a', loginKey: 'login-a' } }
      const { service, usage, accountsChanged } = setup(logins)
      await service.init()
      await settle()
      logins.a.token = 'tok-a2'
      accountsChanged()
      await settle()
      expect(askedWith()).toEqual(['tok-a'])
      expect(usage('a')).toMatchObject({ status: 'ok', fiveHour: { percent: 12 } })

      await advance(5 * MINUTE)
      expect(askedWith()).toEqual(['tok-a', 'tok-a2'])
    })

    it('asks at once with a new token when the last answer was an error', async () => {
      const logins = { a: { kind: 'oauth' as const, token: 'tok-a', loginKey: 'login-a' } }
      const { service, usage, accountsChanged } = setup(logins)
      fetchMock.mockResolvedValueOnce(answer(401))
      await service.init()
      await settle()
      expect(usage('a').status).toBe('expired')

      // Nothing new: the same token isn't asked again before the next round.
      accountsChanged()
      await settle()
      expect(askedWith()).toEqual(['tok-a'])

      logins.a.token = 'tok-a2'
      accountsChanged()
      await settle()
      expect(askedWith()).toEqual(['tok-a', 'tok-a2'])
      expect(usage('a')).toMatchObject({ status: 'ok', fiveHour: { percent: 12 } })
    })

    it('drops the usage and readings of the previous login, also in the cache file, and asks for the new one at once', async () => {
      const logins = {
        a: { kind: 'oauth' as const, token: 'tok-a', loginKey: 'login-a' },
        b: { kind: 'oauth' as const, token: 'tok-b', loginKey: 'login-b' },
      }
      const { service, usage, accountsChanged } = setup(logins)
      await service.init()
      await advance(1000)
      expect(askedWith()).toEqual(['tok-a', 'tok-b'])
      await eventually(async () => {
        const saved = await readCache()
        expect(Object.keys(saved.records).sort()).toEqual(['a', 'b'])
        expect(saved.records.a.loginKey).toBe('login-a')
        expect(Object.keys(saved.samples).some((key) => key.startsWith('a\n'))).toBe(true)
        expect(Object.keys(saved.history).some((key) => key.startsWith('a\n'))).toBe(true)
      })
      expect(service.history('a').fiveHour).toHaveLength(1)

      // Another login takes over the files of account a (e.g. switched with cswap).
      const pending = deferred<Response>()
      fetchMock.mockReturnValueOnce(pending.promise)
      logins.a = { kind: 'oauth', token: 'tok-c', loginKey: 'login-c' }
      accountsChanged()
      await settle()
      expect(askedWith()).toEqual(['tok-a', 'tok-b', 'tok-c'])
      expect(usage('a')).toMatchObject({ fiveHour: null, sevenDay: null, fetchedAt: null })
      expect(usage('b')).toMatchObject({ status: 'ok', fiveHour: { percent: 12 } })
      await eventually(async () => {
        const saved = await readCache()
        expect(Object.keys(saved.records)).toEqual(['b'])
        expect(Object.keys(saved.samples).filter((key) => key.startsWith('a\n'))).toEqual([])
        expect(Object.keys(saved.samples).some((key) => key.startsWith('b\n'))).toBe(true)
        expect(Object.keys(saved.history).filter((key) => key.startsWith('a\n'))).toEqual([])
        expect(Object.keys(saved.history).some((key) => key.startsWith('b\n'))).toBe(true)
      })
      expect(service.history('a')).toEqual({ accountId: 'a', fiveHour: [], sevenDay: [] })

      pending.resolve(answer(200, usagePayload(55)))
      await settle()
      expect(usage('a')).toMatchObject({ status: 'ok', fiveHour: { percent: 55 } })
      await eventually(async () => expect((await readCache()).records.a.loginKey).toBe('login-c'))
      expect(askedWith()).toHaveLength(3)
    })

    it('asks by hand at once when the login turns out to be another one while asking', async () => {
      const logins = { a: { kind: 'oauth' as const, token: 'tok-a', loginKey: 'login-a' } }
      const { service, usage, hooks } = setup(logins)
      await service.init()
      await settle()
      await advance(10_000)
      // The account service learns only now that the token belongs to another login.
      logins.a.token = 'tok-c'
      hooks.onResolveLogin = () => {
        logins.a.loginKey = 'login-c'
      }
      fetchMock.mockResolvedValueOnce(answer(200, usagePayload(55)))
      await service.refresh('a')
      expect(askedWith()).toEqual(['tok-a', 'tok-c'])
      expect(usage('a')).toMatchObject({ status: 'ok', fiveHour: { percent: 55 } })
    })

    it('keeps the usage while the login is not known', async () => {
      const logins = { a: { kind: 'oauth' as const, token: 'tok-a', loginKey: 'login-a' as string | null } }
      const { service, usage, accountsChanged } = setup(logins)
      await service.init()
      await settle()
      logins.a.loginKey = null
      accountsChanged()
      await advance(MINUTE)
      expect(askedWith()).toEqual(['tok-a'])
      expect(usage('a')).toMatchObject({ status: 'ok', fiveHour: { percent: 12 } })
    })

    it('ignores what Claude Code cached for the previous login', async () => {
      const logins = { a: { kind: 'oauth' as const, token: 'tok-a', loginKey: 'login-a' } }
      const { service, usage, accountsChanged } = setup(logins)
      const writeClaudeCache = async (fetchedAtMs: number, percent: number) => {
        await mkdir(join(workDir, 'a'), { recursive: true })
        await writeFile(
          join(workDir, 'a', '.claude.json'),
          JSON.stringify({ cachedUsageUtilization: { fetchedAtMs, utilization: usagePayload(percent) } }),
        )
      }
      await service.init()
      await settle()
      // Claude Code fetched newer numbers than the app: they win.
      await writeClaudeCache(T + 10_000, 70)
      await advance(30_000)
      expect(usage('a')).toMatchObject({ source: 'claude-cache', fiveHour: { percent: 70 } })

      await advance(30_000)
      fetchMock.mockReturnValueOnce(deferred<Response>().promise)
      logins.a = { kind: 'oauth', token: 'tok-c', loginKey: 'login-c' }
      accountsChanged()
      await settle()
      expect(usage('a')).toMatchObject({ source: 'none', fiveHour: null })

      // What Claude Code fetches for the new login counts again.
      await writeClaudeCache(T + 90_000, 33)
      await advance(30_000)
      expect(usage('a')).toMatchObject({ source: 'claude-cache', fiveHour: { percent: 33 } })
    })
  })

  describe('the history of the limits', () => {
    /** The usage API names these values and resets from now on. */
    function answerWith(fiveHour: number, fiveHourReset: number, sevenDay: number, sevenDayReset: number) {
      fetchMock.mockImplementation(async () =>
        answer(200, {
          five_hour: { utilization: fiveHour, resets_at: new Date(fiveHourReset).toISOString() },
          seven_day: { utilization: sevenDay, resets_at: new Date(sevenDayReset).toISOString() },
        }),
      )
    }

    it('keeps a reading of each round, over the reset of the window, and after a restart', async () => {
      const reset = T + 20 * MINUTE
      const weekly = T + 3 * 24 * HOUR
      answerWith(10, reset, 40, weekly)
      const { service } = setup({ a: { kind: 'oauth', token: 'tok-a', loginKey: 'login-a' } })
      await service.init()
      await settle()
      answerWith(30, reset, 41, weekly)
      await advance(5 * MINUTE)
      // The window resets, and the next one begins with a message 25 minutes later.
      const next = T + 45 * MINUTE + 5 * HOUR
      answerWith(4, next, 42, weekly)
      await advance(45 * MINUTE)
      const roundAt = (n: number) => T + n * 5 * MINUTE
      const fiveHour = [[T, 10, reset], [roundAt(1), 30, reset], ...[2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => [roundAt(n), 4, next])]
      expect(service.history('a').fiveHour).toEqual(fiveHour)
      // The weekly window keeps half-hourly readings: those in between take turns after the first.
      expect(service.history('a').sevenDay).toEqual([
        [T, 40, weekly],
        [roundAt(5), 42, weekly],
        [roundAt(10), 42, weekly],
      ])

      // The readings of Claude Code's own cache count too.
      await mkdir(join(workDir, 'a'), { recursive: true })
      const fetchedAtMs = roundAt(10) + 2 * MINUTE
      const utilization = {
        five_hour: { utilization: 6, resets_at: new Date(next).toISOString() },
        seven_day: { utilization: 43, resets_at: new Date(weekly).toISOString() },
      }
      await writeFile(join(workDir, 'a', '.claude.json'), JSON.stringify({ cachedUsageUtilization: { fetchedAtMs, utilization } }))
      await advance(3 * MINUTE)
      expect(service.history('a').fiveHour.at(-1)).toEqual([fetchedAtMs, 6, next])

      // Saved with the next round, and read again after a restart.
      await advance(2 * MINUTE)
      const before = service.history('a')
      await eventually(async () => expect((await readCache()).history['a\nfive_hour']).toEqual(before.fiveHour))
      service.dispose()
      const again = setup({ a: { kind: 'oauth', token: 'tok-a', loginKey: 'login-a' } })
      fetchMock.mockImplementation(() => new Promise<Response>(() => undefined))
      await again.service.init()
      await settle()
      expect(again.service.history('a')).toEqual(before)
    })

    it('keeps no history of the weekly windows of single models', async () => {
      fetchMock.mockImplementation(async () =>
        answer(200, { ...usagePayload(12), seven_day_opus: { utilization: 5, resets_at: new Date(T + 24 * HOUR).toISOString() } }),
      )
      const { service, usage } = setup({ a: { kind: 'oauth', token: 'tok-a', loginKey: 'login-a' } })
      await service.init()
      await settle()
      expect(usage('a').scoped).toHaveLength(1)
      await eventually(async () => expect(Object.keys((await readCache()).history).sort()).toEqual(['a\nfive_hour', 'a\nseven_day']))
    })

    it('leaves out windows that reset meanwhile', async () => {
      answerWith(80, T + 2 * MINUTE, 40, T + 24 * HOUR)
      const { service } = setup({ a: { kind: 'oauth', token: 'tok-a', loginKey: 'login-a' } })
      await service.init()
      await settle()
      // The next round fails: the last answer is all there is, and its five-hour window is over.
      fetchMock.mockImplementation(async () => answer(500))
      await advance(5 * MINUTE)
      expect(service.history('a').fiveHour).toEqual([[T, 80, T + 2 * MINUTE]])
    })
  })
})

describe('UsageService.stats', () => {
  afterEach(() => vi.useRealTimers())

  it('names the tokens and costs of the index and fills in the days without usage', async () => {
    vi.useFakeTimers({ now: new Date(2026, 10, 12, 10), toFake: ['Date'] })
    const result: TokenStatsResult = {
      days: [['2026-11-11', [1, 2, 3, 4, 5, 0.5]]],
      models: [['claude-opus-4-6', [1, 2, 3, 4, 5, 0.5]]],
      folders: [['F:/a', 'F--a', [1, 2, 3, 4, 5, 0.5], 1]],
      sessions: [
        { projectKey: 'F--a', sessionId: 's1', path: 'F:/a', title: 'Titel', model: 'claude-opus-4-6', tokens: [1, 2, 3, 4, 5, 0.5] },
      ],
      sessionCount: 1,
      unpriced: 3,
    }
    const request = vi.fn(async () => result)
    const accounts = { paths: () => ({ projectsDir: 'P' }) }
    const service = new UsageService(accounts as never, {} as never, { request } as never, '', 'test')
    const counts = { input: 1, output: 2, cacheCreation: 3, cacheRead: 4, messages: 5, cost: 0.5 }
    const none = { input: 0, output: 0, cacheCreation: 0, cacheRead: 0, messages: 0, cost: 0 }

    const stats = await service.stats('a', 3)
    expect(request).toHaveBeenCalledWith({ method: 'tokenStats', projectsDir: 'P', days: 3 })
    expect(stats).toEqual({
      accountId: 'a',
      days: [
        { date: '2026-11-10', ...none },
        { date: '2026-11-11', ...counts },
        { date: '2026-11-12', ...none },
      ],
      models: [{ model: 'claude-opus-4-6', ...counts }],
      folders: [{ path: 'F:/a', projectKey: 'F--a', sessionCount: 1, ...counts }],
      sessions: [{ projectKey: 'F--a', sessionId: 's1', path: 'F:/a', title: 'Titel', model: 'claude-opus-4-6', ...counts }],
      totals: counts,
      sessionCount: 1,
      unpriced: 3,
      computedAt: new Date(2026, 10, 12, 10).toISOString(),
    })
  })
})
