import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AccountService } from './account-service'
import type { ClaudeCli } from './claude-cli'
import type { SettingsService } from './settings-service'
import { TerminalService } from './terminal-service'
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
