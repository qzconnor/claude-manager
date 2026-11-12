import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { BrowserWindow } from 'electron'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createDefaultSettings } from '@shared/defaults'
import type { Account, AccountKind, AccountUsage, NotificationSettings, TerminalInfo, UsageWindow } from '@shared/types'

const FakeNotification = vi.hoisted(() => {
  class FakeNotification {
    static supported = true
    static created: FakeNotification[] = []
    static isSupported(): boolean {
      return FakeNotification.supported
    }

    readonly handlers = new Map<string, () => void>()
    shown = false
    closed = false

    constructor(readonly options: { title: string; body: string; silent?: boolean; icon?: string }) {
      FakeNotification.created.push(this)
    }

    on(event: string, handler: () => void): this {
      this.handlers.set(event, handler)
      return this
    }

    show(): void {
      this.shown = true
    }

    close(): void {
      this.closed = true
    }
  }
  return FakeNotification
})

vi.mock('electron', () => ({ Notification: FakeNotification }))
vi.mock('../window/tray', () => ({ resourceIcon: (name: string) => `icon:${name}` }))

import { writeJsonAtomic } from '../lib/json-file'
import type { AccountService } from './account-service'
import { NotificationService } from './notification-service'
import type { SettingsService } from './settings-service'
import type { TerminalService, TurnEnd } from './terminal-service'
import type { UsageService } from './usage-service'

const NOW = Date.parse('2026-11-06T12:00:00Z')
/** 16:00 in Berlin on the same day. */
const RESET_TODAY = '2026-11-06T15:00:00+00:00'
/** Tuesday, 09:00 in Berlin. */
const RESET_TUESDAY = '2026-11-10T08:00:00+00:00'
/** "Di" or "Di.", depending on the ICU data of Node. */
const TUESDAY = new Date(RESET_TUESDAY).toLocaleDateString('de-DE', { weekday: 'short' })
const LATER = '2026-11-06T20:00:00+00:00'

type Listener = (...args: never[]) => void

class Emitter {
  private listeners = new Map<string, Set<Listener>>()

  on(event: string, listener: Listener): () => void {
    const set = this.listeners.get(event) ?? new Set()
    set.add(listener)
    this.listeners.set(event, set)
    return () => set.delete(listener)
  }

  fire(event: string, ...args: unknown[]): void {
    for (const listener of this.listeners.get(event) ?? []) (listener as (...a: unknown[]) => void)(...args)
  }
}

function account(id: string, name: string, kind: AccountKind = 'oauth', email: string | null = null, organizationUuid: string | null = null): Account {
  return {
    id,
    name,
    kind,
    color: '#d97757',
    configDir: `/config/${id}`,
    customConfigDir: false,
    defaultCwd: null,
    extraArgs: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    hasSecret: false,
    secretHint: null,
    authState: 'ok',
    identity: {
      email,
      displayName: null,
      organizationUuid,
      organizationName: null,
      organizationType: null,
      subscriptionType: null,
      rateLimitTier: null,
    },
    tokenExpiresAt: null,
    expectedLogin: null,
  }
}

function window(key: string, label: string, percent: number, resetsAt: string | null = RESET_TODAY): UsageWindow {
  return { key, label, percent, resetsAt, severity: null }
}

function usage(accountId: string, windows: { fiveHour?: UsageWindow; sevenDay?: UsageWindow; scoped?: UsageWindow[] }): AccountUsage {
  return {
    accountId,
    status: 'ok',
    source: 'live',
    fetchedAt: null,
    message: null,
    fiveHour: windows.fiveHour ?? null,
    sevenDay: windows.sevenDay ?? null,
    scoped: windows.scoped ?? [],
    extra: null,
    breakdown: [],
    nextRefreshAt: null,
  }
}

function terminal(overrides: Partial<TerminalInfo> = {}): TerminalInfo {
  return {
    id: 't1',
    accountId: 'a',
    authAccountId: 'a',
    sessionId: null,
    limit: null,
    context: null,
    busy: false,
    attention: null,
    muted: false,
    title: 'Tab',
    fixedTitle: false,
    autoTitle: 'Tab',
    cwd: '/work',
    mode: 'session',
    url: null,
    resumeSessionId: null,
    args: [],
    status: 'running',
    exitCode: null,
    pid: 1,
    createdAt: '2026-11-06T12:00:00.000Z',
    commandLine: 'claude',
    worktree: null,
    hooks: false,
    activity: null,
    subagents: 0,
    compacting: false,
    turn: null,
    prompt: null,
    ...overrides,
  }
}

function turn(overrides: Partial<TurnEnd> = {}): TurnEnd {
  return { kind: 'done', busyMs: 60_000, tool: null, detail: 'Fertig.', ...overrides }
}

// --- the services around it ----------------------------------------------------

let dir: string
let accountList: Account[]
let usageList: AccountUsage[]
let terminalList: TerminalInfo[]
let settingsValue: { notifications: NotificationSettings }
let terminalEvents: Emitter
let usageEvents: Emitter
let settingsEvents: Emitter
const setAttention = vi.fn<(id: string, kind: string | null) => void>()
const open = { terminal: vi.fn<(id: string) => void>(), usage: vi.fn<() => void>() }

interface FakeWindow {
  isDestroyed(): boolean
  isVisible(): boolean
  isMinimized(): boolean
  isFocused(): boolean
  flashFrame: ReturnType<typeof vi.fn>
}
let win: FakeWindow | null

const warnedFile = () => join(dir, 'cache', 'limit-warnings.json')

function create(): NotificationService {
  const terminals = {
    on: (event: string, listener: Listener) => terminalEvents.on(event, listener),
    list: () => terminalList,
    get: (id: string) => {
      const found = terminalList.find((t) => t.id === id)
      if (!found) throw new Error('gone')
      return found
    },
    setAttention,
  } as unknown as TerminalService
  const accounts = { list: () => accountList } as unknown as AccountService
  const usageService = {
    getAll: () => usageList,
    on: (event: string, listener: Listener) => usageEvents.on(event, listener),
  } as unknown as UsageService
  const settings = {
    get: () => structuredClone(settingsValue),
    on: (event: string, listener: Listener) => settingsEvents.on(event, listener),
  } as unknown as SettingsService
  return new NotificationService(terminals, accounts, usageService, settings, dir, () => win as unknown as BrowserWindow, open)
}

async function start(): Promise<NotificationService> {
  const service = create()
  await service.init()
  return service
}

/** Changes the notification settings and tells the service, like SettingsService does. */
function changeSettings(patch: Partial<NotificationSettings>): void {
  const previous = structuredClone(settingsValue)
  settingsValue.notifications = { ...settingsValue.notifications, ...patch }
  settingsEvents.fire('changed', structuredClone(settingsValue), previous)
}

const created = () => FakeNotification.created
const titles = () => created().map((n) => n.options.title)

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'cm-test-'))
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
  accountList = [account('a', 'Alpha')]
  usageList = []
  terminalList = [terminal()]
  settingsValue = { notifications: { ...createDefaultSettings().notifications } }
  terminalEvents = new Emitter()
  usageEvents = new Emitter()
  settingsEvents = new Emitter()
  FakeNotification.created = []
  FakeNotification.supported = true
  win = { isDestroyed: () => false, isVisible: () => true, isMinimized: () => false, isFocused: () => false, flashFrame: vi.fn() }
  vi.clearAllMocks()
})

afterEach(async () => {
  vi.useRealTimers()
  // Writes to one file are queued: this one ends after any the service started.
  await writeJsonAtomic(warnedFile(), null)
  await rm(dir, { recursive: true, force: true, maxRetries: 3 })
})

// --- limit warnings ------------------------------------------------------------

describe('limit warnings', () => {
  it('warns when a window reaches the threshold', async () => {
    usageList = [usage('a', { fiveHour: window('five_hour', '5-Stunden-Fenster', 84.6) })]
    await start()
    expect(created()).toHaveLength(1)
    const [notification] = created()
    expect(notification.options).toMatchObject({ title: 'Limit fast erreicht', body: 'Alpha\n5-Stunden-Fenster: 85 %, Reset um 16:00', silent: false })
    expect(notification.shown).toBe(true)
  })

  it('stays quiet below the threshold', async () => {
    usageList = [usage('a', { fiveHour: window('five_hour', '5h', 79.4) })]
    await start()
    expect(created()).toEqual([])
  })

  it('says the limit is reached at 100 % and lists all windows, highest first', async () => {
    usageList = [
      usage('a', {
        fiveHour: window('five_hour', '5-Stunden-Fenster', 100),
        sevenDay: window('seven_day', 'Woche · alle Modelle', 91, RESET_TUESDAY),
        scoped: [window('weekly_opus', 'Opus · Woche', 95, null)],
      }),
    ]
    await start()
    expect(created().map((n) => n.options)).toMatchObject([
      {
        title: 'Limit erreicht',
        body: `Alpha\n5-Stunden-Fenster: 100 %, Reset um 16:00\nOpus · Woche: 95 %\nWoche · alle Modelle: 91 %, Reset ${TUESDAY} 09:00`,
      },
    ])
  })

  it('warns once per window and reset', async () => {
    usageList = [usage('a', { fiveHour: window('five_hour', '5h', 85) })]
    await start()
    usageList = [usage('a', { fiveHour: window('five_hour', '5h', 90) })]
    usageEvents.fire('changed')
    expect(created()).toHaveLength(1)
    // The next window warns again.
    vi.setSystemTime(Date.parse(RESET_TODAY) + 1000)
    usageList = [usage('a', { fiveHour: window('five_hour', '5h', 88, LATER) })]
    usageEvents.fire('changed')
    expect(created()).toHaveLength(2)
  })

  it('replaces the earlier warning of the same account', async () => {
    usageList = [usage('a', { fiveHour: window('five_hour', '5h', 85) })]
    await start()
    usageList = [usage('a', { fiveHour: window('five_hour', '5h', 85), sevenDay: window('seven_day', '7d', 82) })]
    usageEvents.fire('changed')
    const [first, second] = created()
    expect(first.closed).toBe(true)
    expect(second.closed).toBe(false)
    expect(second.options.body).toBe('Alpha\n7d: 82 %, Reset um 16:00')
  })

  it('warns per account', async () => {
    accountList = [account('a', 'Alpha'), account('b', 'Beta')]
    usageList = [usage('a', { fiveHour: window('five_hour', '5h', 85) }), usage('b', { fiveHour: window('five_hour', '5h', 99) })]
    await start()
    expect(created().map((n) => n.options.body.split('\n')[0])).toEqual(['Alpha', 'Beta'])
    expect(created().every((n) => !n.closed)).toBe(true)
  })

  it('skips the standard account when another account has the same login', async () => {
    accountList = [
      account('system', 'Standard', 'system', 'me@example.com', 'org-1'),
      account('twin', 'Ich', 'oauth', 'ME@example.com', 'org-1'),
    ]
    usageList = [usage('system', { fiveHour: window('five_hour', '5h', 90) }), usage('twin', { fiveHour: window('five_hour', '5h', 90) })]
    await start()
    expect(created().map((n) => n.options.body.split('\n')[0])).toEqual(['Ich'])
  })

  it('warns for the standard account without such a twin', async () => {
    accountList = [
      account('system', 'Standard', 'system', 'me@example.com', 'org-1'),
      account('other-org', 'Team', 'oauth', 'me@example.com', 'org-2'),
      account('token', 'Token', 'token', 'me@example.com', 'org-1'),
    ]
    usageList = [usage('system', { fiveHour: window('five_hour', '5h', 90) })]
    await start()
    expect(created().map((n) => n.options.body.split('\n')[0])).toEqual(['Standard'])
  })

  it('shows the usage page on a click', async () => {
    usageList = [usage('a', { fiveHour: window('five_hour', '5h', 85) })]
    await start()
    created()[0].handlers.get('click')?.()
    expect(open.usage).toHaveBeenCalledOnce()
  })

  it('is silent without sound', async () => {
    settingsValue.notifications.sound = false
    usageList = [usage('a', { fiveHour: window('five_hour', '5h', 85) })]
    await start()
    expect(created()[0].options.silent).toBe(true)
  })

  it('gives Linux the icon', async () => {
    usageList = [usage('a', { fiveHour: window('five_hour', '5h', 85) })]
    await start()
    expect(created()[0].options.icon).toBe(process.platform === 'linux' ? 'icon:icon.png' : undefined)
  })

  it.each([
    ['notifications are off', { enabled: false }],
    ['the limit warning is off', { onNearLimit: false }],
    ['system notifications are off', { toast: false }],
  ])('stays quiet while %s, and warns once switched on', async (_name, off) => {
    Object.assign(settingsValue.notifications, off)
    usageList = [usage('a', { fiveHour: window('five_hour', '5h', 85) })]
    await start()
    usageEvents.fire('changed')
    expect(created()).toEqual([])
    changeSettings({ enabled: true, onNearLimit: true, toast: true })
    expect(titles()).toEqual(['Limit fast erreicht'])
  })

  it('checks again when the threshold is lowered', async () => {
    settingsValue.notifications.nearLimitPercent = 90
    usageList = [usage('a', { fiveHour: window('five_hour', '5h', 85) })]
    await start()
    expect(created()).toEqual([])
    changeSettings({ nearLimitPercent: 80 })
    expect(created()).toHaveLength(1)
  })

  it('does not check on unrelated setting changes', async () => {
    settingsValue.notifications.onNearLimit = false
    usageList = [usage('a', { fiveHour: window('five_hour', '5h', 85) })]
    await start()
    settingsValue.notifications.onNearLimit = true
    // Only the sound changes in the event: the warning was "on" before as well.
    changeSettings({ sound: false })
    expect(created()).toEqual([])
  })

  it('remembers the warned windows in the cache', async () => {
    usageList = [usage('a', { fiveHour: window('five_hour', '5h', 85) })]
    await start()
    await vi.waitFor(async () => {
      expect(JSON.parse(await readFile(warnedFile(), 'utf8'))).toEqual({ version: 1, warned: { 'a\nfive_hour': RESET_TODAY } })
    })
  })

  it('does not warn again after a restart within the same window', async () => {
    await mkdir(join(dir, 'cache'), { recursive: true })
    await writeFile(warnedFile(), JSON.stringify({ version: 1, warned: { 'a\nfive_hour': RESET_TODAY } }))
    usageList = [usage('a', { fiveHour: window('five_hour', '5h', 85) })]
    await start()
    expect(created()).toEqual([])
  })

  it('drops remembered windows of removed accounts and broken entries', async () => {
    await mkdir(join(dir, 'cache'), { recursive: true })
    await writeFile(
      warnedFile(),
      JSON.stringify({ version: 1, warned: { 'a\nfive_hour': RESET_TODAY, 'a\nseven_day': 42, 'gone\nfive_hour': null } }),
    )
    usageList = [usage('a', { fiveHour: window('five_hour', '5h', 85) })]
    await start()
    expect(created()).toEqual([])
    await vi.waitFor(async () => {
      expect(JSON.parse(await readFile(warnedFile(), 'utf8'))).toEqual({ version: 1, warned: { 'a\nfive_hour': RESET_TODAY } })
    })
  })

  it('ignores a cache file of another version', async () => {
    await mkdir(join(dir, 'cache'), { recursive: true })
    await writeFile(warnedFile(), JSON.stringify({ version: 2, warned: { 'a\nfive_hour': RESET_TODAY } }))
    usageList = [usage('a', { fiveHour: window('five_hour', '5h', 85) })]
    await start()
    expect(created()).toHaveLength(1)
  })

  it('takes back the warning of a removed account', async () => {
    accountList = [account('a', 'Alpha'), account('b', 'Beta')]
    usageList = [usage('b', { fiveHour: window('five_hour', '5h', 85) })]
    await start()
    accountList = [account('a', 'Alpha')]
    usageEvents.fire('changed')
    expect(created()[0].closed).toBe(true)
  })

  it('shows nothing where the system has no notifications', async () => {
    FakeNotification.supported = false
    usageList = [usage('a', { fiveHour: window('five_hour', '5h', 85) })]
    await start()
    expect(created()).toEqual([])
  })
})

// --- finished turns ------------------------------------------------------------

describe('finished turns', () => {
  it('notifies, marks the tab and flashes the taskbar for a window in the background', async () => {
    await start()
    terminalEvents.fire('turnEnded', 't1', turn({ detail: '**Done.** See `src/app.ts`.' }))
    expect(setAttention).toHaveBeenCalledWith('t1', 'done')
    expect(created().map((n) => n.options)).toMatchObject([{ title: 'Claude ist fertig', body: 'Tab\nDone. See src/app.ts.' }])
    expect(win?.flashFrame).toHaveBeenCalledWith(true)
  })

  it('stays quiet for the tab the user looks at', async () => {
    win = { ...win!, isFocused: () => true }
    const service = await start()
    service.setViewing(['t1'])
    setAttention.mockClear()
    terminalEvents.fire('turnEnded', 't1', turn())
    expect(setAttention).not.toHaveBeenCalled()
    expect(created()).toEqual([])
  })

  it('counts every terminal of a split tab as shown', async () => {
    win = { ...win!, isFocused: () => true }
    terminalList = [terminal(), terminal({ id: 't2', title: 'Zwei' })]
    const service = await start()
    service.setViewing(['t1', 't2'])
    setAttention.mockClear()
    terminalEvents.fire('turnEnded', 't2', turn())
    expect(setAttention).not.toHaveBeenCalled()
    expect(created()).toEqual([])
  })

  it('only marks another tab while the window is in front, unless set to notify for hidden tabs', async () => {
    win = { ...win!, isFocused: () => true }
    terminalList = [terminal(), terminal({ id: 't2', title: 'Zwei' })]
    const service = await start()
    service.setViewing(['t1'])
    terminalEvents.fire('turnEnded', 't2', turn())
    expect(setAttention).toHaveBeenCalledWith('t2', 'done')
    expect(created()).toEqual([])

    settingsValue.notifications.when = 'hidden'
    terminalEvents.fire('turnEnded', 't2', turn())
    expect(titles()).toEqual(['Claude ist fertig'])
    // The window is in front: no flashing.
    expect(win.flashFrame).not.toHaveBeenCalled()
  })

  it.each([
    ['hidden', { isVisible: () => false }],
    ['minimized', { isMinimized: () => true }],
    ['destroyed', { isDestroyed: () => true }],
  ])('treats a %s window as in the background', async (_name, state) => {
    win = { ...win!, isFocused: () => true, ...state }
    await start()
    terminalEvents.fire('turnEnded', 't1', turn())
    expect(created()).toHaveLength(1)
  })

  it('only marks a muted tab', async () => {
    terminalList = [terminal({ muted: true })]
    await start()
    terminalEvents.fire('turnEnded', 't1', turn())
    expect(setAttention).toHaveBeenCalledWith('t1', 'done')
    expect(created()).toEqual([])
    expect(win?.flashFrame).not.toHaveBeenCalled()
  })

  it('skips short answers, but not questions', async () => {
    settingsValue.notifications.minBusySeconds = 30
    await start()
    terminalEvents.fire('turnEnded', 't1', turn({ busyMs: 29_000 }))
    expect(created()).toEqual([])
    expect(setAttention).toHaveBeenCalledWith('t1', 'done')
    terminalEvents.fire('turnEnded', 't1', turn({ kind: 'input', busyMs: 1000, tool: 'Bash', detail: 'npm test' }))
    expect(titles()).toEqual(['Claude braucht deine Erlaubnis'])
  })

  it.each([
    ['onDone', 'done'],
    ['onInput', 'input'],
    ['onLimit', 'limit'],
  ] as const)('does nothing for a turn whose kind is switched off (%s)', async (setting, kind) => {
    settingsValue.notifications[setting] = false
    await start()
    terminalEvents.fire('turnEnded', 't1', turn({ kind }))
    expect(setAttention).not.toHaveBeenCalled()
    expect(created()).toEqual([])
  })

  it('does nothing with notifications off', async () => {
    settingsValue.notifications.enabled = false
    await start()
    terminalEvents.fire('turnEnded', 't1', turn())
    expect(setAttention).not.toHaveBeenCalled()
    expect(created()).toEqual([])
  })

  it('leaves out what is switched off: dot, toast, flashing', async () => {
    Object.assign(settingsValue.notifications, { unreadDot: false, toast: false })
    await start()
    terminalEvents.fire('turnEnded', 't1', turn())
    expect(setAttention).not.toHaveBeenCalled()
    expect(created()).toEqual([])
    expect(win?.flashFrame).toHaveBeenCalledWith(true)

    vi.clearAllMocks()
    Object.assign(settingsValue.notifications, { toast: true, flashTaskbar: false })
    terminalEvents.fire('turnEnded', 't1', turn())
    expect(created()).toHaveLength(1)
    expect(win?.flashFrame).not.toHaveBeenCalled()
  })

  it('ignores a tab that is gone', async () => {
    await start()
    terminalEvents.fire('turnEnded', 'gone', turn())
    expect(created()).toEqual([])
  })

  it.each([
    ['a question', { kind: 'input', tool: 'AskUserQuestion', detail: 'Welche Datenbank?' }, true, 'Claude hat eine Frage', 'Tab\nWelche Datenbank?'],
    ['a plan', { kind: 'input', tool: 'ExitPlanMode', detail: null }, true, 'Claude wartet auf die Freigabe des Plans', 'Tab'],
    ['a permission', { kind: 'input', tool: 'Bash', detail: 'npm   test\n--watch' }, true, 'Claude braucht deine Erlaubnis', 'Tab\nBash: npm test --watch'],
    ['a permission without details', { kind: 'input', tool: null, detail: null }, true, 'Claude braucht deine Erlaubnis', 'Tab\nein Tool'],
    ['a permission without preview', { kind: 'input', tool: 'Bash', detail: 'rm -rf /' }, false, 'Claude braucht deine Erlaubnis', 'Tab'],
    ['an answer without preview', { kind: 'done', detail: 'Geheim' }, false, 'Claude ist fertig', 'Tab'],
    ['a limit without a reset', { kind: 'limit', detail: "You've hit your limit" }, true, 'Nutzungslimit erreicht', "Tab\nYou've hit your limit"],
  ] as const)('describes %s', async (_name, overrides, preview, title, body) => {
    settingsValue.notifications.preview = preview
    await start()
    terminalEvents.fire('turnEnded', 't1', turn(overrides))
    expect(created().map((n) => n.options)).toMatchObject([{ title, body }])
  })

  it('names the limit and its reset', async () => {
    terminalList = [terminal({ limit: { type: 'seven_day_opus', resetsAt: RESET_TUESDAY, message: 'limit' } })]
    await start()
    terminalEvents.fire('turnEnded', 't1', turn({ kind: 'limit', detail: 'ignored' }))
    expect(created()[0].options).toMatchObject({ title: 'Wochenlimit für Opus erreicht', body: `Tab\nReset ${TUESDAY} 09:00` })
  })

  it('shortens long details', async () => {
    await start()
    terminalEvents.fire('turnEnded', 't1', turn({ detail: 'x'.repeat(300) }))
    expect(created()[0].options.body).toBe(`Tab\n${'x'.repeat(179)}…`)
  })

  it('keeps one notification per tab and opens the tab on a click', async () => {
    await start()
    terminalEvents.fire('turnEnded', 't1', turn())
    terminalEvents.fire('turnEnded', 't1', turn({ kind: 'input', tool: 'Bash' }))
    const [first, second] = created()
    expect(first.closed).toBe(true)
    expect(second.closed).toBe(false)
    second.handlers.get('click')?.()
    expect(open.terminal).toHaveBeenCalledWith('t1')
  })

  it('takes the notification back once the tab is seen', async () => {
    const service = await start()
    terminalEvents.fire('turnEnded', 't1', turn())
    service.setViewing(['t1'])
    expect(created()[0].closed).toBe(true)
    expect(setAttention).toHaveBeenLastCalledWith('t1', null)
  })

  it('takes the notification back when the window comes to the front on the tab', async () => {
    const service = await start()
    service.setViewing([])
    terminalEvents.fire('turnEnded', 't1', turn())
    service.windowFocused()
    expect(created()[0].closed).toBe(false)
    service.setViewing(['t1'])
    terminalEvents.fire('turnEnded', 't1', turn())
    expect(created()).toHaveLength(2)
    service.windowFocused()
    expect(created()[1].closed).toBe(true)
  })

  it('takes the notification of a closed tab back', async () => {
    terminalList = [terminal(), terminal({ id: 't2' })]
    await start()
    terminalEvents.fire('turnEnded', 't1', turn())
    terminalEvents.fire('turnEnded', 't2', turn())
    terminalEvents.fire('changed', [terminal({ id: 't2' })])
    expect(created().map((n) => n.closed)).toEqual([true, false])
  })

  it('clears the dots when they are switched off', async () => {
    terminalList = [terminal({ attention: 'done' }), terminal({ id: 't2' })]
    await start()
    changeSettings({ unreadDot: false })
    expect(setAttention.mock.calls).toEqual([['t1', null]])
  })
})

describe('automatic account switch', () => {
  /** Stands in for AutoSwitch: its events and which tabs it is switching. */
  function switcher(switching: string[] = []) {
    return Object.assign(new Emitter(), { tellsLimit: (id: string) => switching.includes(id) })
  }
  const atLimit = () => terminal({ limit: { type: 'five_hour', resetsAt: LATER, message: 'limit' } })

  it('leaves out the limit notice of a tab that goes on with another account', async () => {
    const service = await start()
    service.watchAutoSwitch(switcher(['t1']) as never)
    terminalEvents.fire('turnEnded', 't1', turn({ kind: 'limit' }))
    expect(created()).toEqual([])
    expect(setAttention).not.toHaveBeenCalled()
    // Other tabs still get theirs.
    terminalList = [terminal(), terminal({ id: 't2' })]
    terminalEvents.fire('turnEnded', 't2', turn({ kind: 'limit' }))
    expect(created()).toHaveLength(1)
  })

  it('tells the limit together with the account the session goes on with, and opens the new tab', async () => {
    accountList = [account('a', 'Alpha'), account('b', 'Beta')]
    const events = switcher()
    const service = await start()
    service.watchAutoSwitch(events as never)
    events.fire('switched', atLimit(), terminal({ id: 't2', authAccountId: 'b' }), account('b', 'Beta'))
    expect(created().map((n) => n.options)).toMatchObject([
      { title: 'Weiter mit „Beta“', body: 'Tab\n5-Stunden-Limit von „Alpha“ erreicht' },
    ])
    created()[0].handlers.get('click')?.()
    expect(open.terminal).toHaveBeenCalledWith('t2')
    expect(win?.flashFrame).toHaveBeenCalledWith(true)
  })

  it('tells that a session goes on with its own account after the reset', async () => {
    accountList = [account('a', 'Alpha')]
    const events = switcher()
    const service = await start()
    service.watchAutoSwitch(events as never)
    events.fire('switched', atLimit(), terminal({ id: 't2' }), account('a', 'Alpha'))
    expect(created().map((n) => n.options)).toMatchObject([
      { title: 'Limit zurückgesetzt', body: 'Tab\nDie Session läuft mit „Alpha“ weiter' },
    ])
  })

  it('tells when the switch failed', async () => {
    const events = switcher()
    const service = await start()
    service.watchAutoSwitch(events as never)
    events.fire('failed', atLimit(), account('b', 'Beta'), 'Kopie ist neuer')
    expect(created().map((n) => n.options)).toMatchObject([
      { title: 'Wechsel zu „Beta“ fehlgeschlagen', body: 'Tab\n5-Stunden-Limit erreicht · Kopie ist neuer' },
    ])
  })

  it('stays quiet without limit notifications, for muted tabs and for the tab on screen', async () => {
    const events = switcher()
    win = { ...win!, isFocused: () => true }
    const service = await start()
    service.watchAutoSwitch(events as never)
    service.setViewing(['t1'])
    events.fire('switched', atLimit(), terminal({ id: 't2' }), account('b', 'Beta'))
    events.fire('switched', atLimit(), terminal({ id: 't3', muted: true }), account('b', 'Beta'))
    settingsValue.notifications.onLimit = false
    win = { ...win!, isFocused: () => false }
    events.fire('switched', atLimit(), terminal({ id: 't4' }), account('b', 'Beta'))
    expect(created()).toEqual([])
  })
})
