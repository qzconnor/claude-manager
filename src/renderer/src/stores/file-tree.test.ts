import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'
import type { FileTouch, PaneSplit, TerminalInfo } from '@shared/types'
import { diffTab } from '@/lib/workspace'

/** What Claude did in a tab's session: kept while the session runs, cleared by hand or by `/clear`. */

function session(id: string, sessionId: string | null): TerminalInfo {
  return {
    id,
    accountId: 'a',
    authAccountId: 'a',
    sessionId,
    limit: null,
    context: null,
    busy: false,
    attention: null,
    muted: false,
    title: id,
    fixedTitle: false,
    autoTitle: id,
    cwd: 'C:\\dev',
    mode: 'session',
    url: null,
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

let list: TerminalInfo[]
let changed: (list: TerminalInfo[], splits: PaneSplit[]) => void
let touched: (terminalId: string, touches: FileTouch[]) => void

const api = {
  platform: 'win32',
  settings: { onChanged: () => () => {} },
  app: { onQuitting: () => () => {}, info: vi.fn(async () => null) },
  window: { state: vi.fn(async () => ({ maximized: false, focused: true, fullscreen: false })), onState: () => () => {} },
  terminals: {
    list: vi.fn(async () => list),
    layouts: vi.fn(async () => []),
    onChanged: (cb: typeof changed) => {
      changed = cb
      return () => {}
    },
    onReplaced: () => () => {},
  },
  files: {
    watch: vi.fn(async () => {}),
    onChanged: () => () => {},
    onTouched: (cb: typeof touched) => {
      touched = cb
      return () => {}
    },
  },
}

async function load(terminals: TerminalInfo[]) {
  list = terminals
  const { useTerminalsStore } = await import('./terminals')
  const { useFileTreeStore } = await import('./file-tree')
  await useTerminalsStore().load()
  return useFileTreeStore()
}

/** Main reports the tabs anew, e.g. with another session in one of them. */
async function report(terminals: TerminalInfo[]) {
  list = terminals
  changed(list, [])
  await nextTick()
}

const read = (path: string): FileTouch => ({ path, kind: 'read' })

beforeEach(() => {
  vi.stubGlobal('window', { api })
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} })
  setActivePinia(createPinia())
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

describe('activity', () => {
  it('is cleared by hand, only for that tab', async () => {
    const fileTree = await load([session('s1', 'A'), session('s2', 'B')])
    touched('s1', [read('C:\\dev\\a.ts'), read('C:\\dev\\b.ts')])
    touched('s2', [read('C:\\dev\\c.ts')])
    expect(fileTree.activityOf('s1')?.size).toBe(2)
    fileTree.clearActivity('s1')
    expect(fileTree.activityOf('s1')).toBeNull()
    expect(fileTree.activityOf('s2')?.size).toBe(1)
    touched('s1', [read('C:\\dev\\d.ts')])
    expect([...fileTree.activityOf('s1')!.keys()]).toEqual(['C:\\dev\\d.ts'])
  })

  it('starts anew with another session in the tab (/clear), not with the first one it names', async () => {
    const fileTree = await load([session('s1', null), session('s2', 'B')])
    touched('s1', [read('C:\\dev\\a.ts')])
    touched('s2', [read('C:\\dev\\c.ts')])
    await report([session('s1', 'A'), session('s2', 'B')])
    expect(fileTree.activityOf('s1')?.size).toBe(1)
    await report([session('s1', 'A2'), session('s2', 'B')])
    expect(fileTree.activityOf('s1')).toBeNull()
    expect(fileTree.activityOf('s2')?.size).toBe(1)
  })
})

/** `/diff` with the tabs in groups: all changes beside the session, whose tree is beside it already. */
describe('/diff beside the session', () => {
  async function grouped() {
    const { useSettingsStore } = await import('./settings')
    useSettingsStore().settings.appearance.tabPosition = 'groups'
    const fileTree = await load([session('s1', 'A')])
    const { useTerminalsStore } = await import('./terminals')
    fileTree.setOpen('s1', true)
    return { fileTree, terminals: useTerminalsStore() }
  }
  const all = { root: 'C:\\dev', path: '' }

  it('shows the changes without the tree, which stays beside the session', async () => {
    const { fileTree, terminals } = await grouped()
    fileTree.showAllChanges('s1')
    const [own, right] = terminals.groups
    expect(right.active).toBe(diffTab(all))
    expect(fileTree.shownIn(fileTree.targetOfGroup(right)!, right)).toBe(false)
    expect(fileTree.shownIn(fileTree.targetOfGroup(own)!, own)).toBe(true)
  })

  it('gets the tree back by the group’s button, and closes it there alone', async () => {
    const { fileTree, terminals } = await grouped()
    fileTree.showAllChanges('s1')
    const target = fileTree.targetOfGroup(terminals.groups[1])!
    fileTree.toggleIn(target, terminals.groups[1])
    expect(fileTree.shownIn(target, terminals.groups[1])).toBe(true)
    // `/diff` once more leaves it as it is.
    fileTree.showAllChanges('s1')
    expect(fileTree.shownIn(target, terminals.groups[1])).toBe(true)
    fileTree.close(target, terminals.groups[1].id)
    expect(fileTree.shownIn(target, terminals.groups[1])).toBe(false)
    expect(fileTree.isOpen('s1')).toBe(true)
  })

  it('opens the session’s closed tree too when it is wanted beside the changes', async () => {
    const { fileTree, terminals } = await grouped()
    fileTree.setOpen('s1', false)
    fileTree.showAllChanges('s1')
    const target = fileTree.targetOfGroup(terminals.groups[1])!
    fileTree.toggleIn(target, terminals.groups[1])
    expect(fileTree.shownIn(target, terminals.groups[1])).toBe(true)
    expect(fileTree.isOpen('s1')).toBe(true)
  })

  it('keeps the tree beside changes opened from it, in the session’s group', async () => {
    const { fileTree, terminals } = await grouped()
    const target = fileTree.targetOf(terminals.terminals[0])!
    fileTree.showDiff(target, '', { groupId: terminals.groups[0].id, keep: true })
    expect(terminals.groups[0].active).toBe(diffTab(all))
    expect(fileTree.shownIn(fileTree.targetOfGroup(terminals.groups[0])!, terminals.groups[0])).toBe(true)
  })

  it('forgets a closed tab: opened beside again by hand, it shows the tree', async () => {
    const { fileTree, terminals } = await grouped()
    fileTree.showAllChanges('s1')
    // Shown for a moment: opened and closed at once, the store would not see it.
    await nextTick()
    terminals.closeDiff(diffTab(all))
    await nextTick()
    terminals.openDiffBeside(all, 's1')
    const right = terminals.groups[1]
    expect(fileTree.shownIn(fileTree.targetOfGroup(right)!, right)).toBe(true)
  })
})
