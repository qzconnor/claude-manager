import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'
import type { FileTouch, PaneSplit, TerminalInfo } from '@shared/types'

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
