import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import type { Account, AccountKind, AccountUsage, AppSettings, LimitResume, SessionLimit, TerminalInfo } from '@shared/types'
import { AutoSwitch, RESET_GRACE_MS } from './auto-switch'

const LATER = new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString()

const KINDS: Record<string, AccountKind> = { a: 'oauth', b: 'token', c: 'oauth' }
const account = (id: string) =>
  ({ id, name: `Name ${id}`, kind: KINDS[id], authState: 'ok', identity: { email: null, organizationUuid: null } }) as unknown as Account

function tab(id: string, authAccountId: string, extra: Partial<TerminalInfo> = {}): TerminalInfo {
  return {
    id,
    accountId: authAccountId,
    authAccountId,
    sessionId: `session-${id}`,
    mode: 'session',
    status: 'running',
    limit: null,
    resume: null,
    context: null,
    title: id,
    muted: false,
    ...extra,
  } as TerminalInfo
}

const limit = (resetsAt: string | null = LATER): SessionLimit => ({ type: 'five_hour', resetsAt, message: 'limit' })

let tabs: TerminalInfo[]
let autoSwitchOn: boolean
let usage: AccountUsage[]
let accounts: Account[]
let emitTerminals: (list: TerminalInfo[]) => void
let emitSettings: (next: AppSettings, previous: AppSettings) => void
let emitReplaced: (oldId: string, info: TerminalInfo) => void
let emitUsage: () => void
let emitAccounts: () => void
let continueTerminal: Mock<(id: string, targetId: string, limited?: boolean) => Promise<TerminalInfo | null>>
/** What the service told each tab about how it goes on (`TerminalInfo.resume`). */
let resumes: Map<string, LimitResume | null>
let service: AutoSwitch
let switched: [string, string, string][]
let failed: [string, string, string][]

const settingsWith = (on: boolean) => ({ claude: { autoSwitch: on } }) as AppSettings

beforeEach(() => {
  tabs = []
  autoSwitchOn = true
  usage = []
  accounts = ['a', 'b', 'c'].map(account)
  switched = []
  failed = []
  resumes = new Map()
  // Like SessionHandoff: tells about the new tab while the old one is still there.
  continueTerminal = vi.fn(async (id: string, targetId: string): Promise<TerminalInfo | null> => {
    const info = tab(`${id}→${targetId}`, targetId)
    emitReplaced(id, info)
    return info
  })
  service = start()
})

/** A new service, as on a start of the app; `file` keeps the accounts left at a limit. */
function start(file: string | null = null): AutoSwitch {
  const created = new AutoSwitch(
    {
      list: () => accounts,
      on: ((event: string, listener: () => void) => {
        if (event === 'changed') emitAccounts = listener
        return () => undefined
      }) as never,
    },
    {
      list: () => tabs,
      setResume: (id: string, resume: LimitResume | null) => void resumes.set(id, resume),
      on: ((event: string, listener: (list: TerminalInfo[]) => void) => {
        if (event === 'changed') emitTerminals = listener
        return () => undefined
      }) as never,
    },
    {
      getAll: () => usage,
      on: ((event: string, listener: () => void) => {
        if (event === 'changed') emitUsage = listener
        return () => undefined
      }) as never,
    },
    {
      get: () => settingsWith(autoSwitchOn),
      on: ((event: string, listener: typeof emitSettings) => {
        if (event === 'changed') emitSettings = listener
        return () => undefined
      }) as never,
    },
    {
      continueTerminal,
      on: ((event: string, listener: typeof emitReplaced) => {
        if (event === 'replaced') emitReplaced = listener
        return () => undefined
      }) as never,
    },
    file,
  )
  created.on('switched', (from, to, target) => switched.push([from.id, to.id, target.id]))
  created.on('failed', (from, target, message) => failed.push([from.id, target.id, message]))
  created.init()
  return created
}

/** The tabs change, and the switches that started finish. */
async function change(list: TerminalInfo[]) {
  tabs = list
  emitTerminals(list)
  await new Promise((resolve) => setTimeout(resolve, 0))
}

describe('AutoSwitch', () => {
  it('continues a session at a limit with the suggested account', async () => {
    await change([tab('t1', 'a', { limit: limit() })])
    // The token lends its key: it comes before the other browser login.
    expect(continueTerminal).toHaveBeenCalledWith('t1', 'b', true)
    expect(switched).toEqual([['t1', 't1→b', 'b']])
  })

  it('tells about the limit of a tab it switches, right away and also when that failed', async () => {
    let fail!: (error: Error) => void
    continueTerminal.mockImplementation(() => new Promise((_resolve, reject) => (fail = reject)))
    tabs = [tab('t1', 'a', { limit: limit() })]
    emitTerminals(tabs)
    expect(service.tellsLimit('t1')).toBe(true)
    fail(new Error('nope'))
    await vi.waitFor(() => expect(failed).toHaveLength(1))
    expect(service.tellsLimit('t1')).toBe(true)
    // Gone: forgotten.
    await change([])
    expect(service.tellsLimit('t1')).toBe(false)
  })

  it('leaves the limit notice to the tab when no account is free', async () => {
    accounts = [account('a')]
    await change([tab('t1', 'a', { limit: limit() })])
    expect(service.tellsLimit('t1')).toBe(false)
  })

  it('does nothing while the setting is off', async () => {
    autoSwitchOn = false
    await change([tab('t1', 'a', { limit: limit() })])
    expect(continueTerminal).not.toHaveBeenCalled()
  })

  it('switches the tabs at a limit once the setting is switched on', async () => {
    autoSwitchOn = false
    await change([tab('t1', 'a', { limit: limit() })])
    autoSwitchOn = true
    emitSettings(settingsWith(true), settingsWith(false))
    await vi.waitFor(() => expect(continueTerminal).toHaveBeenCalledWith('t1', 'b', true))
  })

  it('deals with each limit of a tab once', async () => {
    continueTerminal.mockResolvedValue(null)
    const atLimit = tab('t1', 'a', { limit: limit() })
    await change([atLimit])
    await change([{ ...atLimit, title: 'renamed' }])
    expect(continueTerminal).toHaveBeenCalledTimes(1)
    await change([{ ...atLimit, limit: { ...limit(), message: 'another limit' } }])
    expect(continueTerminal).toHaveBeenCalledTimes(2)
  })

  it('leaves tabs alone that are not running sessions with a known session', async () => {
    await change([
      tab('shell', 'a', { mode: 'shell', limit: limit() }),
      tab('exited', 'a', { status: 'exited', limit: limit() }),
      tab('unknown', 'a', { sessionId: null, limit: limit() }),
      tab('fine', 'a'),
    ])
    expect(continueTerminal).not.toHaveBeenCalled()
  })

  it('keeps the tab when no account is free', async () => {
    usage = [
      { accountId: 'b', status: 'ok', fiveHour: { percent: 100 }, sevenDay: null },
      { accountId: 'c', status: 'ok', fiveHour: { percent: 100 }, sevenDay: null },
    ] as AccountUsage[]
    await change([tab('t1', 'a', { limit: limit() })])
    expect(continueTerminal).not.toHaveBeenCalled()
  })

  it('does not go back to an account it switched away from before its reset', async () => {
    await change([tab('t1', 'a', { limit: limit() })])
    expect(continueTerminal).toHaveBeenLastCalledWith('t1', 'b', true)
    // The tab at a's limit is gone; the new one hits b's limit.
    await change([tab('t2', 'b', { accountId: 'a', limit: limit() })])
    expect(continueTerminal).toHaveBeenLastCalledWith('t2', 'c', true)
    await change([tab('t3', 'c', { limit: limit() })])
    expect(continueTerminal).toHaveBeenCalledTimes(2)
  })

  it('avoids an account that was left at its limit by hand', async () => {
    autoSwitchOn = false
    const atLimit = tab('t1', 'a', { limit: limit() })
    tabs = [atLimit]
    // The user switches in the tab; the old one closes afterwards.
    emitReplaced('t1', tab('t2', 'b', { accountId: 'a' }))
    autoSwitchOn = true
    await change([tab('t2', 'b', { accountId: 'a', limit: limit() })])
    expect(continueTerminal).toHaveBeenLastCalledWith('t2', 'c', true)
  })

  it('also avoids an account whose reset Claude Code did not name', async () => {
    accounts = ['a', 'b'].map(account)
    await change([tab('t1', 'a', { limit: limit(null) })])
    await change([tab('t2', 'b', { accountId: 'a', limit: limit() })])
    expect(continueTerminal).toHaveBeenCalledTimes(1)
  })

  it('switches a waiting tab once an account is logged in again', async () => {
    accounts = [account('a'), { ...account('b'), authState: 'missing' } as Account]
    await change([tab('t1', 'a', { limit: limit() })])
    expect(continueTerminal).not.toHaveBeenCalled()
    accounts = ['a', 'b'].map(account)
    emitAccounts()
    await vi.waitFor(() => expect(continueTerminal).toHaveBeenCalledWith('t1', 'b', true))
    expect(service.tellsLimit('t1')).toBe(true)
  })

  it('switches a waiting tab once the usage shows an account free', async () => {
    usage = [
      { accountId: 'b', status: 'ok', fiveHour: { percent: 100 }, sevenDay: null },
      { accountId: 'c', status: 'ok', fiveHour: { percent: 100 }, sevenDay: null },
    ] as AccountUsage[]
    await change([tab('t1', 'a', { limit: limit() })])
    expect(continueTerminal).not.toHaveBeenCalled()
    usage = [{ accountId: 'c', status: 'ok', fiveHour: { percent: 40 }, sevenDay: null }] as AccountUsage[]
    emitUsage()
    await vi.waitFor(() => expect(continueTerminal).toHaveBeenCalledWith('t1', 'b', true))
  })

  describe('after a restart', () => {
    let dir: string

    beforeEach(async () => {
      dir = await mkdtemp(join(tmpdir(), 'cm-switch-'))
    })

    afterEach(async () => {
      await rm(dir, { recursive: true, force: true, maxRetries: 3 })
    })

    it('still avoids an account it left at its limit', async () => {
      const file = join(dir, 'limited-accounts.json')
      service = start(file)
      await change([tab('t1', 'a', { limit: limit() })])
      expect(continueTerminal).toHaveBeenLastCalledWith('t1', 'b', true)
      await vi.waitFor(async () => expect(JSON.parse(await readFile(file, 'utf8'))).toEqual([{ accountId: 'a', resetsAt: LATER }]))
      // The app starts again, the tab goes on with b and hits its limit.
      service = start(file)
      await change([tab('t2', 'b', { accountId: 'a', limit: limit() })])
      expect(continueTerminal).toHaveBeenLastCalledWith('t2', 'c', true)
    })

    it('forgets limits that have reset and accounts that are gone', async () => {
      const file = join(dir, 'limited-accounts.json')
      const past = new Date(Date.now() - 60_000).toISOString()
      await writeFile(
        file,
        JSON.stringify([
          { accountId: 'a', resetsAt: past },
          { accountId: 'gone', resetsAt: LATER },
          { accountId: 'b', resetsAt: LATER },
          { accountId: 'c' },
          'broken',
        ]),
      )
      service = start(file)
      await vi.waitFor(async () => expect(JSON.parse(await readFile(file, 'utf8'))).toEqual([{ accountId: 'b', resetsAt: LATER }]))
      accounts = ['a', 'c'].map(account)
      emitAccounts()
      await vi.waitFor(async () => expect(JSON.parse(await readFile(file, 'utf8'))).toEqual([]))
    })
  })

  it('reports a switch that failed or was not allowed', async () => {
    continueTerminal.mockRejectedValueOnce(new Error('Kopie ist neuer')).mockResolvedValueOnce(null)
    await change([tab('t1', 'a', { limit: limit() }), tab('t2', 'c', { limit: limit() })])
    expect(failed).toEqual([
      ['t1', 'b', 'Kopie ist neuer'],
      ['t2', 'b', 'Der Ordner ist für „Name b“ nicht freigegeben.'],
    ])
    expect(switched).toEqual([])
  })
})

describe('AutoSwitch at a reset', () => {
  const start = new Date('2026-11-11T12:00:00.000Z').getTime()
  const inAnHour = new Date(start + 60 * 60 * 1000).toISOString()

  beforeEach(() => {
    vi.useFakeTimers({ now: start })
    accounts = [account('a')]
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  async function changeNow(list: TerminalInfo[]) {
    tabs = list
    emitTerminals(list)
    await vi.advanceTimersByTimeAsync(0)
  }

  it('goes on with the own account shortly after its limit has reset', async () => {
    await changeNow([tab('t1', 'a', { limit: limit(inAnHour) })])
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000)
    // Claude Code names the reset only roughly: a little later.
    expect(continueTerminal).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(RESET_GRACE_MS)
    expect(continueTerminal).toHaveBeenCalledWith('t1', 'a', true)
    expect(switched).toEqual([['t1', 't1→a', 'a']])
  })

  it('switches to another account that resets first', async () => {
    accounts = ['a', 'b'].map(account)
    usage = [{ accountId: 'b', status: 'ok', fiveHour: { percent: 100, resetsAt: new Date(start + 10 * 60 * 1000).toISOString() }, sevenDay: null }] as AccountUsage[]
    await changeNow([tab('t1', 'a', { limit: limit(inAnHour) })])
    expect(continueTerminal).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000 + RESET_GRACE_MS)
    expect(continueTerminal).toHaveBeenCalledWith('t1', 'b', true)
  })

  it('does not start the session again and again when the reset came too early', async () => {
    await changeNow([tab('t1', 'a', { limit: limit(inAnHour) })])
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000 + RESET_GRACE_MS)
    expect(continueTerminal).toHaveBeenCalledTimes(1)
    // The new tab stops at the same limit.
    await changeNow([tab('t1→a', 'a', { sessionId: 'session-t1', limit: limit(inAnHour) })])
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000)
    expect(continueTerminal).toHaveBeenCalledTimes(1)
  })

  it('does not start it again either when the tab no longer named the limit as it went on', async () => {
    await changeNow([tab('t1', 'a', { limit: limit(inAnHour) })])
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000)
    await changeNow([tab('t1', 'a')])
    await vi.advanceTimersByTimeAsync(RESET_GRACE_MS)
    expect(continueTerminal).toHaveBeenCalledTimes(1)
    await changeNow([tab('t1→a', 'a', { sessionId: 'session-t1', limit: limit(inAnHour) })])
    expect(resumes.get('t1→a')).toEqual({ byUser: false, at: null })
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000)
    expect(continueTerminal).toHaveBeenCalledTimes(1)
  })

  it('goes on after the reset also when the tab no longer names the limit, as the terminals tell it', async () => {
    await changeNow([tab('t1', 'a', { limit: limit(inAnHour) })])
    expect(resumes.get('t1')).toEqual({ byUser: false, at: new Date(start + 60 * 60 * 1000 + RESET_GRACE_MS).toISOString() })
    // At the reset Claude Code's limit is past: the tab names none any more.
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000)
    await changeNow([tab('t1', 'a')])
    expect(continueTerminal).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(RESET_GRACE_MS)
    expect(continueTerminal).toHaveBeenCalledWith('t1', 'a', true)
    expect(resumes.get('t1')).toBeNull()
  })

  it('stops waiting when the user went on by hand after the reset', async () => {
    await changeNow([tab('t1', 'a', { limit: limit(inAnHour) })])
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000)
    await changeNow([tab('t1', 'a', { busy: true, resume: resumes.get('t1') ?? null })])
    expect(resumes.get('t1')).toBeNull()
    await changeNow([tab('t1', 'a')])
    await vi.advanceTimersByTimeAsync(2 * RESET_GRACE_MS)
    expect(continueTerminal).not.toHaveBeenCalled()
  })

  it('forgets the limit when the tab shows another session', async () => {
    await changeNow([tab('t1', 'a', { limit: limit(inAnHour) })])
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000)
    await changeNow([tab('t1', 'a', { sessionId: 'after-clear', resume: resumes.get('t1') ?? null })])
    await vi.advanceTimersByTimeAsync(2 * RESET_GRACE_MS)
    expect(continueTerminal).not.toHaveBeenCalled()
    expect(resumes.get('t1')).toBeNull()
  })

  it('waits without a known reset and without a free account', async () => {
    await changeNow([tab('t1', 'a', { limit: limit(null) })])
    await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000)
    expect(continueTerminal).not.toHaveBeenCalled()
  })

  it('stops waiting when the setting is switched off', async () => {
    await changeNow([tab('t1', 'a', { limit: limit(inAnHour) })])
    autoSwitchOn = false
    emitSettings(settingsWith(false), settingsWith(true))
    expect(resumes.get('t1')).toBeNull()
    await vi.advanceTimersByTimeAsync(2 * 60 * 60 * 1000)
    expect(continueTerminal).not.toHaveBeenCalled()
  })
})

describe('Am Reset fortsetzen', () => {
  const start = new Date('2026-11-11T12:00:00.000Z').getTime()
  const inAnHour = new Date(start + 60 * 60 * 1000).toISOString()
  const resumeAt = new Date(start + 60 * 60 * 1000 + RESET_GRACE_MS).toISOString()

  beforeEach(() => {
    vi.useFakeTimers({ now: start })
    autoSwitchOn = false
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  async function changeNow(list: TerminalInfo[]) {
    tabs = list
    emitTerminals(list)
    await vi.advanceTimersByTimeAsync(0)
  }

  it('goes on with the own account after the reset when asked, without the automatic switch', async () => {
    await changeNow([tab('t1', 'a', { limit: limit(inAnHour) })])
    expect(resumes.has('t1')).toBe(false)
    service.resumeAtReset('t1', true)
    expect(resumes.get('t1')).toEqual({ byUser: true, at: resumeAt })
    // Not with another account, though "b" is free: asked for the reset.
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000)
    await changeNow([tab('t1', 'a')])
    expect(continueTerminal).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(RESET_GRACE_MS)
    expect(continueTerminal).toHaveBeenCalledWith('t1', 'a', true)
    expect(switched).toEqual([['t1', 't1→a', 'a']])
  })

  it('no longer goes on once taken back', async () => {
    await changeNow([tab('t1', 'a', { limit: limit(inAnHour) })])
    service.resumeAtReset('t1', true)
    service.resumeAtReset('t1', false)
    expect(resumes.get('t1')).toBeNull()
    await vi.advanceTimersByTimeAsync(2 * 60 * 60 * 1000)
    expect(continueTerminal).not.toHaveBeenCalled()
  })

  it('asks anew at the next limit once the user went on by hand', async () => {
    await changeNow([tab('t1', 'a', { limit: limit(inAnHour) })])
    service.resumeAtReset('t1', true)
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000)
    await changeNow([tab('t1', 'a', { busy: true, resume: resumes.get('t1') ?? null })])
    expect(resumes.get('t1')).toBeNull()
    const later = new Date(start + 5 * 60 * 60 * 1000).toISOString()
    await changeNow([tab('t1', 'a', { limit: limit(later) })])
    await vi.advanceTimersByTimeAsync(5 * 60 * 60 * 1000)
    expect(continueTerminal).not.toHaveBeenCalled()
  })

  it('tells with the automatic switch, too, that the user asked', async () => {
    autoSwitchOn = true
    accounts = [account('a')]
    await changeNow([tab('t1', 'a', { limit: limit(inAnHour) })])
    expect(resumes.get('t1')).toEqual({ byUser: false, at: resumeAt })
    service.resumeAtReset('t1', true)
    expect(resumes.get('t1')).toEqual({ byUser: true, at: resumeAt })
  })

  it('has no time to name without a known reset', async () => {
    await changeNow([tab('t1', 'a', { limit: limit(null) })])
    service.resumeAtReset('t1', true)
    expect(resumes.get('t1')).toEqual({ byUser: true, at: null })
  })

  it('only for a session at a limit', async () => {
    await changeNow([
      tab('t1', 'a'),
      tab('t2', 'a', { limit: limit(inAnHour), sessionId: null }),
      tab('s', 'a', { mode: 'shell', limit: limit() }),
    ])
    expect(() => service.resumeAtReset('t1', true)).toThrow('Die Session steht an keinem Limit.')
    expect(() => service.resumeAtReset('t2', true)).toThrow('Welche Session in diesem Tab läuft, ist noch nicht bekannt.')
    expect(() => service.resumeAtReset('s', true)).toThrow('Die Session steht an keinem Limit.')
    expect(() => service.resumeAtReset('weg', true)).toThrow('Tab nicht gefunden.')
  })

  it('forgets a tab that is gone', async () => {
    await changeNow([tab('t1', 'a', { limit: limit(inAnHour) })])
    service.resumeAtReset('t1', true)
    await changeNow([])
    resumes.clear()
    // Should the id come again, it doesn't wait.
    await changeNow([tab('t1', 'a', { limit: limit(inAnHour) })])
    expect(resumes.has('t1')).toBe(false)
    await vi.advanceTimersByTimeAsync(2 * 60 * 60 * 1000)
    expect(continueTerminal).not.toHaveBeenCalled()
  })
})
