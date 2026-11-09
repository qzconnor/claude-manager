import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserOpenOptions, PaneNode, PaneSplit, TerminalCreateOptions, TerminalInfo } from '@shared/types'

// terminal-service (for the default title) pulls in modules that import electron.
vi.mock('electron', () => ({ app: { getPath: () => tmpdir(), isPackaged: false } }))

import { projectKey } from '../lib/session-files'
import type { AccountService } from './account-service'
import type { SettingsService } from './settings-service'
import { TerminalRestore } from './terminal-restore'
import type { TerminalService } from './terminal-service'

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
const terminalEvents = new Emitter()
const settingsEvents = new Emitter()
const create = vi.fn<(options: TerminalCreateOptions) => TerminalInfo>()
const arrange = vi.fn<(layout: PaneNode) => void>()
const openBrowser = vi.fn<(options: BrowserOpenOptions) => TerminalInfo>()

const terminals = {
  on: (event: string, listener: Listener) => terminalEvents.on(event, listener),
  list: () => terminalList,
  layouts: () => layoutList,
  create,
  arrange,
  openBrowser,
} as unknown as TerminalService

const accounts = {
  list: () => [
    { id: 'acc-a', name: 'Alpha' },
    { id: 'acc-b', name: 'Beta' },
  ],
  paths: () => ({ projectsDir: join(configDir, 'projects') }),
} as unknown as AccountService

const settings = {
  get: () => ({ general: { restoreTerminals } }),
  on: (event: string, listener: Listener) => settingsEvents.on(event, listener),
} as unknown as SettingsService

function info(overrides: Partial<TerminalInfo>): TerminalInfo {
  return {
    id: 't',
    accountId: 'acc-a',
    authAccountId: 'acc-a',
    sessionId: null,
    limit: null,
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
  arrange.mockReset()
  openBrowser.mockReset()
  openBrowser.mockImplementation((options) => info({ id: `browser-${openBrowser.mock.calls.length}`, mode: 'browser', url: options.url ?? null }))
  create.mockReset()
  create.mockImplementation((options) => info({ id: `new-${create.mock.calls.length}`, cwd: options.cwd ?? '' }))
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

describe('TerminalRestore on start', () => {
  it('opens the saved tabs again', async () => {
    const project = join(dir, 'project')
    const other = join(dir, 'other')
    await writeTranscript(S1, project)
    await writeFile(
      file,
      JSON.stringify([
        // Default title of an older version without fixedTitle: follows the session again.
        { accountId: 'acc-a', authAccountId: 'acc-a', cwd: project, mode: 'session', sessionId: S1, title: 'Alpha · project' },
        // The lending account is gone; no transcript was written; a chosen title of an older version.
        { accountId: 'acc-b', authAccountId: 'gone', cwd: other, mode: 'session', sessionId: S2, title: 'Custom', muted: true },
        { accountId: 'acc-a', authAccountId: 'acc-b', cwd: project, mode: 'session', sessionId: null, title: 'Mine', fixedTitle: false },
        { accountId: 'acc-a', authAccountId: 'acc-a', cwd: other, mode: 'shell', sessionId: null, title: 'Build', fixedTitle: true },
      ]),
    )
    await start().init()
    expect(create.mock.calls.map(([options]) => options)).toEqual([
      { accountId: 'acc-a', authAccountId: 'acc-a', cwd: project, mode: 'session', resumeSessionId: S1, title: null, muted: false },
      { accountId: 'acc-b', authAccountId: 'acc-b', cwd: other, mode: 'session', resumeSessionId: null, title: 'Custom', muted: true },
      { accountId: 'acc-a', authAccountId: 'acc-b', cwd: project, mode: 'session', resumeSessionId: null, title: null, muted: false },
      { accountId: 'acc-a', authAccountId: 'acc-a', cwd: other, mode: 'shell', resumeSessionId: null, title: 'Build', muted: false },
    ])
  })

  it('resumes a session /cd moved after the tab was saved in its new folder', async () => {
    const project = join(dir, 'project')
    const moved = join(dir, 'moved')
    // Claude Code took the transcript along into the project folder of the new folder.
    await mkdir(join(configDir, 'projects', projectKey(project)), { recursive: true })
    const folder = join(configDir, 'projects', projectKey(moved))
    await mkdir(folder, { recursive: true })
    await writeFile(join(folder, `${S1}.jsonl`), `${JSON.stringify({ type: 'relocated', sessionId: S1, relocatedCwd: moved })}\n`)
    await writeFile(file, JSON.stringify([{ accountId: 'acc-a', authAccountId: 'acc-a', cwd: project, mode: 'session', sessionId: S1, title: 'T', fixedTitle: false }]))
    await start().init()
    expect(create.mock.calls[0]![0]).toMatchObject({ cwd: moved, resumeSessionId: S1 })
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
        { ...valid, title: 'kept' },
      ]),
    )
    await start().init()
    expect(create).toHaveBeenCalledOnce()
    expect(create.mock.calls[0][0].title).toBe('kept')
  })

  it('goes on with the next tab when one cannot be opened', async () => {
    const tab = { accountId: 'acc-a', authAccountId: 'acc-a', cwd: dir, mode: 'shell', sessionId: null, fixedTitle: true }
    await writeFile(file, JSON.stringify([{ ...tab, title: 'first' }, { ...tab, title: 'second' }]))
    create.mockImplementationOnce(() => {
      throw new Error('folder missing')
    })
    await start().init()
    expect(create.mock.calls.map(([options]) => options.title)).toEqual(['first', 'second'])
  })

  it('puts the terminals of a split tab together again, without those that did not open', async () => {
    const tab = { accountId: 'acc-a', authAccountId: 'acc-a', cwd: dir, mode: 'shell', sessionId: null, fixedTitle: false }
    const split = (first: PaneNode, second: PaneNode, direction: 'row' | 'column' = 'row') => ({ direction, ratio: 0.3, first, second })
    await writeFile(
      file,
      JSON.stringify([
        { ...tab, title: 'a', layout: split('0', split('1', '2', 'column')) },
        { ...tab, title: 'b' },
        { ...tab, title: 'c' },
        { ...tab, title: 'alone' },
        // Broken: refers to itself twice.
        { ...tab, title: 'd', layout: split('4', '4') },
        { ...tab, title: 'e' },
        { ...tab, title: 'f', layout: split('6', '7') },
        { ...tab, title: 'g' },
      ]),
    )
    // The terminals of b and g fail to open.
    create.mockImplementation(() => {
      const n = create.mock.calls.length
      if (n === 2 || n === 8) throw new Error('folder missing')
      return info({ id: `new-${n}` })
    })
    await start().init()
    expect(arrange.mock.calls).toEqual([[split('new-1', 'new-3')]])
  })

  it('opens browsers again at their page, next to the terminals they shared a tab with', async () => {
    const tab = { accountId: 'acc-a', authAccountId: 'acc-a', cwd: dir, mode: 'shell', sessionId: null, title: 's', fixedTitle: false }
    await writeFile(
      file,
      JSON.stringify([
        { ...tab, layout: { direction: 'row', ratio: 0.4, first: '0', second: '1' } },
        { mode: 'browser', url: 'http://localhost:5173/', title: 'Vite App', fixedTitle: false },
        { mode: 'browser', url: 'https://example.com/', title: 'Docs', fixedTitle: true },
        // Not a page the browser may show: left out.
        { mode: 'browser', url: 'file:///C:/Windows/win.ini', title: 'x', fixedTitle: false },
      ]),
    )
    await start().init()
    expect(openBrowser.mock.calls).toEqual([[{ url: 'http://localhost:5173/', title: null }], [{ url: 'https://example.com/', title: 'Docs' }]])
    expect(arrange.mock.calls).toEqual([[{ direction: 'row', ratio: 0.4, first: 'new-1', second: 'browser-1' }]])
  })

  it('opens nothing for a file that is no list', async () => {
    await writeFile(file, JSON.stringify({ accountId: 'acc-a' }))
    await start().init()
    expect(create).not.toHaveBeenCalled()
  })

  it('opens nothing and forgets the tabs when restoring is off', async () => {
    restoreTerminals = false
    await writeFile(file, JSON.stringify([{ accountId: 'acc-a', authAccountId: 'acc-a', cwd: dir, mode: 'shell', sessionId: null, title: 'T' }]))
    await start().init()
    expect(create).not.toHaveBeenCalled()
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
    expect(saved[1]).toEqual({ mode: 'browser', url: 'https://example.com/a', title: 'Example', fixedTitle: false })
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

  it('does not start following when disposed while restoring', async () => {
    await writeFile(file, JSON.stringify([{ accountId: 'acc-a', authAccountId: 'acc-a', cwd: dir, mode: 'session', sessionId: S1, title: 'T' }]))
    const service = start()
    const init = service.init()
    service.dispose()
    await init
    expect(create).toHaveBeenCalledOnce()
    terminalList = []
    terminalEvents.fire('changed', terminalList)
    // The tabs of the last run are still there for the next start.
    expect(await readSaved()).toHaveLength(1)
  })
})
