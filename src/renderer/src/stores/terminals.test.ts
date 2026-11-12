import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'
import type { BrowserOpenOptions, PaneSplit, TerminalInfo, TerminalMode } from '@shared/types'
import { BROWSER_TAB, createWorkspace, diffTab, type Workspace } from '@/lib/workspace'

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
    context: null,
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
    args: [],
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

async function load(
  list: TerminalInfo[],
  splits: PaneSplit[],
  saved?: { workspace: Workspace; order: { id: string; mode: TerminalMode }[]; active?: string },
  tabPosition: 'groups' | 'top' = 'groups',
) {
  main = { list, splits }
  if (saved) storage.set('claude-manager.workspace', JSON.stringify(saved))
  const { useTerminalsStore } = await import('./terminals')
  const { useSettingsStore } = await import('./settings')
  useSettingsStore().settings.appearance.tabPosition = tabPosition
  const terminals = useTerminalsStore()
  await terminals.load()
  return terminals
}

/** The tabs of each group, in the order of the layout. */
const tabsOf = (terminals: Awaited<ReturnType<typeof load>>) => terminals.groups.map((g) => g.tabs.map((t) => t.id))

/** In one tab bar, the terminals of each tab, in the order of the tabs. */
const tabBar = (terminals: Awaited<ReturnType<typeof load>>) => terminals.tabs.map((t) => t.panes.map((p) => p.id))

const sessions = (...ids: string[]) => ids.map((id) => terminal(id))

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

describe('changes beside a session', () => {
  const all = { root: 'C:\\dev', path: '' }

  it('open in a new group on the right, with the keyboard', async () => {
    const terminals = await load([terminal('s1'), terminal('s2')], [])
    terminals.activate('s1')
    terminals.openDiffBeside(all, 's1')
    expect(tabsOf(terminals)).toEqual([['s1', 's2'], [diffTab(all)]])
    expect(terminals.focusedTab).toBe(diffTab(all))
    expect(terminals.groups[0].active).toBe('s1')
  })

  it('join the group on the right and are shown there, also once more', async () => {
    const terminals = await load([terminal('s1'), terminal('b1', 'browser')], [beside('s1', 'b1')])
    terminals.activate('s1')
    terminals.openDiffBeside(all, 's1')
    expect(tabsOf(terminals)).toEqual([['s1'], [BROWSER_TAB, diffTab(all)]])
    expect(terminals.groups[1].active).toBe(diffTab(all))
    expect(terminals.focusedTab).toBe(diffTab(all))
    terminals.activate('s1')
    terminals.openDiffBeside(all, 's1')
    expect(tabsOf(terminals)).toEqual([['s1'], [BROWSER_TAB, diffTab(all)]])
    expect(terminals.focusedTab).toBe(diffTab(all))
  })

  it('move out of the session’s own group', async () => {
    const terminals = await load([terminal('s1')], [])
    terminals.openDiff(all, terminals.groupOf('s1')!.id, true)
    terminals.openDiffBeside(all, 's1')
    expect(tabsOf(terminals)).toEqual([['s1'], [diffTab(all)]])
    expect(terminals.groups[0].active).toBe('s1')
  })
})

describe('the keys', () => {
  it('go to no terminal while a page such as the settings has the keyboard', async () => {
    const terminals = await load([terminal('s1'), terminal('b1', 'browser')], [])
    terminals.activate('b1')
    expect(terminals.keyboardTerminal).toBe('b1')
    terminals.openPage('settings')
    // The browser stays the active terminal, hidden behind the page: F5 must not reload it.
    expect(terminals.activeId).toBe('b1')
    expect(terminals.keyboardTerminal).toBeNull()
    terminals.activate('s1')
    expect(terminals.keyboardTerminal).toBe('s1')
  })
})

describe('dragging a divider', () => {
  it('keeps its share while main reports a working session, and takes main’s again once let go', async () => {
    const terminals = await load([terminal('s1'), terminal('s2')], [beside('s1', 's2')])
    const tab = terminals.tabs.find((t) => typeof t.layout !== 'string')!
    const share = () => (terminals.tabs.find((t) => t.id === tab.id)?.layout as PaneSplit).ratio
    terminals.resize(tab.id, [], 0.3, false)
    // A session starts working: main sends its list with the share it knows.
    changed(main.list.map((t) => (t.id === 's1' ? { ...t, busy: true } : t)), main.splits)
    expect(share()).toBe(0.3)
    terminals.resize(tab.id, [], 0.35, true)
    expect(api.terminals.arrange).toHaveBeenCalledWith({ ...beside('s1', 's2'), ratio: 0.35 })
    // From now on main's list counts again.
    changed(main.list, [{ ...beside('s1', 's2'), ratio: 0.6 }])
    expect(share()).toBe(0.6)
  })
})

describe('one tab bar after the window loaded again', () => {
  it('gives the keyboard back to the terminal that had it, not to the last tab', async () => {
    const order = ['s1', 's2', 's3'].map((id) => ({ id, mode: 'session' as const }))
    const saved = { workspace: { layout: 'g1', groups: [{ id: 'g1', tabs: ['s1', 's2', 's3'], active: 's1' }], activeGroup: 'g1' }, order, active: 's2' }
    const terminals = await load([terminal('s1'), terminal('s2'), terminal('s3')], [], saved, 'top')
    expect(terminals.activeId).toBe('s2')
    // And keeps it for the next time.
    expect(JSON.parse(storage.get('claude-manager.workspace')!).active).toBe('s2')
  })
})

describe('the groups of the last run', () => {
  it('come back although main reports its terminals before the window loaded them', async () => {
    const saved: Workspace = {
      layout: beside('g1', 'g2'),
      groups: [
        { id: 'g1', tabs: ['s1'], active: 's1' },
        { id: 'g2', tabs: ['s2'], active: 's2' },
      ],
      activeGroup: 'g2',
    }
    const order = [
      { id: 's1', mode: 'session' as const },
      { id: 's2', mode: 'session' as const },
    ]
    // A terminal starts working while the window still loads: main reports all of them.
    api.terminals.list.mockImplementationOnce(async () => {
      changed(main.list, main.splits)
      await new Promise((resolve) => setTimeout(resolve, 0))
      return main.list
    })
    const terminals = await load([terminal('s1'), terminal('s2')], [], { workspace: saved, order })
    expect(tabsOf(terminals)).toEqual([['s1'], ['s2']])
  })

  it('keep their tabs when another tab of the last run did not come back', async () => {
    const saved: Workspace = {
      layout: beside('g1', 'g2'),
      groups: [
        { id: 'g1', tabs: ['s1'], active: 's1' },
        { id: 'g2', tabs: ['s2', 's3'], active: 's3' },
      ],
      activeGroup: 'g2',
    }
    const order = ['s1', 's2', 's3'].map((id) => ({ id, mode: 'session' as const }))
    // Main opened them again with new ids; s2 could not start.
    const list = [
      { ...terminal('n1'), restoredFrom: 's1' },
      { ...terminal('n3'), restoredFrom: 's3' },
    ]
    const terminals = await load(list, [], { workspace: saved, order })
    expect(tabsOf(terminals)).toEqual([['n1'], ['n3']])
    expect(terminals.restoredIds).toEqual(new Map([['s1', 'n1'], ['s3', 'n3']]))
  })
})

describe('closed tabs', () => {
  const talked = (t: TerminalInfo): TerminalInfo => ({ ...t, sessionId: `s-${t.id}`, context: { tokens: 1 } as unknown as TerminalInfo['context'] })

  it('are remembered newest first, a session with its conversation, a browser not at all', async () => {
    const terminals = await load([talked(terminal('s1')), terminal('sh', 'shell'), terminal('b1', 'browser')], [], undefined, 'top')
    await terminals.close('s1')
    await terminals.close('b1')
    await terminals.close('sh')
    expect(terminals.recentlyClosed.map((e) => [e.id, e.sessionId])).toEqual([
      ['sh', null],
      ['s1', 's-s1'],
    ])
  })

  it('are remembered with every terminal of a closed split tab', async () => {
    const terminals = await load([terminal('s1'), terminal('s2'), terminal('s3')], [beside('s1', 's2')], undefined, 'top')
    await terminals.closeTab(terminals.tabOf('s1')!.id)
    expect(terminals.recentlyClosed.map((e) => e.id).sort()).toEqual(['s1', 's2'])
  })

  it('are forgotten once opened again, and with their account', async () => {
    const terminals = await load([terminal('s1'), { ...terminal('s2'), accountId: 'b' }], [], undefined, 'top')
    await terminals.close('s1')
    await terminals.close('s2')
    terminals.forgetClosedOf('b')
    expect(terminals.recentlyClosed.map((e) => e.id)).toEqual(['s1'])
    terminals.forgetClosed('s1')
    expect(terminals.recentlyClosed).toEqual([])
  })
})

describe('a maximized part of a split tab', () => {
  it('gets the keyboard, and gives way to all parts again', async () => {
    const terminals = await load([terminal('s1'), terminal('s2'), terminal('s3')], [beside('s1', 's2')], undefined, 'top')
    terminals.toggleZoom('s2')
    expect(terminals.zoomed).toBe('s2')
    expect(terminals.activeId).toBe('s2')
    terminals.toggleZoom('s2')
    expect(terminals.zoomed).toBeNull()
  })

  it('stays while another tab is in front, not once another part gets the keyboard', async () => {
    const terminals = await load([terminal('s1'), terminal('s2'), terminal('s3')], [beside('s1', 's2')], undefined, 'top')
    terminals.toggleZoom('s2')
    terminals.activate('s3')
    await nextTick()
    terminals.activate('s2')
    await nextTick()
    expect(terminals.zoomed).toBe('s2')
    terminals.activate('s1')
    await nextTick()
    expect(terminals.zoomed).toBeNull()
  })

  it('ends when its tab gets another part', async () => {
    const terminals = await load([terminal('s1'), terminal('s2'), terminal('s3')], [beside('s1', 's2')], undefined, 'top')
    terminals.toggleZoom('s2')
    await nextTick()
    changed(main.list, [beside('s1', beside('s2', 's3', 'column'))])
    await nextTick()
    expect(terminals.tabOf('s2')!.panes).toHaveLength(3)
    expect(terminals.zoomed).toBeNull()
  })

  it('is no thing in groups, nor for a part alone in its tab', async () => {
    const grouped = await load([terminal('s1'), terminal('s2')], [beside('s1', 's2')])
    grouped.toggleZoom('s2')
    expect(grouped.zoomed).toBeNull()
    setActivePinia(createPinia())
    const single = await load([terminal('s1'), terminal('s2')], [], undefined, 'top')
    single.toggleZoom('s1')
    expect(single.zoomed).toBeNull()
  })
})

describe('where a terminal main reports goes', () => {
  it('takes the place of the terminal it replaces in a split, not a new group beside the split', async () => {
    const saved: Workspace = {
      layout: beside('g1', 'g2'),
      groups: [
        { id: 'g1', tabs: ['s1'], active: 's1' },
        { id: 'g2', tabs: ['s2', 's3'], active: 's3' },
      ],
      activeGroup: 'g1',
    }
    const order = ['s1', 's2', 's3'].map((id) => ({ id, mode: 'session' as const }))
    const terminals = await load(sessions('s1', 's2', 's3'), [beside('s1', 's2')], { workspace: saved, order })
    // Main starts n2 in the place of s2: right before it in its list, and in its part of the split.
    changed(sessions('s1', 'n2', 's2', 's3'), [beside('s1', 'n2')])
    expect(tabsOf(terminals)).toEqual([['s1'], ['n2', 's2', 's3']])
    // Then s2 closes.
    changed(sessions('s1', 'n2', 's3'), [beside('s1', 'n2')])
    expect(tabsOf(terminals)).toEqual([['s1'], ['n2', 's3']])
  })

  it('goes into a new group on the side main split it off, also before the terminal it was split from', async () => {
    const terminals = await load(sessions('s1', 's2'), [])
    expect(tabsOf(terminals)).toEqual([['s1', 's2']])
    const own = terminals.groupOf('s1')!.id
    // Split off below s2.
    changed(sessions('s1', 's2', 'n1'), [beside('s2', 'n1', 'column')])
    const below = terminals.groupOf('n1')!.id
    expect(terminals.workspace.layout).toEqual({ direction: 'column', ratio: 0.5, first: own, second: below })
    // Main put n2 first, on the left of s1.
    changed(sessions('s1', 's2', 'n1', 'n2'), [beside('s2', 'n1', 'column'), beside('n2', 's1')])
    const left = terminals.groupOf('n2')!.id
    expect(tabsOf(terminals)).toEqual([['n2'], ['s1', 's2'], ['n1']])
    expect(terminals.workspace.layout).toEqual({
      direction: 'column',
      ratio: 0.5,
      first: { direction: 'row', ratio: 0.5, first: left, second: own },
      second: below,
    })
  })

  it('goes right before the open terminal main lists after it, not after the shown tab', async () => {
    const terminals = await load(sessions('s1', 's2'), [])
    terminals.activate('s2')
    changed(sessions('s1', 'n1', 's2'), [])
    expect(tabsOf(terminals)).toEqual([['s1', 'n1', 's2']])
  })
})

describe('the keyboard when its terminal closes by itself', () => {
  it('goes to the tab that takes its place, at the end to the one before, and to none without tabs', async () => {
    const terminals = await load(sessions('s1', 's2', 's3'), [], undefined, 'top')
    terminals.activate('s2')
    changed(sessions('s1', 's3'), [])
    expect(terminals.activeId).toBe('s3')
    changed(sessions('s1'), [])
    expect(terminals.activeId).toBe('s1')
    changed([], [])
    expect(terminals.activeId).toBeNull()
  })

  it('stays in its tab with the part that had it last, wherever that tab now is in the tab bar', async () => {
    // The parts of a split tab may lie apart in main's order: the tab sits where its first one is.
    const terminals = await load(sessions('a', 's1', 'b', 's2', 's3'), [beside('s1', beside('s2', 's3', 'column'))], undefined, 'top')
    expect(tabBar(terminals)).toEqual([['a'], ['s1', 's2', 's3'], ['b']])
    terminals.activate('s2')
    terminals.activate('s3')
    terminals.activate('s1')
    changed(sessions('a', 'b', 's2', 's3'), [beside('s2', 's3', 'column')])
    expect(tabBar(terminals)).toEqual([['a'], ['b'], ['s2', 's3']])
    expect(terminals.activeId).toBe('s3')
  })

  it('goes to the last tab when no terminal had it', async () => {
    const terminals = await load([], [], undefined, 'top')
    expect(terminals.activeId).toBeNull()
    changed(sessions('s1', 's2'), [])
    expect(terminals.activeId).toBe('s2')
  })

  it('in groups goes to the terminal on screen that had it last while a page is in front', async () => {
    const saved: Workspace = {
      layout: beside('g1', beside('g2', 'g3')),
      groups: [
        { id: 'g1', tabs: ['s1'], active: 's1' },
        { id: 'g2', tabs: ['s2'], active: 's2' },
        { id: 'g3', tabs: ['s3'], active: 's3' },
      ],
      activeGroup: 'g1',
    }
    const order = ['s1', 's2', 's3'].map((id) => ({ id, mode: 'session' as const }))
    const terminals = await load(sessions('s1', 's2', 's3'), [], { workspace: saved, order })
    terminals.activate('s2')
    terminals.activate('s1')
    terminals.activate('s3')
    // The settings cover s1, which had the keyboard after s2.
    terminals.openPage('settings')
    expect(tabsOf(terminals)).toEqual([['s1', 'page:settings'], ['s2'], ['s3']])
    expect(terminals.activeId).toBe('s3')
    changed(sessions('s1', 's2'), [])
    expect(tabsOf(terminals)).toEqual([['s1', 'page:settings'], ['s2']])
    expect(terminals.focusedTab).toBe('page:settings')
    expect(terminals.activeId).toBe('s2')
  })
})

describe('docking a tab in one tab bar', () => {
  it('puts it on the side of a terminal of another tab, where that tab is, with the keyboard', async () => {
    const terminals = await load(sessions('s1', 's2', 's3'), [], undefined, 'top')
    terminals.activate('s2')
    terminals.dock('s3', 's1', 'up')
    const layout = beside('s3', 's1', 'column')
    // Shown right away, before main answers.
    expect(tabBar(terminals)).toEqual([['s3', 's1'], ['s2']])
    expect(terminals.tabOf('s1')!.layout).toEqual(layout)
    expect(terminals.activeId).toBe('s3')
    expect(api.terminals.arrange).toHaveBeenCalledWith(layout)
    expect(api.terminals.reorder).toHaveBeenCalledWith(['s1', 's3', 's2'])
  })

  it('moves every part of a split tab, and gives the keyboard to the part that had it last', async () => {
    const terminals = await load(sessions('s1', 's2', 's3'), [beside('s1', 's2')], undefined, 'top')
    terminals.activate('s1')
    terminals.activate('s2')
    terminals.activate('s3')
    terminals.dock('s1', 's3', 'right')
    expect(tabBar(terminals)).toEqual([['s3', 's1', 's2']])
    expect(terminals.tabOf('s3')!.layout).toEqual(beside('s3', beside('s1', 's2')))
    expect(terminals.activeId).toBe('s2')
  })

  it('refuses the tab itself and a tree deeper than main takes, but not a part higher up', async () => {
    // 16 splits one inside the other: t16 lies as deep as main takes.
    const ids = Array.from({ length: 17 }, (_, i) => `t${i}`)
    const chain = ids.slice(0, -1).reduceRight<string | PaneSplit>((rest, id) => beside(id, rest), ids.at(-1)!) as PaneSplit
    const terminals = await load([...sessions(...ids), terminal('x')], [chain], undefined, 'top')
    expect(terminals.tabs.map((t) => t.id)).toEqual(['t0', 'x'])
    expect(terminals.dockLayout('t0', 't5', 'right')).toBeNull()
    expect(terminals.dockLayout('nope', 't5', 'right')).toBeNull()
    terminals.dock('x', 't16', 'right')
    expect(terminals.tabs.map((t) => t.id)).toEqual(['t0', 'x'])
    expect(api.terminals.arrange).not.toHaveBeenCalled()
    terminals.dock('x', 't0', 'right')
    expect(terminals.tabs.map((t) => t.id)).toEqual(['t0'])
    expect(api.terminals.arrange).toHaveBeenCalledOnce()
  })
})

describe('detaching a part of a split tab', () => {
  it('gives it a tab of its own right after its old tab, with the keyboard, and shrinks the split at once', async () => {
    const terminals = await load(sessions('s1', 's2', 's3', 's4'), [beside('s1', beside('s2', 's3', 'column'))], undefined, 'top')
    terminals.detach('s2')
    expect(tabBar(terminals)).toEqual([['s1', 's3'], ['s2'], ['s4']])
    expect(terminals.activeId).toBe('s2')
    expect(api.terminals.arrange).toHaveBeenLastCalledWith(beside('s1', 's3'))
    expect(api.terminals.reorder).toHaveBeenLastCalledWith(['s1', 's3', 's2', 's4'])
    // The last but one part: the other one is alone in its tab then, which main is told too.
    terminals.detach('s3')
    expect(tabBar(terminals)).toEqual([['s1'], ['s3'], ['s2'], ['s4']])
    expect(api.terminals.arrange).toHaveBeenLastCalledWith('s1')
  })

  it('stays in its own tab when main then reports it unchanged, without its split', async () => {
    const terminals = await load([terminal('s1'), terminal('b1', 'browser'), terminal('s2')], [beside('s1', 'b1')], undefined, 'top')
    terminals.detach('b1')
    expect(tabBar(terminals)).toEqual([['s1'], ['b1'], ['s2']])
    // Main has the same b1: the store keeps its old object, the list from main has a new one.
    changed([terminal('s1'), terminal('b1', 'browser'), terminal('s2')], [])
    expect(tabBar(terminals)).toEqual([['s1'], ['b1'], ['s2']])
    // The groups behind it, which the tabs in groups show, have it in the same place. (The browser tab
    // is there since b1 was s1's page in their split.)
    expect(tabsOf(terminals)).toEqual([['s1', 'b1', 's2'], [BROWSER_TAB]])
  })

  it('leaves a terminal alone in its tab as it is', async () => {
    const terminals = await load(sessions('s1', 's2'), [], undefined, 'top')
    terminals.activate('s1')
    terminals.detach('s2')
    expect(tabBar(terminals)).toEqual([['s1'], ['s2']])
    expect(terminals.activeId).toBe('s1')
    expect(api.terminals.arrange).not.toHaveBeenCalled()
    expect(api.terminals.reorder).not.toHaveBeenCalled()
  })
})

describe('resizing a split tab', () => {
  it('keeps every share between 5 and 95 percent, also inside a split, and leaves the other tabs as they are', async () => {
    const terminals = await load(
      sessions('s1', 's2', 's3', 's4', 's5'),
      [beside('s1', beside('s2', 's3', 'column')), beside('s4', 's5')],
      undefined,
      'top',
    )
    const tab = terminals.tabOf('s1')!.id
    terminals.resize(tab, ['second'], 0.99, true)
    const inner = beside('s1', { ...beside('s2', 's3', 'column'), ratio: 0.95 })
    expect(terminals.tabOf('s1')!.layout).toEqual(inner)
    expect(api.terminals.arrange).toHaveBeenLastCalledWith(inner)
    terminals.resize(tab, [], -1, true)
    expect(terminals.tabOf('s1')!.layout).toEqual({ ...inner, ratio: 0.05 })
    expect(api.terminals.arrange).toHaveBeenLastCalledWith({ ...inner, ratio: 0.05 })
    expect(terminals.tabOf('s4')!.layout).toEqual(beside('s4', 's5'))
  })

  it('ignores a tab without a split, and one that is gone', async () => {
    const terminals = await load(sessions('s1', 's2'), [], undefined, 'top')
    terminals.resize('s1', [], 0.3, true)
    terminals.resize('nope', [], 0.3, true)
    expect(tabBar(terminals)).toEqual([['s1'], ['s2']])
    expect(terminals.tabOf('s1')!.layout).toBe('s1')
    expect(api.terminals.arrange).not.toHaveBeenCalled()
  })
})

describe('the groups of the last run, restored', () => {
  const saved: Workspace = {
    layout: beside('g1', 'g2'),
    groups: [
      { id: 'g1', tabs: ['s1', 'page:settings'], active: 's1' },
      { id: 'g2', tabs: ['s2'], active: 's2' },
    ],
    activeGroup: 'g1',
  }

  it('find their terminals by their order when main names no old ids, leaving logins out', async () => {
    const order = [
      { id: 's1', mode: 'session' as const },
      { id: 'l1', mode: 'login' as const },
      { id: 's2', mode: 'session' as const },
    ]
    const terminals = await load(sessions('n1', 'n2'), [], { workspace: saved, order })
    expect(tabsOf(terminals)).toEqual([['n1', 'page:settings'], ['n2']])
    expect(terminals.restoredIds).toEqual(new Map([['s1', 'n1'], ['s2', 'n2']]))
  })

  it('keep only their pages when the order does not tell which terminal is which', async () => {
    // A session in the place of a browser can't be the terminal of the last run.
    const order = [
      { id: 's1', mode: 'session' as const },
      { id: 's2', mode: 'browser' as const },
    ]
    const terminals = await load(sessions('n1', 'n2'), [], { workspace: saved, order })
    const [group, ...others] = tabsOf(terminals)
    expect(others).toEqual([])
    expect(group[0]).toBe('page:settings')
    expect(group.slice(1).sort()).toEqual(['n1', 'n2'])
    expect(terminals.restoredIds).toEqual(new Map())
  })

  it('start afresh from a saved layout that can’t be read', async () => {
    const order = [{ id: 's1', mode: 'session' }]
    const broken = [
      '{"workspace":',
      JSON.stringify({ workspace: { layout: 42, groups: [] }, order }),
      // A group the layout doesn't name.
      JSON.stringify({ workspace: { layout: 'g1', groups: [{ id: 'g2', tabs: ['page:settings', 's1'], active: 's1' }] }, order }),
      JSON.stringify({ workspace: createWorkspace('g1', ['page:settings', 's1']), order: 'x' }),
    ]
    for (const raw of broken) {
      setActivePinia(createPinia())
      storage.set('claude-manager.workspace', raw)
      const terminals = await load(sessions('s1', 's2'), [])
      expect(tabsOf(terminals), raw).toEqual([['s1', 's2']])
      expect(terminals.restoredIds, raw).toEqual(new Map())
    }
  })

  it('give the keyboard back in one tab bar to the terminal that had it, under its new id', async () => {
    const order = ['s1', 's2', 's3'].map((id) => ({ id, mode: 'session' as const }))
    const workspace = createWorkspace('g1', ['s1', 's2', 's3'])
    const list = ['1', '2', '3'].map((n) => ({ ...terminal(`n${n}`), restoredFrom: `s${n}` }))
    const terminals = await load(list, [], { workspace, order, active: 's2' }, 'top')
    expect(terminals.activeId).toBe('n2')
  })
})
