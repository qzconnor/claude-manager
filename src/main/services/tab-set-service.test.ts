import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserOpenOptions, PaneNode, PaneSplit, TabSetTab, TerminalCreateOptions, TerminalInfo } from '@shared/types'

// terminal-restore (for folderState) pulls in modules that import electron.
vi.mock('electron', () => ({ app: { getPath: () => tmpdir(), isPackaged: false } }))

import { projectKey } from '../lib/session-files'
import type { AccountService } from './account-service'
import { TabSetService } from './tab-set-service'
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

  count(event: string): number {
    return this.listeners.get(event)?.size ?? 0
  }
}

let dir: string
let configDir: string
let project: string
let file: string
let terminalList: TerminalInfo[]
const terminalEvents = new Emitter()
const create = vi.fn<(options: TerminalCreateOptions) => TerminalInfo>()
const open = vi.fn<(options: TerminalCreateOptions) => Promise<TerminalInfo | null>>()
const openBrowser = vi.fn<(options: BrowserOpenOptions) => TerminalInfo>()
const arrange = vi.fn<(layout: PaneNode) => void>()
const write = vi.fn<(id: string, data: string) => void>()

const terminals = {
  on: (event: string, listener: Listener) => terminalEvents.on(event, listener),
  create,
  open,
  openBrowser,
  arrange,
  write,
  runningSession: (accountId: string, sessionId: string) =>
    terminalList.find((t) => t.status !== 'exited' && t.mode === 'session' && t.accountId === accountId && t.sessionId === sessionId) ??
    null,
} as unknown as TerminalService

const accounts = {
  list: () => [{ id: 'acc-a' }, { id: 'acc-b' }],
  paths: (id: string) => {
    if (id !== 'acc-a' && id !== 'acc-b') throw new Error('unknown account')
    return { projectsDir: join(configDir, 'projects') }
  },
} as unknown as AccountService

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
    cwd: '',
    mode: 'session',
    url: null,
    resumeSessionId: null,
    args: [],
    status: 'running',
    sleep: null,
    exitCode: null,
    pid: 1,
    createdAt: '2026-11-12T12:00:00.000Z',
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

const row = (first: PaneNode, second: PaneNode, ratio = 0.5): PaneSplit => ({ direction: 'row', ratio, first, second })

const session = (cwd: string, extra: Partial<TabSetTab> = {}): TabSetTab =>
  ({ mode: 'session', accountId: 'acc-a', cwd, title: null, muted: false, args: [], sessionId: null, command: null, ...extra }) as TabSetTab
const shell = (cwd: string, extra: Partial<TabSetTab> = {}): TabSetTab => session(cwd, { mode: 'shell', ...extra } as Partial<TabSetTab>)
const page = (url: string): TabSetTab => ({ mode: 'browser', url, title: null })

async function writeTranscript(sessionId: string, cwd: string): Promise<void> {
  const folder = join(configDir, 'projects', projectKey(cwd))
  await mkdir(folder, { recursive: true })
  await writeFile(join(folder, `${sessionId}.jsonl`), '{}\n')
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'cm-test-'))
  configDir = join(dir, 'config')
  project = join(dir, 'project')
  await mkdir(project)
  file = join(dir, 'tab-sets.json')
  terminalList = []
  let n = 0
  const add = (tab: TerminalInfo): TerminalInfo => {
    terminalList = [...terminalList, tab]
    return tab
  }
  create.mockReset()
  create.mockImplementation((options) => add(info({ id: `new-${++n}`, mode: options.mode ?? 'session', cwd: options.cwd ?? '' })))
  open.mockReset()
  open.mockImplementation(async (options) =>
    add(info({ id: `new-${++n}`, cwd: options.cwd ?? '', sessionId: options.resumeSessionId ?? null })),
  )
  openBrowser.mockReset()
  openBrowser.mockImplementation((options) => add(info({ id: `new-${++n}`, mode: 'browser', url: options.url ?? null })))
  arrange.mockReset()
  write.mockReset()
})

let service: TabSetService | null = null

afterEach(async () => {
  vi.useRealTimers()
  service?.dispose()
  service = null
  await rm(dir, { recursive: true, force: true, maxRetries: 3 })
})

function start(): TabSetService {
  service = new TabSetService(dir, terminals, accounts)
  service.init()
  return service
}

describe('TabSetService sets', () => {
  it('reads the sets of the file and leaves out broken ones and doubles', async () => {
    const good = { id: 'one', name: ' Web ', tabs: [shell(project)], savedAt: '2026-11-12T10:00:00.000Z' }
    await writeFile(
      file,
      JSON.stringify({
        sets: [
          good,
          { ...good, name: 'Again' },
          { id: 'no tabs', name: 'Empty', tabs: [] },
          { id: 'x', name: '', tabs: [shell(project)] },
          null,
        ],
      }),
    )
    expect(start().list()).toEqual([{ ...good, name: 'Web' }])
  })

  it('starts empty without a file', () => {
    expect(start().list()).toEqual([])
  })

  it('saves a new set to the file and tells about it', async () => {
    const sets = start()
    const changed = vi.fn()
    sets.on('changed', changed)
    const saved = await sets.save({ name: '  Web  ', tabs: [shell(project, { command: 'npm run dev' }), page('http://localhost:5173/')] })
    expect(saved).toMatchObject({ name: 'Web', tabs: [{ mode: 'shell', command: 'npm run dev' }, { mode: 'browser' }] })
    expect(saved.id).toMatch(/^[\w-]+$/)
    expect(Date.parse(saved.savedAt)).not.toBeNaN()
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ sets: [saved] })
    expect(changed).toHaveBeenCalledWith([saved])
    expect(sets.list()).toEqual([saved])
  })

  it('replaces a set in its place', async () => {
    const sets = start()
    const a = await sets.save({ name: 'A', tabs: [shell(project)] })
    const b = await sets.save({ name: 'B', tabs: [shell(project)] })
    const renamed = await sets.save({ id: a.id, name: 'C', tabs: [page('https://example.com/')] })
    expect(renamed.id).toBe(a.id)
    expect(sets.list().map((s) => s.name)).toEqual(['C', 'B'])
    expect(sets.list()[1]).toEqual(b)
  })

  it('refuses a set without a name, with a name taken, without valid tabs or of another that is gone', async () => {
    const sets = start()
    const a = await sets.save({ name: 'Web', tabs: [shell(project)] })
    await expect(sets.save({ name: ' ', tabs: [shell(project)] })).rejects.toThrow('Gib dem Tab-Set einen Namen.')
    await expect(sets.save({ name: 'WEB', tabs: [shell(project)] })).rejects.toThrow('Ein Tab-Set „WEB“ gibt es schon.')
    await expect(sets.save({ name: 'Other', tabs: [] })).rejects.toThrow(/braucht Tabs/)
    await expect(sets.save({ id: 'gone', name: 'Other', tabs: [shell(project)] })).rejects.toThrow('Das Tab-Set gibt es nicht mehr.')
    // The same set keeps its name.
    await expect(sets.save({ id: a.id, name: 'web', tabs: [shell(project)] })).resolves.toMatchObject({ name: 'web' })
    expect(sets.list()).toHaveLength(1)
  })

  it('keeps at most 100 sets', async () => {
    const tabs = [shell(project)]
    await writeFile(file, JSON.stringify({ sets: Array.from({ length: 101 }, (_, i) => ({ id: `s${i}`, name: `S${i}`, tabs })) }))
    const sets = start()
    expect(sets.list()).toHaveLength(100)
    await expect(sets.save({ name: 'One more', tabs })).rejects.toThrow('Es gibt schon 100 Tab-Sets.')
    await expect(sets.save({ id: 's0', name: 'Changed', tabs })).resolves.toMatchObject({ id: 's0' })
  })

  it('deletes a set', async () => {
    const sets = start()
    const a = await sets.save({ name: 'A', tabs: [shell(project)] })
    const b = await sets.save({ name: 'B', tabs: [shell(project)] })
    await sets.remove(a.id)
    await sets.remove('gone')
    expect(sets.list()).toEqual([b])
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ sets: [b] })
  })
})

describe('TabSetService.open', () => {
  it('opens sessions, shells and browsers in their order, split tabs as they were', async () => {
    const sets = start()
    const set = await sets.save({
      name: 'Web',
      tabs: [
        session(project, { title: 'Claude', muted: true, args: ['--model', 'opus'], layout: row('0', '2', 0.6) }),
        page('http://localhost:5173/'),
        shell(project),
      ],
    })
    const result = await sets.open(set.id)
    expect(result).toEqual({ firstId: 'new-1', failed: [] })
    expect(open).toHaveBeenCalledWith({
      accountId: 'acc-a',
      cwd: project,
      title: 'Claude',
      muted: true,
      mode: 'session',
      resumeSessionId: null,
      args: ['--model', 'opus'],
    })
    expect(openBrowser).toHaveBeenCalledWith({ url: 'http://localhost:5173/', title: null })
    expect(create).toHaveBeenCalledWith({ accountId: 'acc-a', cwd: project, title: null, muted: false, mode: 'shell' })
    expect(arrange).toHaveBeenCalledExactlyOnceWith(row('new-1', 'new-3', 0.6))
  })

  it('goes on with the session in the folder it is in now, else starts a new one', async () => {
    const moved = join(dir, 'moved')
    await mkdir(moved)
    // `/cd` took the session along into the project folder of its new folder.
    await writeTranscript(S1, moved)
    const transcript = join(configDir, 'projects', projectKey(moved), `${S1}.jsonl`)
    await writeFile(transcript, `${JSON.stringify({ type: 'relocated', relocatedCwd: moved })}\n`)
    const sets = start()
    const set = await sets.save({ name: 'S', tabs: [session(project, { sessionId: S1 }), session(project, { sessionId: S2 })] })
    await sets.open(set.id)
    expect(open.mock.calls.map(([o]) => [o.resumeSessionId, o.cwd])).toEqual([
      [S1, moved],
      [null, project],
    ])
  })

  it('goes on with a session that has a transcript', async () => {
    await writeTranscript(S1, project)
    const sets = start()
    const set = await sets.save({ name: 'S', tabs: [session(project, { sessionId: S1 })] })
    await sets.open(set.id)
    expect(open).toHaveBeenCalledWith(expect.objectContaining({ resumeSessionId: S1, cwd: project }))
  })

  it('shows the tab of a session that runs or waits already, and leaves it where it is', async () => {
    await writeTranscript(S1, project)
    terminalList = [info({ id: 'running', sessionId: S1, status: 'asleep' })]
    const sets = start()
    const set = await sets.save({ name: 'S', tabs: [session(project, { sessionId: S1, layout: row('0', '1') }), shell(project)] })
    const result = await sets.open(set.id)
    expect(result).toEqual({ firstId: 'running', failed: [] })
    expect(open).not.toHaveBeenCalled()
    expect(create).toHaveBeenCalledOnce()
    expect(arrange).not.toHaveBeenCalled()
  })

  it('opens the others when a folder or account is gone, or a start fails or is declined', async () => {
    const gone = join(dir, 'gone')
    open.mockResolvedValueOnce(null)
    create.mockImplementationOnce(() => {
      throw new Error('Die Shell startet nicht.')
    })
    const sets = start()
    const set = await sets.save({
      name: 'S',
      tabs: [
        shell(gone, { title: 'Weg', layout: row('0', row('1', '4')) }),
        shell(project, { accountId: 'acc-gone' }),
        session(project),
        shell(project),
        shell(project),
      ],
    })
    const result = await sets.open(set.id)
    expect(result).toEqual({
      firstId: 'new-1',
      failed: [
        { title: 'Weg', reason: `Den Ordner „${gone}“ gibt es nicht.` },
        { title: 'Shell · project', reason: 'Den Account dieses Tabs gibt es nicht mehr.' },
        { title: 'Session · project', reason: 'Nicht gestartet, abgebrochen.' },
        { title: 'Shell · project', reason: 'Die Shell startet nicht.' },
      ],
    })
    // The tab that opened is a tab of its own: the others of its split tab didn't open.
    expect(arrange).not.toHaveBeenCalled()
  })

  it('gives the space of a part that did not open to the others', async () => {
    const sets = start()
    const set = await sets.save({
      name: 'S',
      tabs: [shell(project, { layout: row('0', row('1', '2', 0.3), 0.7) }), shell(join(dir, 'gone')), shell(project)],
    })
    await sets.open(set.id)
    expect(arrange).toHaveBeenCalledExactlyOnceWith(row('new-1', 'new-2', 0.7))
  })

  it('opens a set once while it opens', async () => {
    const sets = start()
    const set = await sets.save({ name: 'S', tabs: [shell(project)] })
    const [first, second] = await Promise.all([sets.open(set.id), sets.open(set.id)])
    expect(first.firstId).toBe('new-1')
    expect(second).toEqual({ firstId: null, failed: [] })
    expect(create).toHaveBeenCalledOnce()
    await sets.open(set.id)
    expect(create).toHaveBeenCalledTimes(2)
  })

  it('refuses a set that is gone', async () => {
    await expect(start().open('gone')).rejects.toThrow('Das Tab-Set gibt es nicht mehr.')
  })
})

describe('TabSetService start commands', () => {
  async function openShell(command: string | null): Promise<TabSetService> {
    const sets = start()
    const set = await sets.save({ name: 'S', tabs: [shell(project, { command })] })
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    await sets.open(set.id)
    return sets
  }

  it('types the command once the shell was quiet after its first output', async () => {
    await openShell('npm run dev')
    vi.advanceTimersByTime(1000)
    expect(write).not.toHaveBeenCalled()
    terminalEvents.fire('data', 'other', 'PS> ', 0)
    vi.advanceTimersByTime(1000)
    expect(write).not.toHaveBeenCalled()
    terminalEvents.fire('data', 'new-1', 'PowerShell 7', 0)
    vi.advanceTimersByTime(200)
    terminalEvents.fire('data', 'new-1', 'PS> ', 12)
    vi.advanceTimersByTime(299)
    expect(write).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(write).toHaveBeenCalledExactlyOnceWith('new-1', 'npm run dev\r')
    terminalEvents.fire('data', 'new-1', 'more', 16)
    vi.advanceTimersByTime(20_000)
    expect(write).toHaveBeenCalledOnce()
    expect(terminalEvents.count('data')).toBe(0)
  })

  it('types it after a while when the shell says nothing', async () => {
    await openShell('npm run dev')
    vi.advanceTimersByTime(9999)
    expect(write).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(write).toHaveBeenCalledExactlyOnceWith('new-1', 'npm run dev\r')
  })

  it('gives up when the shell ends first, or the app quits', async () => {
    const sets = await openShell('npm run dev')
    terminalEvents.fire('exit', 'other', 0)
    terminalEvents.fire('exit', 'new-1', 1)
    vi.advanceTimersByTime(20_000)
    expect(write).not.toHaveBeenCalled()
    expect(terminalEvents.count('data') + terminalEvents.count('exit')).toBe(0)
    const set = await sets.save({ name: 'T', tabs: [shell(project, { command: 'npm test' })] })
    await sets.open(set.id)
    sets.dispose()
    vi.advanceTimersByTime(20_000)
    expect(write).not.toHaveBeenCalled()
  })

  it('types nothing into a shell without command', async () => {
    await openShell(null)
    vi.advanceTimersByTime(20_000)
    expect(write).not.toHaveBeenCalled()
    expect(terminalEvents.count('data')).toBe(0)
  })
})
