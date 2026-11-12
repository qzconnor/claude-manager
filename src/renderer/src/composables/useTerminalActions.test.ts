import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TerminalInfo, TerminalStatus } from '@shared/types'

function terminal(id: string, status: TerminalStatus = 'running'): TerminalInfo {
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
    cwd: 'C:\\dev',
    mode: 'session',
    url: null,
    resumeSessionId: null,
    args: [],
    status,
    exitCode: null,
    pid: 0,
    createdAt: '',
    commandLine: '',
    worktree: null,
    hooks: false,
    activity: null,
    subagents: 0,
    compacting: false,
    turn: null,
    prompt: null,
  }
}

let list: TerminalInfo[]
const close = vi.fn(async (_id: string) => undefined)
const api = {
  platform: 'win32',
  settings: { onChanged: () => () => {} },
  app: { onQuitting: () => () => {} },
  terminals: {
    list: vi.fn(async () => list),
    layouts: vi.fn(async () => []),
    onChanged: () => () => {},
    onReplaced: () => () => {},
    reorder: vi.fn(),
    arrange: vi.fn(),
    close,
  },
}

/** The terminals in one tab bar, each in a tab of its own, and the actions with a counted question. */
async function setup(terminals: TerminalInfo[], answer = true) {
  list = terminals
  const { useSettingsStore } = await import('@/stores/settings')
  const { useTerminalsStore } = await import('@/stores/terminals')
  const { useUiStore } = await import('@/stores/ui')
  const { useTerminalActions } = await import('./useTerminalActions')
  useSettingsStore().settings.appearance.tabPosition = 'top'
  const store = useTerminalsStore()
  await store.load()
  const confirm = vi.spyOn(useUiStore(), 'confirm').mockResolvedValue(answer)
  return { store, confirm, actions: useTerminalActions() }
}

beforeEach(() => {
  vi.stubGlobal('window', { api })
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => undefined, removeItem: () => undefined })
  setActivePinia(createPinia())
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

describe('closeOtherTabs', () => {
  it('asks once for all other tabs that still run, then closes them', async () => {
    const { store, confirm, actions } = await setup([terminal('a'), terminal('b'), terminal('c'), terminal('d', 'exited')])
    await actions.closeOtherTabs(store.tabs[0])
    expect(confirm).toHaveBeenCalledOnce()
    expect(confirm.mock.calls[0][0].description).toContain('2 Terminals laufen noch')
    expect(close.mock.calls.map(([id]) => id).sort()).toEqual(['b', 'c', 'd'])
  })

  it('closes nothing when the question is declined', async () => {
    const { store, actions } = await setup([terminal('a'), terminal('b'), terminal('c')], false)
    await actions.closeOtherTabs(store.tabs[0])
    expect(close).not.toHaveBeenCalled()
  })

  it('asks nothing when no other tab runs', async () => {
    const { store, confirm, actions } = await setup([terminal('a'), terminal('b', 'exited'), terminal('c', 'exited')])
    await actions.closeOtherTabs(store.tabs[0])
    expect(confirm).not.toHaveBeenCalled()
    expect(close).toHaveBeenCalledTimes(2)
  })
})
