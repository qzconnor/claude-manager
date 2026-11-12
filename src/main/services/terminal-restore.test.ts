import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserOpenOptions, PaneNode, PaneSplit, TerminalCreateOptions, TerminalInfo, TerminalSleep } from '@shared/types'

// terminal-service (for the default title) pulls in modules that import electron.
vi.mock('electron', () => ({ app: { getPath: () => tmpdir(), isPackaged: false } }))

import { projectKey } from '../lib/session-files'
import type { AccountService } from './account-service'
import type { SettingsService } from './settings-service'
import { TerminalRestore } from './terminal-restore'
import type { SleepingTerminal, TerminalService } from './terminal-service'

const S1 = '0f8fad5b-d9cb-469f-a165-70867728950e'
const S2 = '7c9e6679-7425-40de-944b-e07fc1f90ae7'

type Listener = (...args: never[]) => void

/** Just enough of an event emitter: `on` returns the function that removes the listener. */
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

let dir: string
let configDir: string
let file: string
let terminalList: TerminalInfo[]
let layoutList: PaneSplit[]
let restoreTerminals: boolean
let restoreAsleep: boolean
const terminalEvents = new Emitter()
const settingsEvents = new Emitter()
const sleep = vi.fn<(options: SleepingTerminal) => TerminalInfo>()
const wake = vi.fn<(id: string, options: TerminalCreateOptions) => TerminalInfo>()
const setSleep = vi.fn<(id: string, sleep: TerminalSleep) => void>()
const arrange = vi.fn<(layout: PaneNode) => void>()
const openBrowser = vi.fn<(options: BrowserOpenOptions) => TerminalInfo>()

const terminals = {
  on: (event: string, listener: Listener) => terminalEvents.on(event, listener),
  list: () => terminalList,
  layouts: () => layoutList,
  sleep,
  wake,
  setSleep,
  arrange,
  openBrowser,
  runningSession: (accountId: string, sessionId: string) =>
    terminalList.find((t) => t.status === 'running' && t.mode === 'session' && t.accountId === accountId && t.sessionId === sessionId) ??
    null,
} as unknown as TerminalService

const accounts = {
  list: () => [
    { id: 'acc-a', name: 'Alpha' },
    { id: 'acc-b', name: 'Beta' },
  ],
  paths: () => ({ projectsDir: join(configDir, 'projects') }),
} as unknown as AccountService

const settings = {
  get: () => ({ general: { restoreTerminals, restoreAsleep } }),
  on: (event: string, listener: Listener) => settingsEvents.on(event, listener),
} as unknown as SettingsService

function info(overrides: Partial<TerminalInfo>): TerminalInfo {
  return {
    id: 't',
    accountId: 'acc-a',
    authAccountId: 'acc-a',
    sessionId: null,
    limit: null,
    resume: null,
    context: null,
    busy: false,
    attention: null,
    muted: false,
    title: 'Tab',
    fixedTitle: false,
    autoTitle: 'Tab',
    cwd: join(dir, 'project'),
    mode: 'session',
    url: null,
    resumeSessionId: null,
    args: [],
    status: 'running',
    sleep: null,
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

async function readSaved(): Promise<unknown> {
  return JSON.parse(await readFile(file, 'utf8'))
}

async function writeTranscript(sessionId: string, cwd: string): Promise<void> {
  const folder = join(configDir, 'projects', projectKey(cwd))
  await mkdir(folder, { recursive: true })
  await writeFile(join(folder, `${sessionId}.jsonl`), '{}\n')
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'cm-test-'))
  configDir = join(dir, 'config')
  file = join(dir, 'open-terminals.json')
  terminalList = []
  layoutList = []
  restoreTerminals = true
  restoreAsleep = true
  arrange.mockReset()
  openBrowser.mockReset()
  openBrowser.mockImplementation((options) => {
    const browser = info({ id: `browser-${openBrowser.mock.calls.length}`, mode: 'browser', url: options.url ?? null, fixedTitle: false })
    terminalList = [...terminalList, browser]
    return browser
  })
  // Like the service: the waiting tab is in the list, and starting it keeps its id.
  sleep.mockReset()
  sleep.mockImplementation((options) => {
    const tab = info({
      ...options,
      id: `new-${sleep.mock.calls.length}`,
      title: options.title ?? 'Default',
      resumeSessionId: options.sessionId,
      status: 'asleep',
      sleep: { waking: false, error: null },
    })
    terminalList = [...terminalList, tab]
    return tab
  })
  wake.mockReset()
  wake.mockImplementation((id) => {
    const started = info({ ...terminalList.find((t) => t.id === id), status: 'running', sleep: null })
    terminalList = terminalList.map((t) => (t.id === id ? started : t))
    return started
  })
  setSleep.mockReset()
})

let restore: TerminalRestore | null = null

afterEach(async () => {
  restore?.dispose()
  restore = null
  await rm(dir, { recursive: true, force: true, maxRetries: 3 })
})

function start(): TerminalRestore {
  restore = new TerminalRestore(dir, terminals, accounts, settings)
  return restore
}

const shell = { accountId: 'acc-a', authAccountId: 'acc-a', cwd: '', mode: 'shell', sessionId: null, fixedTitle: true }

describe('TerminalRestore on start', () => {
  it('opens the saved tabs again as tabs that wait to start', async () => {
    const project = join(dir, 'project')
    const other = join(dir, 'other')
    await writeFile(
      file,
      JSON.stringify([
        // Default title of an older version without fixedTitle: follows the session again.
        {
          accountId: 'acc-a',
          authAccountId: 'acc-a',
          cwd: project,
          mode: 'session',
          sessionId: S1,
          title: 'Alpha · project',
          args: ['--model', 'opus'],
        },
        // The lending account is gone; a chosen title of an older version.
        { accountId: 'acc-b', authAccountId: 'gone', cwd: other, mode: 'session', sessionId: S2, title: 'Custom', muted: true },
        // The title Claude gave the session.
        {
          accountId: 'acc-a',
          authAccountId: 'acc-b',
          cwd: project,
          mode: 'session',
          sessionId: null,
          title: 'Fix the build',
          fixedTitle: false,
        },
        { accountId: 'acc-a', authAccountId: 'acc-a', cwd: other, mode: 'shell', sessionId: null, title: 'Build', fixedTitle: true },
        // Today's default titles name the folder, not the account.
        { accountId: 'acc-a', authAccountId: 'acc-a', cwd: other, mode: 'shell', sessionId: null, title: 'Shell · other' },
      ]),
    )
    await start().init()
    const base = { muted: false, args: [], restoredFrom: null }
    expect(sleep.mock.calls.map(([options]) => options)).toEqual([
      {
        ...base,
        accountId: 'acc-a',
        authAccountId: 'acc-a',
        cwd: project,
        mode: 'session',
        sessionId: S1,
        title: null,
        fixedTitle: false,
        args: ['--model', 'opus'],
      },
      {
        ...base,
        accountId: 'acc-b',
        authAccountId: 'acc-b',
        cwd: other,
        mode: 'session',
        sessionId: S2,
        title: 'Custom',
        fixedTitle: true,
        muted: true,
      },
      {
        ...base,
        accountId: 'acc-a',
        authAccountId: 'acc-b',
        cwd: project,
        mode: 'session',
        sessionId: null,
        title: 'Fix the build',
        fixedTitle: false,
      },
      { ...base, accountId: 'acc-a', authAccountId: 'acc-a', cwd: other, mode: 'shell', sessionId: null, title: 'Build', fixedTitle: true },
      { ...base, accountId: 'acc-a', authAccountId: 'acc-a', cwd: other, mode: 'shell', sessionId: null, title: null, fixedTitle: false },
    ])
    // Nothing starts before the window shows it.
    expect(wake).not.toHaveBeenCalled()
  })

  it('starts a waiting tab in its place once woken, going on with its session', async () => {
    const project = join(dir, 'project')
    await mkdir(project)
    await writeTranscript(S1, project)
    await writeFile(
      file,
      JSON.stringify([
        { accountId: 'acc-a', authAccountId: 'acc-b', cwd: project, mode: 'session', sessionId: S1, title: 'T', args: ['--model', 'opus'] },
      ]),
    )
    const service = start()
    await service.init()
    // Renamed and muted while it waited.
    terminalList = terminalList.map((t) => ({ ...t, title: 'Mine', fixedTitle: true, muted: true }))
    await service.wake('new-1')
    expect(setSleep.mock.calls).toEqual([['new-1', { waking: true, error: null }]])
    expect(wake.mock.calls).toEqual([
      [
        'new-1',
        {
          accountId: 'acc-a',
          authAccountId: 'acc-b',
          cwd: project,
          mode: 'session',
          resumeSessionId: S1,
          title: 'Mine',
          muted: true,
          args: ['--model', 'opus'],
          restoredFrom: null,
        },
      ],
    ])
    // Started once: asked again, nothing happens.
    await service.wake('new-1')
    expect(wake).toHaveBeenCalledOnce()
  })

  it('starts a new session when the saved one was never written, and a session /cd moved in its new folder', async () => {
    const project = join(dir, 'project')
    const moved = join(dir, 'moved')
    await mkdir(project)
    await mkdir(moved)
    // Claude Code took the transcript along into the project folder of the new folder.
    await mkdir(join(configDir, 'projects', projectKey(project)), { recursive: true })
    const folder = join(configDir, 'projects', projectKey(moved))
    await mkdir(folder, { recursive: true })
    await writeFile(join(folder, `${S1}.jsonl`), `${JSON.stringify({ type: 'relocated', sessionId: S1, relocatedCwd: moved })}\n`)
    const tab = { accountId: 'acc-a', authAccountId: 'acc-a', cwd: project, mode: 'session', title: 'T', fixedTitle: false }
    await writeFile(
      file,
      JSON.stringify([
        { ...tab, sessionId: S1 },
        { ...tab, sessionId: S2 },
      ]),
    )
    const service = start()
    await service.init()
    await service.wake('new-1')
    await service.wake('new-2')
    expect(wake.mock.calls.map(([, options]) => [options.cwd, options.resumeSessionId])).toEqual([
      [moved, S1],
      [project, null],
    ])
  })

  it('keeps a tab that did not start waiting, with the reason, and starts it when tried again', async () => {
    const missing = join(dir, 'missing')
    await writeFile(
      file,
      JSON.stringify([
        { ...shell, cwd: missing, title: 'gone' },
        { ...shell, cwd: dir, title: 'busy' },
      ]),
    )
    const service = start()
    await service.init()
    // A folder that isn't there is not even tried.
    await service.wake('new-1')
    expect(wake).not.toHaveBeenCalled()
    expect(setSleep.mock.calls.at(-1)).toEqual(['new-1', { waking: false, error: `Den Ordner „${missing}“ gibt es nicht.` }])
    wake.mockImplementationOnce(() => {
      throw new Error('Claude Code wurde nicht gefunden.')
    })
    await service.wake('new-2')
    expect(setSleep.mock.calls.at(-1)).toEqual(['new-2', { waking: false, error: 'Claude Code wurde nicht gefunden.' }])
    // The file keeps them as they were.
    terminalEvents.fire('changed', terminalList)
    expect(((await readSaved()) as { title: string }[]).map((t) => t.title)).toEqual(['gone', 'busy'])

    await mkdir(missing)
    await service.wake('new-1')
    expect(setSleep.mock.calls.at(-1)).toEqual(['new-1', { waking: true, error: null }])
    expect(wake.mock.calls.at(-1)![0]).toBe('new-1')
  })

  it('starts a tab once when asked twice while it starts', async () => {
    await writeFile(file, JSON.stringify([{ ...shell, cwd: dir, title: 'a' }]))
    const service = start()
    await service.init()
    await Promise.all([service.wake('new-1'), service.wake('new-1')])
    expect(wake).toHaveBeenCalledOnce()
    expect(setSleep.mock.calls).toEqual([['new-1', { waking: true, error: null }]])
  })

  it('tells when the account of a waiting tab is gone by now', async () => {
    await writeFile(file, JSON.stringify([{ ...shell, cwd: dir, title: 'a' }]))
    const service = start()
    await service.init()
    terminalList = terminalList.map((t) => ({ ...t, authAccountId: 'removed' }))
    await service.wake('new-1')
    expect(wake).not.toHaveBeenCalled()
    expect(setSleep.mock.calls.at(-1)).toEqual(['new-1', { waking: false, error: 'Den Account dieses Tabs gibt es nicht mehr.' }])
  })

  it('does not start a waiting tab whose session runs in another tab by now', async () => {
    const project = join(dir, 'project')
    await mkdir(project)
    await writeTranscript(S1, project)
    await writeFile(
      file,
      JSON.stringify([{ accountId: 'acc-a', authAccountId: 'acc-a', cwd: project, mode: 'session', sessionId: S1, title: 'T' }]),
    )
    const service = start()
    await service.init()
    terminalList = [...terminalList, info({ id: 'other', sessionId: S1 })]
    await service.wake('new-1')
    expect(wake).not.toHaveBeenCalled()
    expect(setSleep.mock.calls.at(-1)).toEqual(['new-1', { waking: false, error: 'Die Session läuft schon in einem anderen Tab.' }])
  })

  it('starts nothing for a waiting tab that was closed, also while it looked at its folder', async () => {
    await writeFile(
      file,
      JSON.stringify([
        { ...shell, cwd: dir, title: 'a' },
        { ...shell, cwd: dir, title: 'b' },
      ]),
    )
    const service = start()
    await service.init()
    const waking = service.wake('new-1')
    terminalList = terminalList.filter((t) => t.id !== 'new-1')
    terminalEvents.fire('changed', terminalList)
    await waking
    terminalList = terminalList.filter((t) => t.id !== 'new-2')
    terminalEvents.fire('changed', terminalList)
    await service.wake('new-2')
    expect(wake).not.toHaveBeenCalled()
    expect(setSleep.mock.calls.map(([id]) => id)).toEqual(['new-1'])
  })

  it('starts the tabs one after the other right away when they should not wait', async () => {
    restoreAsleep = false
    await writeFile(
      file,
      JSON.stringify([
        { ...shell, cwd: dir, title: 'a' },
        { ...shell, cwd: join(dir, 'missing'), title: 'b' },
        { ...shell, cwd: dir, title: 'c' },
      ]),
    )
    await start().init()
    expect(wake.mock.calls.map(([id]) => id)).toEqual(['new-1', 'new-3'])
    expect(setSleep.mock.calls.at(-2)![1].error).toContain('gibt es nicht')
  })

  it('leaves out invalid tabs and tabs of removed accounts', async () => {
    const valid = { accountId: 'acc-a', authAccountId: 'acc-a', cwd: dir, mode: 'session', sessionId: null, title: 'T' }
    await writeFile(
      file,
      JSON.stringify([
        null,
        'tab',
        { ...valid, accountId: 'gone' },
        { ...valid, mode: 'login' },
        { ...valid, sessionId: 'not-a-session' },
        { ...valid, cwd: 5 },
        { ...valid, title: undefined },
        { ...valid, fixedTitle: 'yes' },
        { ...valid, muted: 1 },
        { ...valid, args: '--model opus' },
        { ...valid, args: ['--model', 5] },
        // A count of failed starts of an older version doesn't matter.
        { ...valid, title: 'kept', failedStarts: 2 },
      ]),
    )
    await start().init()
    expect(sleep).toHaveBeenCalledOnce()
    expect(sleep.mock.calls[0][0].title).toBe('kept')
  })

  it('puts the tabs of a split tab together again, without those that are left out', async () => {
    const tab = { accountId: 'acc-a', authAccountId: 'acc-a', cwd: dir, mode: 'shell', sessionId: null, fixedTitle: false }
    const split = (first: PaneNode, second: PaneNode, direction: 'row' | 'column' = 'row') => ({ direction, ratio: 0.3, first, second })
    await writeFile(
      file,
      JSON.stringify([
        { ...tab, title: 'a', layout: split('0', split('1', '2', 'column')) },
        // Of an account that is gone.
        { ...tab, title: 'b', accountId: 'gone' },
        { ...tab, title: 'c' },
        { ...tab, title: 'alone' },
        // Broken: refers to itself twice.
        { ...tab, title: 'd', layout: split('4', '4') },
        { ...tab, title: 'e' },
        { ...tab, title: 'f', layout: split('6', '7') },
        { ...tab, title: 'g', accountId: 'gone' },
      ]),
    )
    await start().init()
    expect(arrange.mock.calls).toEqual([[split('new-1', 'new-2')]])
  })

  it('opens browsers again at their page, next to the terminals they shared a tab with', async () => {
    await writeFile(
      file,
      JSON.stringify([
        { ...shell, cwd: dir, title: 's', fixedTitle: false, layout: { direction: 'row', ratio: 0.4, first: '0', second: '1' } },
        { mode: 'browser', url: 'http://localhost:5173/', title: 'Vite App', fixedTitle: false },
        { mode: 'browser', url: 'https://example.com/', title: 'Docs', fixedTitle: true },
        // Not a page the browser may show: left out.
        { mode: 'browser', url: 'file:///C:/Windows/win.ini', title: 'x', fixedTitle: false },
      ]),
    )
    await start().init()
    expect(openBrowser.mock.calls).toEqual([
      [{ url: 'http://localhost:5173/', title: null, restoredFrom: null }],
      [{ url: 'https://example.com/', title: 'Docs', restoredFrom: null }],
    ])
    expect(arrange.mock.calls).toEqual([[{ direction: 'row', ratio: 0.4, first: 'new-1', second: 'browser-1' }]])
  })

  it('tells each tab the id it had, so the window finds its group again', async () => {
    const tab = { ...shell, cwd: dir, title: 's', fixedTitle: false }
    await writeFile(
      file,
      JSON.stringify([
        { ...tab, id: 'old-1' },
        { id: 'old-2', mode: 'browser', url: 'https://example.com/', title: 'Docs', fixedTitle: false },
        { ...tab, id: '../not an id' },
      ]),
    )
    const service = start()
    await service.init()
    expect(sleep.mock.calls.map(([options]) => options.restoredFrom)).toEqual(['old-1', null])
    expect(openBrowser.mock.calls[0]![0].restoredFrom).toBe('old-2')
    await service.wake('new-1')
    expect(wake.mock.calls[0]![1].restoredFrom).toBe('old-1')
  })

  it('opens nothing for a file that is no list', async () => {
    await writeFile(file, JSON.stringify({ accountId: 'acc-a' }))
    await start().init()
    expect(sleep).not.toHaveBeenCalled()
  })

  it('opens nothing and forgets the tabs when restoring is off', async () => {
    restoreTerminals = false
    await writeFile(
      file,
      JSON.stringify([{ accountId: 'acc-a', authAccountId: 'acc-a', cwd: dir, mode: 'shell', sessionId: null, title: 'T' }]),
    )
    await start().init()
    expect(sleep).not.toHaveBeenCalled()
    expect(await readSaved()).toEqual([])
  })
})

describe('TerminalRestore while running', () => {
  it('saves the open tabs on every change, without login tabs', async () => {
    await start().init()
    terminalList = [
      info({ id: 'a', sessionId: S1, title: 'Alpha · project', muted: true }),
      info({ id: 'login', mode: 'login' }),
      info({ id: 'b', accountId: 'acc-b', authAccountId: 'acc-a', mode: 'shell', title: 'Build', fixedTitle: true }),
    ]
    terminalEvents.fire('changed', terminalList)
    expect(await readSaved()).toEqual([
      {
        id: 'a',
        accountId: 'acc-a',
        authAccountId: 'acc-a',
        cwd: join(dir, 'project'),
        mode: 'session',
        sessionId: S1,
        title: 'Alpha · project',
        fixedTitle: false,
        muted: true,
      },
      {
        id: 'b',
        accountId: 'acc-b',
        authAccountId: 'acc-a',
        cwd: join(dir, 'project'),
        mode: 'shell',
        sessionId: null,
        title: 'Build',
        fixedTitle: true,
        muted: false,
      },
    ])
  })

  it('saves the own Claude Code options that hold for every start, without the prompt', async () => {
    await start().init()
    terminalList = [info({ id: 'a', sessionId: S1, args: ['--model', 'opus', '--continue', 'Fix the build'] })]
    terminalEvents.fire('changed', terminalList)
    expect(await readSaved()).toMatchObject([{ id: 'a', args: ['--model', 'opus'] }])
  })

  it('saves how split tabs share their space, by index and without login tabs', async () => {
    await start().init()
    terminalList = [info({ id: 'a' }), info({ id: 'login', mode: 'login' }), info({ id: 'b' }), info({ id: 'c' }), info({ id: 'd' })]
    layoutList = [
      { direction: 'row', ratio: 0.6, first: 'a', second: { direction: 'column', ratio: 0.5, first: 'login', second: 'b' } },
      { direction: 'column', ratio: 0.5, first: 'c', second: 'login' },
    ]
    terminalEvents.fire('changed', terminalList)
    const saved = (await readSaved()) as { title: string; layout?: PaneNode }[]
    expect(saved.map((t) => t.layout ?? null)).toEqual([{ direction: 'row', ratio: 0.6, first: '0', second: '1' }, null, null, null])
  })

  it('saves browsers with their page', async () => {
    await start().init()
    terminalList = [
      info({ id: 'a', mode: 'shell' }),
      info({ id: 'web', mode: 'browser', accountId: '', authAccountId: '', cwd: '', url: 'https://example.com/a', title: 'Example', fixedTitle: false }),
    ]
    layoutList = [{ direction: 'column', ratio: 0.5, first: 'a', second: 'web' }]
    terminalEvents.fire('changed', terminalList)
    const saved = (await readSaved()) as Record<string, unknown>[]
    expect(saved[1]).toEqual({ id: 'web', mode: 'browser', url: 'https://example.com/a', title: 'Example', fixedTitle: false })
    expect(saved[0].layout).toEqual({ direction: 'column', ratio: 0.5, first: '0', second: '1' })
  })

  it('does not write unchanged tabs again', async () => {
    await start().init()
    terminalList = [info({ id: 'a' })]
    terminalEvents.fire('changed', terminalList)
    await rm(file)
    terminalEvents.fire('changed', terminalList)
    expect(existsSync(file)).toBe(false)
  })

  it('empties the file when restoring is switched off', async () => {
    terminalList = [info({ id: 'a' })]
    await start().init()
    expect(await readSaved()).toHaveLength(1)
    restoreTerminals = false
    settingsEvents.fire('changed', { general: { restoreTerminals: false } }, { general: { restoreTerminals: true } })
    expect(await readSaved()).toEqual([])
    restoreTerminals = true
    settingsEvents.fire('changed', { general: { restoreTerminals: true } }, { general: { restoreTerminals: false } })
    expect(await readSaved()).toHaveLength(1)
  })

  it('stops following the tabs after dispose', async () => {
    terminalList = [info({ id: 'a' })]
    const service = start()
    await service.init()
    service.dispose()
    terminalList = []
    terminalEvents.fire('changed', terminalList)
    settingsEvents.fire('changed', { general: { restoreTerminals: false } }, { general: { restoreTerminals: true } })
    expect(await readSaved()).toHaveLength(1)
  })

  it('keeps the tabs while the system shuts down, and follows them again if it does not', async () => {
    terminalList = [info({ id: 'a' })]
    const service = start()
    await service.init()
    vi.useFakeTimers()
    try {
      service.hold(60_000)
      // The processes end before the app: their tabs close.
      terminalList = []
      terminalEvents.fire('changed', terminalList)
      expect(await readSaved()).toHaveLength(1)
      vi.advanceTimersByTime(60_000)
      expect(await readSaved()).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })

  it('starts nothing more and keeps the tabs for the next start when disposed while they start', async () => {
    restoreAsleep = false
    const tab = { accountId: 'acc-a', authAccountId: 'acc-a', cwd: dir, mode: 'session', sessionId: S1, title: 'T' }
    await writeFile(
      file,
      JSON.stringify([tab, { ...tab, sessionId: S2 }, { mode: 'browser', url: 'https://example.com/', title: 'B', fixedTitle: false }]),
    )
    const service = start()
    const init = service.init()
    service.dispose()
    await init
    expect(wake).not.toHaveBeenCalled()
    terminalList = []
    terminalEvents.fire('changed', terminalList)
    // The tabs of the last run are still there for the next start.
    expect(await readSaved()).toHaveLength(3)
  })

  it('keeps a waiting tab in the file as the last run had it', async () => {
    await writeFile(
      file,
      JSON.stringify([
        {
          id: 'old',
          accountId: 'acc-a',
          authAccountId: 'acc-b',
          cwd: dir,
          mode: 'session',
          sessionId: S1,
          title: 'Fix',
          fixedTitle: false,
          args: ['--model', 'opus'],
        },
      ]),
    )
    await start().init()
    terminalEvents.fire('changed', terminalList)
    expect(await readSaved()).toEqual([
      {
        id: 'new-1',
        accountId: 'acc-a',
        authAccountId: 'acc-b',
        cwd: dir,
        mode: 'session',
        sessionId: S1,
        title: 'Fix',
        fixedTitle: false,
        muted: false,
        args: ['--model', 'opus'],
      },
    ])
  })
})
