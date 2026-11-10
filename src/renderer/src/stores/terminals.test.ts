import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserOpenOptions, PaneSplit, TerminalInfo, TerminalMode } from '@shared/types'
import { BROWSER_TAB, createWorkspace, type Workspace } from '@/lib/workspace'

/**
 * The browser tab with the tabs in groups: the sessions' browsers are its pages, not tabs of their
 * own, and it shows those of the session with the keyboard.
 */

function terminal(id: string, mode: TerminalMode = 'session'): TerminalInfo {
  return {
    id,
    accountId: 'a',
    authAccountId: 'a',
    sessionId: null,
    limit: null,
    busy: false,
    attention: null,
    muted: false,
    title: id,
    fixedTitle: false,
    autoTitle: id,
    cwd: mode === 'browser' ? '' : 'C:\\dev',
    mode,
    url: mode === 'browser' ? 'https://example.com/' : null,
    resumeSessionId: null,
    status: 'running',
    exitCode: null,
    pid: 0,
    createdAt: '',
    commandLine: '',
    worktree: null,
    hooks: false,
    activity: null,
    subagents: 0,
    compacting: false,
  }
}

/** `first` with `second` on its right, as main keeps a browser opened beside a session. */
const beside = (first: string | PaneSplit, second: string | PaneSplit, direction: 'row' | 'column' = 'row'): PaneSplit => ({
  direction,
  ratio: 0.5,
  first,
  second,
})

/** What main has: its terminals and splits. */
let main: { list: TerminalInfo[]; splits: PaneSplit[] }
let changed: (list: TerminalInfo[], splits: PaneSplit[]) => void
const storage = new Map<string, string>()

const api = {
  platform: 'win32',
  settings: { onChanged: () => () => {} },
  app: { onQuitting: () => () => {} },
  terminals: {
    list: vi.fn(async () => main.list),
    layouts: vi.fn(async () => main.splits),
    onChanged: (cb: typeof changed) => {
      changed = cb
      return () => {}
    },
    onReplaced: () => () => {},
    openBrowser: vi.fn(async (options: BrowserOpenOptions) => {
      const info = terminal(`page-${main.list.length}`, 'browser')
      main.list = [...main.list, info]
      const anchor = options.split?.terminalId
      if (anchor) {
        const added = beside(anchor, info.id, options.split!.direction)
        const index = main.splits.findIndex((s) => JSON.stringify(s).includes(`"${anchor}"`))
        main.splits =
          index === -1 ? [...main.splits, added] : main.splits.map((s, i) => (i === index ? (JSON.parse(JSON.stringify(s).replace(`"${anchor}"`, JSON.stringify(added))) as PaneSplit) : s))
      }
      // Main reports before it answers.
      changed(main.list, main.splits)
      return info
    }),
    reorder: vi.fn(),
    arrange: vi.fn(),
    close: vi.fn(),
  },
}

async function load(list: TerminalInfo[], splits: PaneSplit[], saved?: { workspace: Workspace; order: { id: string; mode: TerminalMode }[] }) {
  main = { list, splits }
  if (saved) storage.set('claude-manager.workspace', JSON.stringify(saved))
  const { useTerminalsStore } = await import('./terminals')
  const { useSettingsStore } = await import('./settings')
  useSettingsStore().settings.appearance.tabPosition = 'groups'
  const terminals = useTerminalsStore()
  await terminals.load()
  return terminals
}

/** The tabs of each group, in the order of the layout. */
const tabsOf = (terminals: Awaited<ReturnType<typeof load>>) => terminals.groups.map((g) => g.tabs.map((t) => t.id))

beforeEach(() => {
  storage.clear()
  vi.stubGlobal('window', { api })
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => void storage.set(key, value),
    removeItem: (key: string) => void storage.delete(key),
  })
  setActivePinia(createPinia())
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

describe('the browser tab', () => {
  it('holds the pages of the sessions instead of tabs of their own, beside the first session', async () => {
    const terminals = await load(
      [terminal('s1'), terminal('b1', 'browser'), terminal('s2'), terminal('b2', 'browser')],
      [beside('s1', 'b1'), beside('s2', 'b2')],
    )
    expect(tabsOf(terminals)).toEqual([['s1', 's2'], [BROWSER_TAB]])
    expect(terminals.isSessionPage('b1')).toBe(true)
    expect(terminals.isSessionPage('s1')).toBe(false)
  })

  it('shows the pages of the session with the keyboard, and asks for an address where it has none', async () => {
    const terminals = await load(
      [terminal('s1'), terminal('b1', 'browser'), terminal('s2'), terminal('b2', 'browser'), terminal('s3')],
      [beside('s1', 'b1'), beside('s2', 'b2')],
    )
    terminals.activate('s1')
    expect(terminals.browserPage?.id).toBe('b1')
    terminals.activate('s2')
    expect(terminals.browserPage?.id).toBe('b2')
    terminals.activate('s3')
    expect(terminals.browserSession?.id).toBe('s3')
    expect(terminals.browserPage).toBeNull()
  })

  it('comes forward with a session that has pages, and gives its page the keyboard when selected', async () => {
    const terminals = await load([terminal('s1'), terminal('b1', 'browser'), terminal('s2')], [beside('s1', 'b1')])
    const browserGroup = terminals.groupOf(BROWSER_TAB)!.id
    terminals.openPage('settings')
    terminals.dropTab('page:settings', browserGroup, 'center')
    expect(terminals.groupOf(BROWSER_TAB)!.active).toBe('page:settings')
    terminals.activate('s1')
    expect(terminals.groupOf(BROWSER_TAB)!.active).toBe(BROWSER_TAB)
    terminals.activateTab(BROWSER_TAB)
    expect(terminals.focusedTab).toBe(BROWSER_TAB)
    expect(terminals.activeId).toBe('b1')
  })

  it('looks at another session’s pages until the next session gets the keyboard', async () => {
    const terminals = await load(
      [terminal('s1'), terminal('b1', 'browser'), terminal('s2'), terminal('b2', 'browser')],
      [beside('s1', 'b1'), beside('s2', 'b2')],
    )
    terminals.activate('s1')
    terminals.peekBrowser('s2')
    expect(terminals.browserPage?.id).toBe('b2')
    expect(terminals.activeId).toBe('s1')
    terminals.activate('s1')
    expect(terminals.browserPage?.id).toBe('b1')
  })

  it('shows a session’s new page, and remembers the page each session shows', async () => {
    const terminals = await load([terminal('s1'), terminal('b1', 'browser'), terminal('s2')], [beside('s1', 'b1')])
    terminals.activate('s1')
    const page = await terminals.openBrowser({ split: { terminalId: 'b1', direction: 'column' } })
    expect(terminals.isSessionPage(page.id)).toBe(true)
    expect(terminals.browserPage?.id).toBe(page.id)
    expect(terminals.focusedTab).toBe(BROWSER_TAB)
    expect(tabsOf(terminals).flat()).not.toContain(page.id)
    terminals.activate('s2')
    terminals.activate('s1')
    expect(terminals.browserPage?.id).toBe(page.id)
    terminals.activate('b1')
    expect(terminals.browserPage?.id).toBe('b1')
  })

  it('keeps the pages when closed, and comes back with a new one', async () => {
    const terminals = await load([terminal('s1'), terminal('b1', 'browser')], [beside('s1', 'b1')])
    terminals.closeBrowserTab()
    expect(terminals.groupOf(BROWSER_TAB)).toBeNull()
    expect(terminals.browsersOf('s1').map((t) => t.id)).toEqual(['b1'])
    await terminals.openBrowser({ split: { terminalId: 'b1', direction: 'column' } })
    expect(terminals.groupOf(BROWSER_TAB)).not.toBeNull()
  })

  it('comes back for a session without pages, without opening one', async () => {
    const terminals = await load([terminal('s1')], [])
    expect(terminals.groupOf(BROWSER_TAB)).toBeNull()
    terminals.showBrowser('s1')
    expect(tabsOf(terminals)).toEqual([['s1'], [BROWSER_TAB]])
    expect(terminals.focusedTab).toBe(BROWSER_TAB)
    expect(terminals.browserSession?.id).toBe('s1')
    expect(api.terminals.openBrowser).not.toHaveBeenCalled()
  })

  it('takes the place of a page that was a tab of its own in the last run, and stays closed when left closed', async () => {
    const list = [terminal('s1'), terminal('b1', 'browser'), terminal('b2', 'browser')]
    const splits = [beside('s1', beside('b1', 'b2', 'column'))]
    const order = list.map((t) => ({ id: t.id, mode: t.mode }))
    const old: Workspace = {
      layout: beside('g1', 'g2'),
      groups: [
        { id: 'g1', tabs: ['s1'], active: 's1' },
        { id: 'g2', tabs: ['b1', 'b2'], active: 'b2' },
      ],
      activeGroup: 'g1',
    }
    const terminals = await load(list, splits, { workspace: old, order })
    expect(tabsOf(terminals)).toEqual([['s1'], [BROWSER_TAB]])
    // The pages of the last run load once shown.
    expect([...terminals.sleeping]).toEqual(['b1', 'b2'])

    setActivePinia(createPinia())
    const closed = await load(list, splits, { workspace: createWorkspace('g1', ['s1']), order })
    expect(tabsOf(closed)).toEqual([['s1']])
  })

  it('is open for a session only while it shows the session’s pages in front', async () => {
    const terminals = await load([terminal('s1'), terminal('b1', 'browser'), terminal('s2')], [beside('s1', 'b1')])
    terminals.activate('s1')
    expect(terminals.browserShownFor('s1')).toBe(true)
    expect(terminals.browserShownFor('s2')).toBe(false)
    // Without pages the session is offered to open it, also while the tab asks for its address.
    terminals.activate('s2')
    expect(terminals.browserShownFor('s2')).toBe(false)
    expect(terminals.browserShownFor('s1')).toBe(false)
    terminals.showBrowser('s1')
    expect(terminals.browserShownFor('s1')).toBe(true)
    // Behind another tab of its group it is not open for anyone.
    terminals.openPage('settings')
    terminals.dropTab('page:settings', terminals.groupOf(BROWSER_TAB)!.id, 'center')
    expect(terminals.browserShownFor('s1')).toBe(false)
  })

  it('goes when no session of the last run comes back', async () => {
    const saved: Workspace = {
      layout: beside('g1', 'g2'),
      groups: [
        { id: 'g1', tabs: ['s1'], active: 's1' },
        { id: 'g2', tabs: [BROWSER_TAB], active: BROWSER_TAB },
      ],
      activeGroup: 'g1',
    }
    const order = [{ id: 's1', mode: 'session' as const }]
    const none = await load([], [], { workspace: saved, order })
    expect(tabsOf(none).flat()).toEqual([])

    setActivePinia(createPinia())
    const back = await load([terminal('s1')], [], { workspace: saved, order })
    expect(tabsOf(back)).toEqual([['s1'], [BROWSER_TAB]])
  })
})
