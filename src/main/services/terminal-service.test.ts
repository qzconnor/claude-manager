import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { MAX_SPLIT_DEPTH, paneIds, splitDepth } from '@shared/panes'
import type { TerminalInfo } from '@shared/types'
import type { HookEvent } from '../lib/hook-events'
import { projectKey } from '../lib/session-files'
import type { AccountService } from './account-service'
import type { ClaudeCli } from './claude-cli'
import type { SettingsService } from './settings-service'
import {
  currentWorktree,
  defaultTerminalTitle,
  hasSecret,
  movedTo,
  type SleepingTerminal,
  TerminalService,
  type TurnEnd,
} from './terminal-service'
import type { WorkspaceTrust } from './workspace-trust'

vi.mock('electron', () => ({ app: { getPath: () => '' } }))

/** A process in a pseudo terminal, without one: the tests write its output and end it. */
class FakePty {
  readonly pid: number
  cols: number
  rows: number
  private dataListener: (data: string) => void = () => {}
  private exitListener: (event: { exitCode: number }) => void = () => {}

  constructor(pid: number, options: { cols: number; rows: number }) {
    this.pid = pid
    this.cols = options.cols
    this.rows = options.rows
  }

  onData(listener: (data: string) => void) {
    this.dataListener = listener
    return { dispose: () => {} }
  }

  onExit(listener: (event: { exitCode: number }) => void) {
    this.exitListener = listener
    return { dispose: () => {} }
  }

  write(): void {}

  resize(cols: number, rows: number): void {
    this.cols = cols
    this.rows = rows
  }

  kill(): void {}

  /** The program writes `data` to the terminal. */
  output(data: string): void {
    this.dataListener(data)
  }

  exit(exitCode: number): void {
    this.exitListener({ exitCode })
  }
}

const ptys: FakePty[] = []
let nextPid = 40_000
// The service loads node-pty with `require` on its first terminal, which `vi.mock` doesn't reach: the
// fake goes into Node's module cache under node-pty's own path, so no real shell or Claude Code starts.
const nodeRequire = createRequire(import.meta.url)
const ptyPath = nodeRequire.resolve('node-pty')
nodeRequire.cache[ptyPath] = {
  id: ptyPath,
  filename: ptyPath,
  loaded: true,
  exports: {
    spawn: (_file: string, _args: unknown, options: { cols: number; rows: number }) => {
      const pty = new FakePty(nextPid++, options)
      ptys.push(pty)
      return pty
    },
  },
} as unknown as NodeJS.Module
afterAll(() => {
  delete nodeRequire.cache[ptyPath]
})

/** Where the account keeps the files a session's tab reads (its live session, transcripts, settings). */
interface AccountDirs {
  sessionsDir: string
  projectsDir: string
  configDir: string
}

/**
 * A service whose terminals start a `FakePty` in `cwd`. Without `dirs` the account has no files: the
 * tab finds no transcript, and a session's turn can end only by its title, its hooks or the timeout.
 */
function serviceWithPty(cwd: string, dirs: AccountDirs | null = null): TerminalService {
  const account = { id: 'a', name: 'A', defaultCwd: cwd, extraArgs: [] }
  const accounts = {
    get: () => account,
    launchEnv: () => ({ set: {}, unset: [] }),
    paths: () => {
      if (!dirs) throw new Error('Konto ohne Dateien')
      return dirs
    },
  }
  const settings = {
    get: () => ({
      claude: { defaultArgs: [], defaultCwd: null, hideSecretsFromCommands: false },
      terminal: { modernConpty: false },
      general: { closeOnExit: 'never' },
    }),
  }
  const cli = { baseEnv: () => ({}), command: (args: string[]) => ({ file: 'claude', args, display: 'claude' }) }
  return new TerminalService(accounts as unknown as AccountService, cli as unknown as ClaudeCli, settings as unknown as SettingsService, {} as WorkspaceTrust)
}

/** The process of the terminal started last. */
const lastPty = (): FakePty => ptys[ptys.length - 1]!

/** Window titles Claude Code sets (OSC 0): a spinner in front while it works, `✳` while it waits. */
const BUSY = '\x1b]0;◐ Claude Code\x07'
const IDLE = '\x1b]0;✳ Claude Code\x07'

/** Listens to `turnEnded`. */
type TurnListener = (id: string, turn: TurnEnd) => void

/** Long output in short: each run of one character with its length, e.g. `a×3 b×2`. */
const runs = (text: string): string => (text.match(/(.)\1*/gs) ?? []).map((run) => `${run[0]}×${run.length}`).join(' ')

let service: TerminalService

beforeEach(() => {
  service = new TerminalService({} as AccountService, {} as ClaudeCli, {} as SettingsService, {} as WorkspaceTrust)
})

afterEach(() => service.disposeAll())

// A browser tab needs no process; its page title stands for the session's title of a terminal.
describe('own tab name', () => {
  const page = (title: string) => ({ url: 'https://example.com/', title })
  const titles = (id: string) => {
    const { title, fixedTitle, autoTitle } = service.get(id)
    return { title, fixedTitle, autoTitle }
  }

  it('keeps the automatic title next to the name it was given', () => {
    const { id } = service.openBrowser({ url: 'https://example.com/' })
    service.setBrowserPage(id, page('Example'))
    expect(titles(id)).toEqual({ title: 'Example', fixedTitle: false, autoTitle: 'Example' })

    service.rename(id, '  Docs  ')
    expect(titles(id)).toEqual({ title: 'Docs', fixedTitle: true, autoTitle: 'Example' })

    service.setBrowserPage(id, page('Other page'))
    expect(titles(id)).toEqual({ title: 'Docs', fixedTitle: true, autoTitle: 'Other page' })
  })

  it('follows the automatic title again without a name', () => {
    const { id } = service.openBrowser({ url: 'https://example.com/', title: 'Docs' })
    service.setBrowserPage(id, page('Example'))
    service.rename(id, ' ')
    expect(titles(id)).toEqual({ title: 'Example', fixedTitle: false, autoTitle: 'Example' })
  })

  it('reports a new automatic title also while the tab has a name', () => {
    const { id } = service.openBrowser({ url: 'https://example.com/', title: 'Docs' })
    const changed = vi.fn()
    service.on('changed', changed)
    service.setBrowserPage(id, page('Example'))
    service.setBrowserPage(id, page('Example'))
    expect(changed).toHaveBeenCalledTimes(1)
  })
})

describe('how a tab at a limit goes on', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('keeps what AutoSwitch tells and reports it once, shortly after', async () => {
    vi.useFakeTimers()
    const { id } = service.openBrowser({ url: 'https://example.com/' })
    const changed = vi.fn()
    service.on('changed', changed)
    const resume = { byUser: true, at: '2026-11-12T13:01:00.000Z' }
    service.setResume(id, resume)
    expect(service.get(id).resume).toEqual(resume)
    // AutoSwitch decides while it hears of changes: not while it does.
    expect(changed).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(200)
    expect(changed).toHaveBeenCalledTimes(1)
    // The same again: nothing to tell.
    service.setResume(id, { ...resume })
    await vi.advanceTimersByTimeAsync(200)
    expect(changed).toHaveBeenCalledTimes(1)
    service.setResume(id, null)
    await vi.advanceTimersByTimeAsync(200)
    expect(changed).toHaveBeenCalledTimes(2)
    expect(service.get(id).resume).toBeNull()
    // A tab that is gone: nothing.
    service.setResume('weg', resume)
    await vi.advanceTimersByTimeAsync(200)
    expect(changed).toHaveBeenCalledTimes(2)
  })
})

// Claude Code names the folder of the session in `sessions/<pid>.json`; `/cd` changes it.
describe('following /cd', () => {
  const APP = 'C:\\dev\\app'
  const WORKTREE = 'C:\\dev\\app\\.claude\\worktrees\\login-fix'

  it('moves the tab when the session moves to another folder', () => {
    expect(movedTo(APP, 'D:\\other', APP)).toBe('D:\\other')
    expect(movedTo(APP, 'C:\\dev\\app\\src', APP)).toBe('C:\\dev\\app\\src')
    expect(movedTo('/home/dev/app', '/home/dev/site', '/home/dev/app')).toBe('/home/dev/site')
  })

  it('takes the first report as the start, also spelled differently', () => {
    expect(movedTo(null, 'c:/dev/app/', APP)).toBeNull()
    expect(movedTo(null, 'D:\\other', APP)).toBeNull()
    expect(movedTo('c:/dev/app/', APP, APP)).toBeNull()
  })

  it('stays with a worktree of its folder and when coming back', () => {
    expect(movedTo(APP, WORKTREE, APP)).toBeNull()
    expect(movedTo(WORKTREE, APP, APP)).toBeNull()
    expect(movedTo(APP, WORKTREE, 'C:\\dev\\app\\src')).toBeNull()
    // A worktree of another repository is a folder like any other.
    expect(movedTo(APP, 'D:\\site\\.claude\\worktrees\\demo', APP)).toBe('D:\\site\\.claude\\worktrees\\demo')
  })

  it('leaves out the worktree once the session left it', () => {
    const scanned = { name: 'login-fix', branch: 'login-fix', path: WORKTREE, originalCwd: APP }
    expect(currentWorktree(scanned, WORKTREE, APP, null)).toBe(scanned)
    expect(currentWorktree(scanned, 'D:\\other', 'D:\\other', scanned)).toBeNull()
    expect(currentWorktree(scanned, APP, APP, scanned)).toBeNull()
    // Before the transcript names it, the folder tells it.
    expect(currentWorktree(undefined, WORKTREE, APP, null)).toEqual({ name: 'login-fix', branch: null, path: WORKTREE, originalCwd: APP })
    expect(currentWorktree(scanned, null, APP, null)).toBe(scanned)
  })
})

describe('a start that fails', () => {
  it('gives back what the session got from the providers (token, config files)', () => {
    const account = { id: 'a', name: 'A', defaultCwd: tmpdir(), extraArgs: [] }
    const accounts = {
      get: () => account,
      launchEnv: () => {
        throw new Error('Schlüsselbund gesperrt')
      },
    }
    const settings = { get: () => ({ claude: { defaultArgs: [], defaultCwd: null } }) }
    const cli = { baseEnv: () => ({}) }
    const own = new TerminalService(accounts as unknown as AccountService, cli as unknown as ClaudeCli, settings as unknown as SettingsService, {} as WorkspaceTrust)
    const release = vi.fn()
    own.addSessionArgs({ args: () => ['--mcp-config', 'x.json'], release })
    expect(() => own.create({ accountId: 'a' })).toThrow('Schlüsselbund gesperrt')
    expect(release).toHaveBeenCalledOnce()
    expect(own.list()).toEqual([])
  })
})

describe('resuming a session that is open elsewhere', () => {
  const SESSION = '11111111-2222-4333-8444-555555555555'
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'cm-resume-'))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  function serviceWith(answer: boolean) {
    const ask = vi.fn(async () => answer)
    const ensure = vi.fn(async () => null)
    const accounts = { paths: () => ({ sessionsDir: dir }), get: () => ({ id: 'a', defaultCwd: dir }) }
    const settings = { get: () => ({ claude: { defaultCwd: null } }) }
    const trust = { ask, ensure }
    const own = new TerminalService(accounts as unknown as AccountService, {} as ClaudeCli, settings as unknown as SettingsService, trust as unknown as WorkspaceTrust)
    return { own, ask, ensure }
  }

  it('asks before resuming a session a running Claude Code has open, and stops on no', async () => {
    // This test's own process stands for the Claude Code that has the session open.
    await writeFile(join(dir, `${process.pid}.json`), JSON.stringify({ pid: process.pid, sessionId: SESSION }))
    const { own, ask, ensure } = serviceWith(false)
    expect(await own.open({ accountId: 'a', resumeSessionId: SESSION })).toBeNull()
    expect(ask).toHaveBeenCalledOnce()
    expect(ensure).not.toHaveBeenCalled()

    const yes = serviceWith(true)
    await yes.own.open({ accountId: 'a', resumeSessionId: SESSION })
    expect(yes.ensure).toHaveBeenCalledOnce()
  })

  it('asks nothing for a fork or a session nobody has open', async () => {
    await writeFile(join(dir, `${process.pid}.json`), JSON.stringify({ pid: process.pid, sessionId: SESSION }))
    const { own, ask, ensure } = serviceWith(false)
    await own.open({ accountId: 'a', resumeSessionId: SESSION, forkSession: true })
    await own.open({ accountId: 'a', resumeSessionId: '99999999-2222-4333-8444-555555555555' })
    expect(ask).not.toHaveBeenCalled()
    expect(ensure).toHaveBeenCalledTimes(2)
  })
})

// A tab of the last run waits without a process until the window shows it (see TerminalRestore).
describe('a tab that waits to start', () => {
  const SESSION = '11111111-2222-4333-8444-555555555555'
  const waiting = (overrides: Partial<SleepingTerminal> = {}): SleepingTerminal => ({
    accountId: 'a',
    authAccountId: 'a',
    cwd: tmpdir(),
    mode: 'session',
    sessionId: SESSION,
    title: 'Fix the build',
    fixedTitle: false,
    muted: true,
    args: ['--model', 'opus'],
    restoredFrom: 'old',
    ...overrides,
  })

  it('starts in its place once woken: same id, same place in the order and in its split', () => {
    const own = serviceWithPty(tmpdir())
    const before = own.create({ accountId: 'a', mode: 'shell' })
    const tab = own.sleep(waiting())
    const after = own.create({ accountId: 'a', mode: 'shell' })
    own.arrange({ direction: 'row', ratio: 0.5, first: tab.id, second: after.id })
    const started = ptys.length
    expect(tab).toMatchObject({
      status: 'asleep',
      sleep: { waking: false, error: null },
      pid: 0,
      title: 'Fix the build',
      autoTitle: 'Fix the build',
      fixedTitle: false,
      muted: true,
      sessionId: SESSION,
      resumeSessionId: SESSION,
      args: ['--model', 'opus'],
      restoredFrom: 'old',
    })
    // Nothing runs that could take input or a size.
    own.write(tab.id, 'x')
    own.resize(tab.id, 100, 30)
    expect(ptys.length).toBe(started)

    own.setSleep(tab.id, { waking: true, error: null })
    expect(own.get(tab.id).sleep).toEqual({ waking: true, error: null })
    const options = { accountId: 'a', cwd: tmpdir(), resumeSessionId: SESSION, args: ['--model', 'opus'], muted: true, restoredFrom: 'old' }
    const woken = own.wake(tab.id, options)
    expect(ptys.length).toBe(started + 1)
    // Its session's title stays until the transcript tells it again.
    expect(woken).toMatchObject({
      id: tab.id,
      status: 'running',
      sleep: null,
      title: 'Fix the build',
      autoTitle: 'Fix the build',
      sessionId: SESSION,
    })
    expect(own.list().map((t) => t.id)).toEqual([before.id, tab.id, after.id])
    expect(own.layouts()).toEqual([{ direction: 'row', ratio: 0.5, first: tab.id, second: after.id }])

    // Running, it neither starts again nor takes a reason to wait.
    expect(() => own.wake(tab.id, options)).toThrow('Der Tab läuft schon.')
    own.setSleep(tab.id, { waking: false, error: 'x' })
    expect(own.get(tab.id).sleep).toBeNull()
    expect(ptys.length).toBe(started + 1)
  })

  it('tells only a change of how it waits', () => {
    const own = serviceWithPty(tmpdir())
    const { id } = own.sleep(waiting())
    const changed = vi.fn()
    own.on('changed', changed)
    own.setSleep(id, { waking: false, error: null })
    expect(changed).not.toHaveBeenCalled()
    own.setSleep(id, { waking: false, error: 'Den Ordner gibt es nicht.' })
    own.setSleep(id, { waking: false, error: 'Den Ordner gibt es nicht.' })
    expect(changed).toHaveBeenCalledOnce()
    expect(own.get(id).sleep).toEqual({ waking: false, error: 'Den Ordner gibt es nicht.' })
  })

  it('shows the default title without one, and a name it was given', () => {
    const own = serviceWithPty(tmpdir())
    const shell = defaultTerminalTitle('shell', 'A', tmpdir())
    const titles = (info: TerminalInfo) => [info.title, info.autoTitle, info.fixedTitle]
    expect(titles(own.sleep(waiting({ mode: 'shell', sessionId: null, title: null })))).toEqual([shell, shell, false])
    const named = own.sleep(waiting({ mode: 'shell', sessionId: null, title: '  Build ', fixedTitle: true }))
    expect(titles(named)).toEqual(['Build', shell, true])
    expect(titles(own.sleep(waiting({ mode: 'shell', sessionId: null, title: null, fixedTitle: true })))).toEqual([shell, shell, false])
  })

  it('is the tab of its session until one runs it, so the session isn’t resumed twice', () => {
    const own = serviceWithPty(tmpdir())
    const tab = own.sleep(waiting())
    expect(own.runningSession('a', SESSION)?.id).toBe(tab.id)
    const running = own.create({ accountId: 'a', resumeSessionId: SESSION })
    expect(own.runningSession('a', SESSION)?.id).toBe(running.id)
    expect(own.runningSession('b', SESSION)).toBeNull()
  })
})

describe('hasSecret', () => {
  it('knows the environment of a token or API key account', () => {
    expect(hasSecret({ CLAUDE_CONFIG_DIR: 'x', CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-x' })).toBe(true)
    expect(hasSecret({ ANTHROPIC_API_KEY: 'sk-ant-api03-x' })).toBe(true)
    expect(hasSecret({ CLAUDE_CONFIG_DIR: 'x' })).toBe(false)
  })
})

// Deeper trees are refused, also from the file of the last run: the tab would come back torn apart.
describe('splitting a part as often as a tab can be', () => {
  it('gives the new terminal a tab of its own beside it', () => {
    let last = service.openBrowser({ url: 'https://example.com/' }).id
    const first = last
    for (let i = 0; i < MAX_SPLIT_DEPTH; i++) {
      last = service.openBrowser({ url: 'https://example.com/', split: { terminalId: last, direction: i % 2 ? 'column' : 'row' } }).id
    }
    const [tab] = service.layouts()
    expect(splitDepth(tab)).toBe(MAX_SPLIT_DEPTH)
    const extra = service.openBrowser({ url: 'https://example.com/', split: { terminalId: last, direction: 'row' } }).id
    expect(service.layouts()).toEqual([tab])
    expect(paneIds(tab)).not.toContain(extra)
    expect(paneIds(tab)[0]).toBe(first)
    // Beside the part it was opened from.
    const order = service.list().map((t) => t.id)
    expect(order.indexOf(extra)).toBe(order.indexOf(last) + 1)
  })
})

// Until the first prompt a session has no transcript; the tab looks for it every round.
describe('looking for a tab’s transcript', () => {
  type Finder = { findTabTranscript(projectsDir: string, record: object, sessionId: string): Promise<string | null> }
  const SESSION = '3f2b8c1e-9a4d-4e7b-8c2a-1d5e6f7a8b9c'
  let projects: string

  beforeEach(async () => {
    projects = await mkdtemp(join(tmpdir(), 'cm-projects-'))
  })
  afterEach(async () => {
    vi.useRealTimers()
    await rm(projects, { recursive: true, force: true })
  })

  it('looks in all projects only now and then, in its own folders every time', async () => {
    vi.useFakeTimers({ now: 1_000_000, toFake: ['Date'] })
    const finder = service as unknown as Finder
    const record = { liveCwd: null, folders: ['/home/dev/app'], searchedEverywhereAt: 0 }
    const elsewhere = join(projects, 'renamed')
    await mkdir(elsewhere)
    // Not there yet: one search everywhere.
    expect(await finder.findTabTranscript(projects, record, SESSION)).toBeNull()
    await writeFile(join(elsewhere, `${SESSION}.jsonl`), '')
    vi.setSystemTime(1_000_000 + 2000)
    expect(await finder.findTabTranscript(projects, record, SESSION)).toBeNull()
    vi.setSystemTime(1_000_000 + 30_000)
    expect(await finder.findTabTranscript(projects, record, SESSION)).toBe(join(elsewhere, `${SESSION}.jsonl`))
    // In its own folder it is found at once.
    const own = join(projects, '-home-dev-app')
    await mkdir(own)
    await writeFile(join(own, `${SESSION}.jsonl`), '')
    vi.setSystemTime(1_000_000 + 32_000)
    expect(await finder.findTabTranscript(projects, record, SESSION)).toBe(join(own, `${SESSION}.jsonl`))
  })
})

// A view (the window, also after a reload, or an API client) attaches and replays what the terminal kept.
describe('the output a terminal keeps for its views', () => {
  const MAX_BUFFER_CHARS = 2_000_000
  let own: TerminalService
  let id: string
  let pty: FakePty

  beforeEach(() => {
    vi.useFakeTimers()
    own = serviceWithPty(tmpdir())
    id = own.create({ accountId: 'a', mode: 'shell', cols: 100, rows: 30 }).id
    pty = lastPty()
  })
  afterEach(() => {
    own.disposeAll()
    vi.useRealTimers()
  })

  /** One piece of output, on its way to the views (and into the buffer) before the next one comes. */
  const output = (data: string) => {
    pty.output(data)
    vi.advanceTimersByTime(10)
  }

  it('coalesces output for a moment and numbers it by its place in the stream', () => {
    const data = vi.fn()
    own.on('data', data)
    pty.output('ab')
    pty.output('cd')
    expect(data).not.toHaveBeenCalled()
    vi.advanceTimersByTime(10)
    expect(data).toHaveBeenCalledOnce()
    expect(data).toHaveBeenCalledWith(id, 'abcd', 0)
    output('ef')
    expect(data).toHaveBeenLastCalledWith(id, 'ef', 4)
    expect(own.buffer(id)).toEqual({ data: 'abcdef', end: 6 })
  })

  it('drops the oldest pieces once it keeps more than the limit, the stream offset goes on', () => {
    output('a'.repeat(1_200_000))
    output('b'.repeat(MAX_BUFFER_CHARS - 1_200_000))
    // Exactly at the limit nothing goes.
    expect(runs(own.buffer(id).data)).toBe('a×1200000 b×800000')
    output('c')
    // Whole pieces go, never part of one.
    const { data, end } = own.buffer(id)
    expect(runs(data)).toBe('b×800000 c×1')
    expect(end).toBe(MAX_BUFFER_CHARS + 1)
    // A view that subscribed before it fetched the buffer places the next piece right after it.
    const live = vi.fn()
    own.on('data', live)
    output('d')
    expect(live).toHaveBeenCalledWith(id, 'd', end)
  })

  it('keeps the latest piece even when it alone is over the limit', () => {
    output('a'.repeat(10))
    output('b'.repeat(MAX_BUFFER_CHARS + 5))
    expect(own.buffer(id)).toMatchObject({ end: MAX_BUFFER_CHARS + 15 })
    expect(runs(own.buffer(id).data)).toBe(`b×${MAX_BUFFER_CHARS + 5}`)
  })

  it('gives a view that attaches after a trim the terminal modes set in the dropped output', () => {
    output('\x1b[?2004h' + 'a'.repeat(1_200_000))
    output('b'.repeat(900_000))
    // The raw buffer has lost bracketed paste: pasted lines would run one by one.
    expect(own.buffer(id).data.startsWith('b')).toBe(true)
    const view = own.attach(id)
    expect(view.data.slice(0, 10)).toBe('\x1b[?2004hbb')
    expect(view.data.length).toBe(8 + 900_000)
    expect(view.end).toBe(8 + 1_200_000 + 900_000)
  })

  it('completes an escape sequence the trim cut in two', () => {
    output('a'.repeat(1_200_000) + '\x1b[?10')
    output('49h' + 'b'.repeat(900_000))
    expect(own.buffer(id).data.slice(0, 5)).toBe('49hbb')
    // The view gets the alternate screen whole, not "49h" as text.
    expect(own.attach(id).data.slice(0, 10)).toBe('\x1b[?1049hbb')
  })

  it('tells a view whether an earlier one already answered the queries in the output', () => {
    // A program asks for the device attributes; the first view answers.
    output('\x1b[c')
    // An API client reading the buffer answers nothing.
    own.buffer(id)
    expect(own.attach(id)).toEqual({ data: '\x1b[c', end: 3, answered: false, cols: 100, rows: 30 })
    // The window reloaded: answering again would reach the program as typed input.
    expect(own.attach(id)).toMatchObject({ answered: true })
  })

  it('replays at the size the output was last written for', () => {
    own.resize(id, 90, 20)
    output('x')
    expect(own.attach(id)).toMatchObject({ cols: 90, rows: 20 })
  })

  it('sends what is still waiting before it tells that the process ended', () => {
    const events: string[] = []
    own.on('data', (_id, data) => events.push(`data ${data}`))
    own.on('exit', (_id, exitCode) => events.push(`exit ${exitCode}`))
    pty.output('Tschüss')
    pty.exit(0)
    expect(events).toEqual(['data Tschüss', 'exit 0'])
    expect(own.buffer(id).data).toBe('Tschüss')
  })
})

// Claude Code's window title shows whether it works; once it turns idle the turn ended (or waits).
describe('the end of a turn, told by the title', () => {
  let own: TerminalService
  let id: string
  let pty: FakePty
  let ended: Mock<TurnListener>

  beforeEach(() => {
    vi.useFakeTimers({ now: 1_000_000 })
    own = serviceWithPty(tmpdir())
    // A shell tab knows no session of the Claude Code in it: its turn can only be done.
    id = own.create({ accountId: 'a', mode: 'shell' }).id
    pty = lastPty()
    ended = vi.fn<TurnListener>()
    own.on('turnEnded', ended)
  })
  afterEach(() => {
    own.disposeAll()
    vi.useRealTimers()
  })

  it('reports a turn once, a moment after the title turns idle, with how long Claude worked', async () => {
    pty.output(BUSY)
    expect(own.get(id).busy).toBe(true)
    await vi.advanceTimersByTimeAsync(4000)
    pty.output(IDLE)
    expect(own.get(id).busy).toBe(false)
    await vi.advanceTimersByTimeAsync(200)
    expect(ended).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(100)
    expect(ended).toHaveBeenCalledOnce()
    expect(ended).toHaveBeenCalledWith(id, { kind: 'done', tool: null, detail: null, busyMs: 4000 })
    // The same title again is no news.
    pty.output(IDLE)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(ended).toHaveBeenCalledOnce()
  })

  it('counts a turn that goes on before its end was clear as one, timed from its start', async () => {
    pty.output(BUSY)
    await vi.advanceTimersByTimeAsync(1000)
    pty.output(IDLE)
    await vi.advanceTimersByTimeAsync(100)
    // Back at work (the next tool) and idle again before the first end was looked up.
    pty.output(BUSY)
    await vi.advanceTimersByTimeAsync(100)
    pty.output(IDLE)
    await vi.advanceTimersByTimeAsync(100)
    expect(ended).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(ended).toHaveBeenCalledOnce()
    expect(ended).toHaveBeenCalledWith(id, expect.objectContaining({ kind: 'done', busyMs: 1200 }))
  })

  it('follows only Claude Code’s titles, also when one comes in two pieces', () => {
    pty.output('\x1b]0;◐ Cla')
    expect(own.get(id).busy).toBe(false)
    pty.output('ude Code\x07')
    expect(own.get(id).busy).toBe(true)
    pty.output('\x1b]0;PowerShell\x07')
    expect(own.get(id).busy).toBe(true)
  })

  it('no longer marks the tab as waiting for the user once Claude works again', () => {
    own.setAttention(id, 'input')
    pty.output(BUSY)
    expect(own.get(id).attention).toBeNull()
    pty.output(IDLE)
    // An answer the user hasn't read yet stays unread.
    own.setAttention(id, 'done')
    pty.output(BUSY)
    expect(own.get(id).attention).toBe('done')
  })
})

// With the app's hooks Claude Code tells the end of a turn itself; the title and transcript only fill gaps.
describe('the end of a turn, told by hooks', () => {
  let own: TerminalService
  let id: string
  let pty: FakePty
  let ended: Mock<TurnListener>

  beforeEach(() => {
    vi.useFakeTimers({ now: 1_000_000 })
    // An account without files: no transcript tells anything.
    own = serviceWithPty(tmpdir())
    id = own.create({ accountId: 'a' }).id
    pty = lastPty()
    ended = vi.fn<TurnListener>()
    own.on('turnEnded', ended)
  })
  afterEach(() => {
    own.disposeAll()
    vi.useRealTimers()
  })

  const hook = (event: HookEvent) => own.applyHook(id, { sessionId: null, event })
  const stop = (message: string) => hook({ kind: 'stop', message, background: false })

  it('tells the end a Stop hook reports at once and looks up nothing when the title turns idle', async () => {
    hook({ kind: 'prompt' })
    pty.output(BUSY)
    await vi.advanceTimersByTimeAsync(2000)
    stop('Fertig.')
    expect(ended).toHaveBeenCalledOnce()
    expect(ended).toHaveBeenCalledWith(id, { kind: 'done', tool: null, detail: 'Fertig.', busyMs: 2000 })
    pty.output(IDLE)
    await vi.advanceTimersByTimeAsync(20_000)
    expect(ended).toHaveBeenCalledOnce()
  })

  it('times a short turn from its prompt, also when the title never showed it busy', async () => {
    hook({ kind: 'prompt' })
    await vi.advanceTimersByTimeAsync(800)
    stop('Hallo!')
    expect(ended).toHaveBeenCalledWith(id, expect.objectContaining({ kind: 'done', busyMs: 800 }))
  })

  it('tells at once that Claude waits for a permission, and once only', async () => {
    hook({ kind: 'prompt' })
    pty.output(BUSY)
    hook({ kind: 'input', tool: 'Bash', detail: 'npm test' })
    expect(ended).toHaveBeenCalledOnce()
    expect(ended).toHaveBeenCalledWith(id, { kind: 'input', tool: 'Bash', detail: 'npm test', busyMs: 0 })
    pty.output(IDLE)
    await vi.advanceTimersByTimeAsync(20_000)
    expect(ended).toHaveBeenCalledOnce()
  })

  it('takes an end the hooks report shortly after the title turned idle', async () => {
    hook({ kind: 'prompt' })
    pty.output(BUSY)
    await vi.advanceTimersByTimeAsync(1000)
    pty.output(IDLE)
    await vi.advanceTimersByTimeAsync(1000)
    stop('Fertig.')
    expect(ended).toHaveBeenCalledOnce()
    expect(ended).toHaveBeenCalledWith(id, expect.objectContaining({ kind: 'done', detail: 'Fertig.' }))
    // The lookup the idle title started stopped.
    await vi.advanceTimersByTimeAsync(20_000)
    expect(ended).toHaveBeenCalledOnce()
  })

  it('without an end from the hooks counts the turn as done once the transcript stayed unclear', async () => {
    hook({ kind: 'prompt' })
    pty.output(BUSY)
    await vi.advanceTimersByTimeAsync(1000)
    // The user pressed Esc, which ends no turn, or a hook failed: no Stop comes.
    pty.output(IDLE)
    await vi.advanceTimersByTimeAsync(7900)
    expect(ended).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(300)
    expect(ended).toHaveBeenCalledOnce()
    expect(ended).toHaveBeenCalledWith(id, { kind: 'done', tool: null, detail: null, busyMs: 1000 })
  })

  it('stops showing a tool once Claude stays idle without a hook that ended it', async () => {
    hook({ kind: 'prompt' })
    hook({ kind: 'tool', tool: 'Bash', detail: 'npm test', agent: null })
    pty.output(BUSY)
    pty.output(IDLE)
    expect(own.get(id).activity).toMatchObject({ tool: 'Bash' })
    await vi.advanceTimersByTimeAsync(1500)
    expect(own.get(id).activity).toBeNull()
  })

  it('keeps showing the tool that waits for the user', async () => {
    hook({ kind: 'prompt' })
    hook({ kind: 'tool', tool: 'Bash', detail: 'npm test', agent: null })
    pty.output(BUSY)
    hook({ kind: 'input', tool: 'Bash', detail: 'npm test' })
    pty.output(IDLE)
    await vi.advanceTimersByTimeAsync(5000)
    expect(own.get(id).activity).toMatchObject({ tool: 'Bash' })
  })

  it('tells a limit a hook reported with the hook’s message when the transcript doesn’t name it', async () => {
    hook({ kind: 'prompt' })
    hook({ kind: 'failure', error: 'rate_limit', message: 'API Error: 429' })
    await vi.advanceTimersByTimeAsync(7500)
    expect(ended).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1000)
    expect(ended).toHaveBeenCalledOnce()
    expect(ended).toHaveBeenCalledWith(id, { kind: 'limit', tool: null, detail: 'API Error: 429', busyMs: 0 })
  })

  it('sends the tools the hooks report in quick succession as one update', async () => {
    const changed = vi.fn()
    own.on('changed', changed)
    // The first hook shows at once that the session has hooks.
    hook({ kind: 'prompt' })
    expect(changed).toHaveBeenCalledOnce()
    hook({ kind: 'tool', tool: 'Read', detail: 'a.ts', agent: null })
    hook({ kind: 'tool', tool: 'Grep', detail: 'TODO', agent: null })
    expect(changed).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(100)
    expect(changed).toHaveBeenCalledTimes(2)
    const [terminals] = changed.mock.lastCall as [TerminalInfo[]]
    expect(terminals.find((t) => t.id === id)?.activity).toMatchObject({ tool: 'Grep', detail: 'TODO' })
  })
  it('keeps how the turn ended and the prompt, also once the tab was shown, until the next turn', async () => {
    hook({ kind: 'prompt', prompt: 'Teste alles' })
    expect(own.get(id).prompt).toBe('Teste alles')
    pty.output(BUSY)
    await vi.advanceTimersByTimeAsync(1000)
    stop('# Fertig\n\nAlle **Tests** laufen.\n\n```sh\nnpm test\n```')
    pty.output(IDLE)
    expect(own.get(id).turn).toEqual({ kind: 'done', tool: null, detail: 'Fertig Alle Tests laufen.', at: new Date().toISOString() })
    own.setAttention(id, null)
    await vi.advanceTimersByTimeAsync(20_000)
    expect(own.get(id).turn?.kind).toBe('done')

    hook({ kind: 'prompt', prompt: 'Noch eins' })
    expect(own.get(id).turn).toBeNull()
    expect(own.get(id).prompt).toBe('Noch eins')
  })

  it('keeps a wait for the user until it is answered', () => {
    hook({ kind: 'prompt' })
    pty.output(BUSY)
    hook({ kind: 'input', tool: 'Bash', detail: 'npm test' })
    pty.output(IDLE)
    expect(own.get(id).turn).toMatchObject({ kind: 'input', tool: 'Bash', detail: 'npm test' })
    // Another tool of a subagent goes on: the session itself still waits.
    hook({ kind: 'tool', tool: 'Read', detail: 'a.ts', agent: 'a1' })
    expect(own.get(id).turn?.kind).toBe('input')
    hook({ kind: 'toolDone', agent: null })
    expect(own.get(id).turn).toBeNull()
  })

  it('forgets an end the transcript told with the next prompt', async () => {
    hook({ kind: 'prompt' })
    pty.output(BUSY)
    // Esc: no Stop comes, the end is the transcript's.
    pty.output(IDLE)
    await vi.advanceTimersByTimeAsync(9000)
    expect(own.get(id).turn?.kind).toBe('done')
    hook({ kind: 'prompt', prompt: 'Weiter' })
    expect(own.get(id).turn).toBeNull()
  })

  it('forgets the end of the turn once Claude works again, also without a hook', () => {
    hook({ kind: 'prompt' })
    pty.output(BUSY)
    stop('Fertig.')
    pty.output(IDLE)
    expect(own.get(id).turn).not.toBeNull()
    pty.output(BUSY)
    expect(own.get(id).turn).toBeNull()
  })

  it('forgets prompt and end of the conversation before /clear', () => {
    const first = '11111111-2222-4333-8444-555555555555'
    own.applyHook(id, { sessionId: first, event: { kind: 'prompt', prompt: 'Alt' } })
    own.applyHook(id, { sessionId: first, event: { kind: 'stop', message: 'Fertig.', background: false } })
    expect(own.get(id)).toMatchObject({ prompt: 'Alt', turn: { kind: 'done' } })
    own.applyHook(id, { sessionId: '99999999-2222-4333-8444-555555555555', event: { kind: 'compact', running: false } })
    expect(own.get(id)).toMatchObject({ prompt: null, turn: null })
  })

  it('keeps the answer of the last turn that was done, for „Letzte Antwort kopieren“', async () => {
    const first = '11111111-2222-4333-8444-555555555555'
    const answer = '## Fertig\n\nAlle **Tests** laufen.'
    expect(await own.lastAnswer(id)).toBeNull()
    own.applyHook(id, { sessionId: first, event: { kind: 'prompt' } })
    own.applyHook(id, { sessionId: first, event: { kind: 'stop', message: answer, background: false } })
    expect(await own.lastAnswer(id)).toBe(answer)
    // The next turn waits for a permission, then works on: the answer before stays.
    hook({ kind: 'prompt' })
    hook({ kind: 'input', tool: 'Bash', detail: 'npm test' })
    pty.output(BUSY)
    expect(await own.lastAnswer(id)).toBe(answer)
    stop('Zweite Antwort')
    expect(await own.lastAnswer(id)).toBe('Zweite Antwort')
    // After /clear it belongs to the conversation before.
    own.applyHook(id, { sessionId: '99999999-2222-4333-8444-555555555555', event: { kind: 'prompt' } })
    expect(await own.lastAnswer(id)).toBeNull()
    expect(await own.lastAnswer('unbekannt')).toBeNull()
  })
})

// Without hooks (or when they tell nothing) the transcript tells why the title turned idle.
describe('the end of a turn, read in the transcript', () => {
  const START = Date.parse('2026-03-02T10:00:00.000Z')
  let root: string
  let own: TerminalService
  let id: string
  let pty: FakePty
  let transcript: string
  let ended: Mock<TurnListener>

  beforeEach(async () => {
    // Only the clock is fake: the service reads real files in between.
    vi.useFakeTimers({ now: START, toFake: ['Date'] })
    root = await mkdtemp(join(tmpdir(), 'cm-turn-'))
    const dirs = { sessionsDir: join(root, 'sessions'), projectsDir: join(root, 'projects'), configDir: root }
    own = serviceWithPty(root, dirs)
    const info = own.create({ accountId: 'a' })
    id = info.id
    pty = lastPty()
    const project = join(dirs.projectsDir, projectKey(root))
    await mkdir(project, { recursive: true })
    transcript = join(project, `${info.sessionId}.jsonl`)
    ended = vi.fn<TurnListener>()
    own.on('turnEnded', ended)
  })
  afterEach(async () => {
    own.disposeAll()
    vi.useRealTimers()
    await rm(root, { recursive: true, force: true })
  })

  /** Real time, in which the service looks at the transcript (every 300 ms). */
  const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
  const turnEnded = async () => {
    for (let waited = 0; ended.mock.calls.length === 0 && waited < 3000; waited += 20) await pause(20)
  }

  /** Transcript entries, written `ms` after the start. */
  const at = (ms: number) => new Date(START + ms).toISOString()
  const prompt = (ms: number, text: string) => ({ type: 'user', timestamp: at(ms), message: { role: 'user', content: text } })
  const answer = (ms: number, content: object[]) => ({
    type: 'assistant',
    timestamp: at(ms),
    message: { role: 'assistant', model: 'claude-opus-5-5', content },
  })
  const LIMIT_MESSAGE = 'You’ve hit your session limit · resets 11am'
  const limit = (ms: number) => ({
    type: 'assistant',
    timestamp: at(ms),
    error: 'rate_limit',
    quotaLimits: { rateLimitType: 'five_hour', resetsAt: (START + 3_600_000) / 1000 },
    message: { role: 'assistant', model: '<synthetic>', content: [{ type: 'text', text: LIMIT_MESSAGE }] },
  })
  const write = (...entries: object[]) => writeFile(transcript, entries.map((entry) => JSON.stringify(entry)).join('\n') + '\n')

  it('reports the turn as done once the transcript has its end, with the beginning of the answer', async () => {
    pty.output(BUSY)
    await write(
      prompt(0, 'Lass die Tests laufen'),
      answer(2000, [{ type: 'text', text: 'Alle Tests laufen.' }]),
      { type: 'system', subtype: 'turn_duration', timestamp: at(2500) },
    )
    vi.setSystemTime(START + 3000)
    pty.output(IDLE)
    await turnEnded()
    expect(ended).toHaveBeenCalledOnce()
    expect(ended).toHaveBeenCalledWith(id, { kind: 'done', tool: null, detail: 'Alle Tests laufen.', busyMs: 3000 })
  })

  it('reads the last answer of a resumed session in the transcript, once Claude is done', async () => {
    await write(
      prompt(0, 'Lass die Tests laufen'),
      answer(1000, [
        { type: 'text', text: 'Ich starte sie.' },
        { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'npm test' } },
      ]),
      {
        type: 'user',
        timestamp: at(1500),
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'ok' }] },
      },
      answer(2000, [{ type: 'text', text: '## Ergebnis\n\nAlle Tests laufen.' }]),
      { type: 'system', subtype: 'turn_duration', timestamp: at(2500) },
    )
    expect(await own.lastAnswer(id)).toBe('## Ergebnis\n\nAlle Tests laufen.')
    // A new turn: until it is done its answer isn't the last one.
    pty.output(BUSY)
    const next = [prompt(3000, 'Und jetzt?'), answer(3500, [{ type: 'text', text: 'Ich schaue nach.' }])]
    await writeFile(transcript, next.map((entry) => JSON.stringify(entry) + '\n').join(''), { flag: 'a' })
    expect(await own.lastAnswer(id)).toBeNull()
    await rm(transcript)
    pty.output(IDLE)
    expect(await own.lastAnswer(id)).toBeNull()
  })

  it('tells that Claude waits for the user once a tool call stayed without result for a while', async () => {
    pty.output(BUSY)
    await write(prompt(0, 'Lass die Tests laufen'), answer(1000, [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'npm test' } }]))
    vi.setSystemTime(START + 1500)
    pty.output(IDLE)
    // Its result may still be in Claude Code's buffer: a few looks go by without news.
    await pause(500)
    expect(ended).not.toHaveBeenCalled()
    vi.setSystemTime(START + 1500 + 4500)
    await turnEnded()
    expect(ended).toHaveBeenCalledOnce()
    expect(ended).toHaveBeenCalledWith(id, { kind: 'input', tool: 'Bash', detail: 'npm test', busyMs: 1500 })
  })

  it('stays quiet when the user stopped the turn', async () => {
    pty.output(BUSY)
    await write(
      prompt(0, 'Lass die Tests laufen'),
      answer(500, [{ type: 'text', text: 'Ich starte die Tests.' }]),
      prompt(1000, '[Request interrupted by user]'),
    )
    vi.setSystemTime(START + 1000)
    pty.output(IDLE)
    await pause(500)
    // Also past the time after which an unclear turn counts as done: the lookup is over.
    vi.setSystemTime(START + 1000 + 8000)
    await pause(500)
    expect(ended).not.toHaveBeenCalled()
  })

  it('reports a limit with Claude Code’s message from the transcript', async () => {
    pty.output(BUSY)
    await write(prompt(0, 'Lass die Tests laufen'), limit(1000))
    vi.setSystemTime(START + 1000)
    pty.output(IDLE)
    await turnEnded()
    expect(ended).toHaveBeenCalledOnce()
    expect(ended).toHaveBeenCalledWith(id, { kind: 'limit', tool: null, detail: LIMIT_MESSAGE, busyMs: 1000 })
    expect(own.get(id).limit).toMatchObject({ type: 'five_hour', message: LIMIT_MESSAGE })
  })

  it('tells a limit a hook reported once the transcript has it, for its reset time and message', async () => {
    own.applyHook(id, { sessionId: null, event: { kind: 'prompt' } })
    own.applyHook(id, { sessionId: null, event: { kind: 'failure', error: 'rate_limit', message: 'API Error: 429' } })
    await pause(500)
    expect(ended).not.toHaveBeenCalled()
    await write(prompt(0, 'Lass die Tests laufen'), limit(100))
    await turnEnded()
    expect(ended).toHaveBeenCalledOnce()
    expect(ended).toHaveBeenCalledWith(id, { kind: 'limit', tool: null, detail: LIMIT_MESSAGE, busyMs: 0 })
  })
})
