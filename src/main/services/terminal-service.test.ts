import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AccountService } from './account-service'
import type { ClaudeCli } from './claude-cli'
import type { SettingsService } from './settings-service'
import { currentWorktree, movedTo, TerminalService } from './terminal-service'
import type { WorkspaceTrust } from './workspace-trust'

vi.mock('electron', () => ({ app: { getPath: () => '' } }))

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
