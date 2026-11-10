import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import type { Account, AccountKind, AccountUsage, AppSettings, SessionLimit, TerminalInfo } from '@shared/types'
import { AutoSwitch } from './auto-switch'

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
let continueTerminal: Mock<(id: string, targetId: string) => Promise<TerminalInfo | null>>
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
  // Like SessionHandoff: tells about the new tab while the old one is still there.
  continueTerminal = vi.fn(async (id: string, targetId: string): Promise<TerminalInfo | null> => {
    const info = tab(`${id}→${targetId}`, targetId)
    emitReplaced(id, info)
    return info
  })
  service = new AutoSwitch(
    { list: () => accounts },
    {
      list: () => tabs,
      on: ((event: string, listener: (list: TerminalInfo[]) => void) => {
        if (event === 'changed') emitTerminals = listener
        return () => undefined
      }) as never,
    },
    { getAll: () => usage },
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
  )
  service.on('switched', (from, to, target) => switched.push([from.id, to.id, target.id]))
  service.on('failed', (from, target, message) => failed.push([from.id, target.id, message]))
  service.init()
})

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
    expect(continueTerminal).toHaveBeenCalledWith('t1', 'b')
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
    await vi.waitFor(() => expect(continueTerminal).toHaveBeenCalledWith('t1', 'b'))
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
    expect(continueTerminal).toHaveBeenLastCalledWith('t1', 'b')
    // The tab at a's limit is gone; the new one hits b's limit.
    await change([tab('t2', 'b', { accountId: 'a', limit: limit() })])
    expect(continueTerminal).toHaveBeenLastCalledWith('t2', 'c')
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
    expect(continueTerminal).toHaveBeenLastCalledWith('t2', 'c')
  })

  it('also avoids an account whose reset Claude Code did not name', async () => {
    accounts = ['a', 'b'].map(account)
    await change([tab('t1', 'a', { limit: limit(null) })])
    await change([tab('t2', 'b', { accountId: 'a', limit: limit() })])
    expect(continueTerminal).toHaveBeenCalledTimes(1)
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
