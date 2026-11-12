import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { toast } from 'vue-sonner'
import type { SessionRef, SessionRemoveResult, SessionSummary, TerminalInfo } from '@shared/types'

vi.mock('vue-sonner', () => ({ toast: Object.assign(vi.fn(), { info: vi.fn(), success: vi.fn(), error: vi.fn() }) }))

function session(id: string, accountId = 'a', sizeBytes = 1024): SessionSummary {
  return {
    id,
    accountId,
    projectKey: 'C--dev',
    cwd: 'C:\\dev',
    worktree: null,
    title: `Titel ${id}`,
    name: null,
    pinned: false,
    tags: [],
    firstPrompt: null,
    lastPrompt: null,
    gitBranch: null,
    model: null,
    messageCount: 1,
    messageCountExact: true,
    createdAt: '2026-11-01T10:00:00.000Z',
    updatedAt: '2026-11-01T10:00:00.000Z',
    sizeBytes,
    version: null,
  }
}

/** A tab with a session: running (`sessionId`) or one it can resume (`resumeSessionId`). */
function tab(id: string, ids: { sessionId?: string; resumeSessionId?: string }, accountId = 'a'): TerminalInfo {
  return {
    id,
    accountId,
    authAccountId: accountId,
    sessionId: ids.sessionId ?? null,
    limit: null,
    resume: null,
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
    resumeSessionId: ids.resumeSessionId ?? null,
    args: [],
    status: 'running',
    sleep: null,
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

const refs = (...list: SessionSummary[]): SessionRef[] => list.map((s) => ({ accountId: s.accountId, sessionId: s.id }))

/** An answer of main with only what the test names in it. */
const outcome = (result: Partial<SessionRemoveResult>): SessionRemoveResult => ({
  removed: [],
  removedBytes: 0,
  inUse: [],
  failed: [],
  error: null,
  ...result,
})

let open: TerminalInfo[]
/** What main lists per account. */
let stored: Record<string, SessionSummary[]>
const api = {
  platform: 'win32',
  settings: { onChanged: () => () => {} },
  app: { onQuitting: () => () => {} },
  terminals: {
    list: vi.fn(async () => open),
    layouts: vi.fn(async () => []),
    onChanged: () => () => {},
    onReplaced: () => () => {},
  },
  sessions: {
    onChanged: () => () => {},
    list: vi.fn(async (accountId?: string) =>
      Object.entries(stored)
        .filter(([id]) => accountId === undefined || id === accountId)
        .map(([id, sessions]) => ({ accountId: id, sessions, error: null })),
    ),
    // Unless a test says otherwise, everything asked for is removed.
    remove: vi.fn(async (asked: SessionRef[]) => outcome({ removed: asked, removedBytes: asked.length * 1024 })),
  },
}

type ToastOptions = {
  description?: string
  duration?: number
  action: { label: string; onClick: () => void }
  onAutoClose: () => void
  onDismiss: () => void
}

/** The toast that offers „Rückgängig“, the latest one. */
function undoToast(): { title: string; options: ToastOptions } {
  const call = vi.mocked(toast).mock.calls.at(-1)!
  return { title: call[0] as string, options: call[1] as unknown as ToastOptions }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

/** The removal with these tabs open and these sessions listed, and a counted question answered with `answer`. */
async function setup(tabs: TerminalInfo[] = [], answer = true, listed: SessionSummary[] = []) {
  open = tabs
  stored = {}
  for (const s of listed) stored[s.accountId] = [...(stored[s.accountId] ?? []), s]
  const { useTerminalsStore } = await import('@/stores/terminals')
  const { useSessionsStore } = await import('@/stores/sessions')
  const { useUiStore } = await import('@/stores/ui')
  const { useSessionRemoval } = await import('./useSessionRemoval')
  await useTerminalsStore().load()
  const sessions = useSessionsStore()
  await sessions.load()
  const confirm = vi.spyOn(useUiStore(), 'confirm').mockResolvedValue(answer)
  return { confirm, sessions, removal: useSessionRemoval() }
}

const ids = (sessions: { groups: { sessions: SessionSummary[] }[] }) => sessions.groups.flatMap((g) => g.sessions.map((s) => s.id))

beforeEach(() => {
  vi.stubGlobal('window', { api })
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => undefined, removeItem: () => undefined })
  setActivePinia(createPinia())
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

describe('removing sessions', () => {
  it('takes one session out of the lists at once, without asking, and to the recycle bin once its toast is gone', async () => {
    const one = session('x', 'a', 2048)
    const { confirm, sessions, removal } = await setup([], true, [one, session('y')])
    await expect(removal.remove([one])).resolves.toBe(true)
    expect(confirm).not.toHaveBeenCalled()
    expect(ids(sessions)).toEqual(['y'])
    const { title, options } = undoToast()
    expect(title).toBe('Session gelöscht')
    expect(options).toMatchObject({
      description: '„Titel x“ kommt in den Papierkorb (2 KB).',
      duration: 8000,
      action: { label: 'Rückgängig' },
    })
    expect(api.sessions.remove).not.toHaveBeenCalled()
    // Main lists it until it is gone: the list doesn't take it back meanwhile.
    await sessions.reloadAccount('a')
    expect(ids(sessions)).toEqual(['y'])
    options.onAutoClose()
    // Closed, the toast is dismissed too: once is enough.
    options.onDismiss()
    await settle()
    expect(api.sessions.remove).toHaveBeenCalledExactlyOnceWith(refs(one))
    expect(toast.error).not.toHaveBeenCalled()
    expect(toast.info).not.toHaveBeenCalled()
  })

  it('also deletes when the toast is closed early', async () => {
    const { removal } = await setup([], true, [session('x')])
    await removal.remove([session('x')])
    undoToast().options.onDismiss()
    await settle()
    expect(api.sessions.remove).toHaveBeenCalledExactlyOnceWith(refs(session('x')))
  })

  it('brings the sessions back with „Rückgängig“ and deletes nothing', async () => {
    const { sessions, removal } = await setup([], true, [session('x'), session('y')])
    await removal.remove([session('x'), session('y')])
    expect(ids(sessions)).toEqual([])
    const { options } = undoToast()
    options.action.onClick()
    options.onDismiss()
    await settle()
    expect(ids(sessions)).toEqual(['x', 'y'])
    expect(api.sessions.remove).not.toHaveBeenCalled()
  })

  it('asks once for several sessions with their total size', async () => {
    const list = [session('x', 'a', 1024), session('y', 'b', 2048)]
    const { confirm, removal } = await setup([], true, list)
    await expect(removal.remove(list)).resolves.toBe(true)
    expect(confirm).toHaveBeenCalledWith({
      title: '2 Sessions löschen?',
      description: 'Die Verläufe kommen mit Subagents und /rewind-Ständen in den Papierkorb (3 KB).',
      confirmText: 'In den Papierkorb',
      destructive: true,
    })
    const { title, options } = undoToast()
    expect(title).toBe('2 Sessions gelöscht')
    expect(options.description).toBe('3 KB kommen in den Papierkorb.')
    options.onAutoClose()
    await settle()
    expect(api.sessions.remove).toHaveBeenCalledWith(refs(...list))
  })

  it('deletes nothing when the question is declined', async () => {
    const { sessions, removal } = await setup([], false, [session('x'), session('y')])
    await expect(removal.remove([session('x'), session('y')])).resolves.toBe(false)
    expect(ids(sessions)).toEqual(['x', 'y'])
    expect(toast).not.toHaveBeenCalled()
    expect(api.sessions.remove).not.toHaveBeenCalled()
  })

  it('leaves sessions open in a tab, also those a tab can resume, and says they stay', async () => {
    const { confirm, removal } = await setup([tab('t1', { sessionId: 'x' }), tab('t2', { resumeSessionId: 'y' })])
    // The same session id of another account is another session.
    const list = [session('x'), session('y'), session('z'), session('x', 'b')]
    await removal.remove(list)
    expect(confirm.mock.calls[0][0].title).toBe('2 Sessions löschen?')
    // The size counts only those that go.
    expect(confirm.mock.calls[0][0].description).toContain('in den Papierkorb (2 KB).')
    expect(confirm.mock.calls[0][0].description).toContain('2 Sessions sind in einem Tab offen und bleiben.')
    expect(undoToast().options.description).toBe('2 KB kommen in den Papierkorb. 2 Sessions sind in einem Tab offen und bleiben.')
    undoToast().options.onAutoClose()
    await settle()
    expect(api.sessions.remove).toHaveBeenCalledWith(refs(session('z'), session('x', 'b')))
  })

  it('names the one session that stays in a tab', async () => {
    const { confirm, removal } = await setup([tab('t1', { sessionId: 'x' })])
    await removal.remove([session('x'), session('z')])
    expect(confirm.mock.calls[0][0].title).toBe('Session löschen?')
    expect(confirm.mock.calls[0][0].description).toContain('„Titel z“')
    expect(confirm.mock.calls[0][0].description).toContain('1 Session ist in einem Tab offen und bleibt.')
    expect(undoToast().title).toBe('Session gelöscht')
  })

  it('asks nothing when every session is open in a tab, and says why', async () => {
    const { confirm, removal } = await setup([tab('t1', { sessionId: 'x' }), tab('t2', { sessionId: 'y' })])
    await expect(removal.remove([session('x')])).resolves.toBe(false)
    const why = { description: 'Schließe den Tab zuerst, dann lässt sie sich löschen.' }
    expect(toast.info).toHaveBeenLastCalledWith('Die Session ist in einem Tab offen', why)
    await expect(removal.remove([session('x'), session('y')])).resolves.toBe(false)
    expect(toast.info).toHaveBeenLastCalledWith('Die Sessions sind in Tabs offen', why)
    expect(confirm).not.toHaveBeenCalled()
    expect(toast).not.toHaveBeenCalled()
  })

  it('does nothing without sessions', async () => {
    const { confirm, removal } = await setup()
    await expect(removal.remove([])).resolves.toBe(false)
    expect(confirm).not.toHaveBeenCalled()
    expect(toast).not.toHaveBeenCalled()
    expect(toast.info).not.toHaveBeenCalled()
  })
})

describe('what deleting sessions reports', () => {
  async function deleted(list: SessionSummary[], result: SessionRemoveResult | Error) {
    const setupResult = await setup([], true, list)
    if (result instanceof Error) api.sessions.remove.mockRejectedValueOnce(result)
    else api.sessions.remove.mockResolvedValueOnce(result)
    await setupResult.removal.remove(list)
    // Main lists what it deleted no more.
    const gone = new Set(result instanceof Error ? [] : result.removed.map((r) => r.sessionId))
    stored = Object.fromEntries(Object.entries(stored).map(([id, sessions]) => [id, sessions.filter((s) => !gone.has(s.id))]))
    undoToast().options.onAutoClose()
    await settle()
    return setupResult
  }

  it('brings back the sessions still running in Claude Code and says so', async () => {
    const [x, y, z] = [session('x'), session('y'), session('z')]
    const { sessions } = await deleted([x, y, z], outcome({ removed: refs(x), removedBytes: 1024, inUse: refs(y, z) }))
    expect(toast.info).toHaveBeenCalledWith('2 Sessions laufen gerade in Claude Code und bleiben', {
      description: 'Beende Claude Code dort, dann lässt sie sich löschen.',
    })
    expect(ids(sessions)).toEqual(['y', 'z'])
  })

  it('names one session still running in Claude Code', async () => {
    await deleted([session('x')], outcome({ inUse: refs(session('x')) }))
    expect(toast.info).toHaveBeenCalledWith('Eine Session läuft gerade in Claude Code und bleibt', expect.anything())
  })

  it('names the sessions that could not be moved and why, and brings them back', async () => {
    const [x, y, z] = [session('x'), session('y'), session('z')]
    const { sessions } = await deleted(
      [x, y, z],
      outcome({ removed: refs(x), removedBytes: 1024, failed: refs(y, z), error: 'Datei gesperrt' }),
    )
    expect(toast.error).toHaveBeenCalledWith('2 Sessions nicht gelöscht', { description: 'Datei gesperrt' })
    expect(ids(sessions)).toEqual(['y', 'z'])
  })

  it('shows why main could not remove them, without Electron’s prefix, brings them back and is ready for the next try', async () => {
    const { sessions, removal } = await deleted(
      [session('x')],
      new Error("Error invoking remote method 'sessions:remove': Error: Kein Zugriff"),
    )
    expect(toast.error).toHaveBeenCalledWith('Sessions konnten nicht gelöscht werden', { description: 'Kein Zugriff' })
    expect(sessions.removing).toBe(false)
    expect(ids(sessions)).toEqual(['x'])
    await expect(removal.remove([session('x')])).resolves.toBe(true)
  })
})
