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
