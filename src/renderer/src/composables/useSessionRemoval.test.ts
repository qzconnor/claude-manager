import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { toast } from 'vue-sonner'
import type { SessionRef, SessionRemoveResult, SessionSummary, TerminalInfo } from '@shared/types'

vi.mock('vue-sonner', () => ({ toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() } }))

function session(id: string, accountId = 'a', sizeBytes = 1024): SessionSummary {
  return {
    id,
    accountId,
    projectKey: 'C--dev',
    cwd: 'C:\\dev',
    worktree: null,
    title: `Titel ${id}`,
    name: null,
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
    // Unless a test says otherwise, everything asked for is removed.
    remove: vi.fn(async (asked: SessionRef[]) => outcome({ removed: asked, removedBytes: asked.length * 1024 })),
  },
}

/** The removal with these tabs open, and a counted question answered with `answer`. */
async function setup(tabs: TerminalInfo[] = [], answer = true) {
  open = tabs
  const { useTerminalsStore } = await import('@/stores/terminals')
  const { useSessionsStore } = await import('@/stores/sessions')
  const { useUiStore } = await import('@/stores/ui')
  const { useSessionRemoval } = await import('./useSessionRemoval')
  await useTerminalsStore().load()
  const confirm = vi.spyOn(useUiStore(), 'confirm').mockResolvedValue(answer)
  return { confirm, sessions: useSessionsStore(), removal: useSessionRemoval() }
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

describe('removing sessions', () => {
  it('asks before moving a session to the recycle bin, naming it and its size', async () => {
    const { confirm, removal } = await setup()
    const one = session('x', 'a', 2048)
    api.sessions.remove.mockResolvedValueOnce(outcome({ removed: refs(one), removedBytes: 2048 }))
    await expect(removal.remove([one])).resolves.toBe(true)
    expect(confirm).toHaveBeenCalledWith({
      title: 'Session löschen?',
      description:
        '„Titel x“ kommt mit Verlauf, Subagents und /rewind-Ständen in den Papierkorb (2 KB). Fortsetzen lässt sich eine Session erst wieder, wenn du sie dort wiederherstellst.',
      confirmText: 'In den Papierkorb',
      destructive: true,
    })
    expect(api.sessions.remove).toHaveBeenCalledWith(refs(one))
    expect(toast.success).toHaveBeenCalledWith('Session gelöscht', { description: '2 KB im Papierkorb' })
    expect(toast.error).not.toHaveBeenCalled()
  })

  it('asks once for several sessions with their total size, and counts those deleted', async () => {
    const { confirm, removal } = await setup()
    const list = [session('x', 'a', 1024), session('y', 'b', 2048)]
    await expect(removal.remove(list)).resolves.toBe(true)
    expect(confirm).toHaveBeenCalledOnce()
    expect(confirm.mock.calls[0][0].title).toBe('2 Sessions löschen?')
    expect(confirm.mock.calls[0][0].description).toContain('Die Verläufe kommen mit Subagents und /rewind-Ständen in den Papierkorb (3 KB).')
    expect(api.sessions.remove).toHaveBeenCalledWith(refs(...list))
    expect(toast.success).toHaveBeenCalledWith('2 Sessions gelöscht', { description: '2 KB im Papierkorb' })
  })

  it('deletes nothing when the question is declined', async () => {
    const { removal } = await setup([], false)
    await expect(removal.remove([session('x')])).resolves.toBe(false)
    expect(api.sessions.remove).not.toHaveBeenCalled()
    expect(toast.success).not.toHaveBeenCalled()
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
    expect(api.sessions.remove).toHaveBeenCalledWith(refs(session('z'), session('x', 'b')))
  })

  it('names the one session that stays in a tab', async () => {
    const { confirm, removal } = await setup([tab('t1', { sessionId: 'x' })])
    await removal.remove([session('x'), session('z')])
    expect(confirm.mock.calls[0][0].title).toBe('Session löschen?')
    expect(confirm.mock.calls[0][0].description).toContain('„Titel z“')
    expect(confirm.mock.calls[0][0].description).toContain('1 Session ist in einem Tab offen und bleibt.')
    expect(api.sessions.remove).toHaveBeenCalledWith(refs(session('z')))
  })

  it('asks nothing when every session is open in a tab, and says why', async () => {
    const { confirm, removal } = await setup([tab('t1', { sessionId: 'x' }), tab('t2', { sessionId: 'y' })])
    await expect(removal.remove([session('x')])).resolves.toBe(false)
    const why = { description: 'Schließe den Tab zuerst, dann lässt sie sich löschen.' }
    expect(toast.info).toHaveBeenLastCalledWith('Die Session ist in einem Tab offen', why)
    await expect(removal.remove([session('x'), session('y')])).resolves.toBe(false)
    expect(toast.info).toHaveBeenLastCalledWith('Die Sessions sind in Tabs offen', why)
    expect(confirm).not.toHaveBeenCalled()
    expect(api.sessions.remove).not.toHaveBeenCalled()
  })

  it('does nothing without sessions, nor while sessions are being removed', async () => {
    const { confirm, sessions, removal } = await setup()
    await expect(removal.remove([])).resolves.toBe(false)
    sessions.removing = true
    await expect(removal.remove([session('x')])).resolves.toBe(false)
    expect(confirm).not.toHaveBeenCalled()
    expect(api.sessions.remove).not.toHaveBeenCalled()
    expect(toast.info).not.toHaveBeenCalled()
  })
})

describe('what removing sessions reports', () => {
  it('names the sessions still running in Claude Code beside those deleted', async () => {
    const { removal } = await setup()
    const [x, y, z] = [session('x'), session('y'), session('z')]
    api.sessions.remove.mockResolvedValueOnce(outcome({ removed: refs(x), removedBytes: 1024, inUse: refs(y, z) }))
    await expect(removal.remove([x, y, z])).resolves.toBe(true)
    expect(toast.success).toHaveBeenCalledWith('Session gelöscht', {
      description: '1 KB im Papierkorb · 2 Sessions laufen gerade in Claude Code und bleiben',
    })
    expect(toast.info).not.toHaveBeenCalled()
  })

  it('says so when every session still runs in Claude Code, and nothing was deleted', async () => {
    const { removal } = await setup()
    const [x, y] = [session('x'), session('y')]
    api.sessions.remove.mockResolvedValueOnce(outcome({ inUse: refs(x, y) }))
    await expect(removal.remove([x, y])).resolves.toBe(false)
    expect(toast.info).toHaveBeenCalledWith('Die Sessions laufen gerade in Claude Code', {
      description: 'Beende Claude Code dort, dann lässt sie sich löschen.',
    })
    api.sessions.remove.mockResolvedValueOnce(outcome({ inUse: refs(x) }))
    await expect(removal.remove([x])).resolves.toBe(false)
    expect(toast.info).toHaveBeenLastCalledWith('Die Session läuft gerade in Claude Code', expect.anything())
    expect(toast.success).not.toHaveBeenCalled()
  })

  it('names the sessions that could not be moved and why, beside those deleted', async () => {
    const { removal } = await setup()
    const [x, y, z] = [session('x'), session('y'), session('z')]
    api.sessions.remove.mockResolvedValueOnce(outcome({ removed: refs(x), removedBytes: 1024, failed: refs(y, z), error: 'Datei gesperrt' }))
    await expect(removal.remove([x, y, z])).resolves.toBe(true)
    expect(toast.success).toHaveBeenCalledWith('Session gelöscht', { description: '1 KB im Papierkorb' })
    expect(toast.error).toHaveBeenCalledWith('2 Sessions nicht gelöscht', { description: 'Datei gesperrt' })
  })

  it('is no success when none could be moved, also without a reason', async () => {
    const { removal } = await setup()
    api.sessions.remove.mockResolvedValueOnce(outcome({ failed: refs(session('x')) }))
    await expect(removal.remove([session('x')])).resolves.toBe(false)
    expect(toast.error).toHaveBeenCalledWith('1 Session nicht gelöscht', { description: undefined })
    expect(toast.success).not.toHaveBeenCalled()
  })

  it('shows why main could not remove them, without Electron’s prefix, and is ready for the next try', async () => {
    const { sessions, removal } = await setup()
    api.sessions.remove.mockRejectedValueOnce(new Error("Error invoking remote method 'sessions:remove': Error: Kein Zugriff"))
    await expect(removal.remove([session('x')])).resolves.toBe(false)
    expect(toast.error).toHaveBeenCalledWith('Sessions konnten nicht gelöscht werden', { description: 'Kein Zugriff' })
    expect(sessions.removing).toBe(false)
    await expect(removal.remove([session('x')])).resolves.toBe(true)
  })
})
