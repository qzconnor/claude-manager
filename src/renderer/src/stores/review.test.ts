import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TerminalInfo, TerminalMode, TerminalStatus } from '@shared/types'
import type { ReviewComment } from '@/lib/review-comments'
import { terminalBus } from '@/lib/terminal-bus'

function terminal(id: string, over: { cwd?: string; mode?: TerminalMode; status?: TerminalStatus; worktree?: string } = {}): TerminalInfo {
  return {
    id,
    accountId: 'a',
    authAccountId: 'a',
    sessionId: null,
    limit: null,
    resume: null,
    context: null,
    busy: false,
    attention: null,
    muted: false,
    title: `Titel ${id}`,
    fixedTitle: false,
    autoTitle: id,
    cwd: over.cwd ?? 'C:\\repo',
    mode: over.mode ?? 'session',
    url: null,
    resumeSessionId: null,
    args: [],
    status: over.status ?? 'running',
    sleep: null,
    exitCode: null,
    pid: 0,
    createdAt: '',
    commandLine: '',
    worktree: over.worktree ? { path: over.worktree, branch: 'b', base: null } : null,
    hooks: false,
    activity: null,
    subagents: 0,
    compacting: false,
    turn: null,
    prompt: null,
  } as TerminalInfo
}

let list: TerminalInfo[]
const api = {
  platform: 'win32',
  settings: { onChanged: () => () => {} },
  app: { onQuitting: () => () => {} },
  terminals: {
    list: vi.fn(async () => list),
    layouts: vi.fn(async () => []),
    onChanged: () => () => {},
    onReplaced: () => () => {},
    onData: () => () => {},
    onExit: () => () => {},
    reorder: vi.fn(),
    arrange: vi.fn(),
  },
}
const writeText = vi.fn(async (_text: string) => undefined)

async function setup(terminals: TerminalInfo[]) {
  list = terminals
  const { useSettingsStore } = await import('@/stores/settings')
  const { useTerminalsStore } = await import('@/stores/terminals')
  const { useReviewStore } = await import('./review')
  useSettingsStore().settings.appearance.tabPosition = 'top'
  const store = useTerminalsStore()
  await store.load()
  return { terminals: store, review: useReviewStore() }
}

const draft = (over: Partial<ReviewComment> = {}): Omit<ReviewComment, 'id'> => ({
  root: 'C:\\repo',
  path: 'src/a.ts',
  from: { side: 'new', line: 3 },
  to: { side: 'new', line: 4 },
  ref: { start: 3, end: 4, removed: null },
  text: 'Bitte anders.',
  ...over,
})

beforeEach(() => {
  vi.stubGlobal('window', { api })
  vi.stubGlobal('navigator', { clipboard: { writeText } })
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => undefined, removeItem: () => undefined })
  setActivePinia(createPinia())
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

describe('the comments', () => {
  it('are kept by folder and file until taken, and come back', async () => {
    const { review } = await setup([])
    const a = review.add(draft())
    const b = review.add(draft({ path: 'src/b.ts' }))
    review.add(draft({ root: 'C:\\other' }))
    expect(a.id).not.toBe(b.id)
    expect(review.of('C:\\repo').map((c) => c.path)).toEqual(['src/a.ts', 'src/b.ts'])
    expect(review.ofFile('C:\\repo', 'src/b.ts')).toEqual([b])

    review.update(a.id, { text: 'Neu', ref: { start: 5, end: 5, removed: null } })
    expect(review.get(a.id)).toMatchObject({ text: 'Neu', ref: { start: 5, end: 5 }, path: 'src/a.ts' })

    const taken = review.take('C:\\repo')
    expect(taken.map((c) => c.path)).toEqual(['src/a.ts', 'src/b.ts'])
    expect(review.of('C:\\repo')).toEqual([])
    expect(review.of('C:\\other')).toHaveLength(1)

    review.restore(taken)
    review.restore(taken)
    expect(review.of('C:\\repo')).toHaveLength(2)

    review.remove(b.id)
    expect(review.of('C:\\repo').map((c) => c.id)).toEqual([a.id])
  })
})

describe('targets', () => {
  it('are the Claude sessions running in the folder or its worktree, the one used last first', async () => {
    const { terminals, review } = await setup([
      terminal('s1'),
      terminal('shell', { mode: 'shell' }),
      terminal('ended', { status: 'exited' }),
      terminal('elsewhere', { cwd: 'C:\\other' }),
      terminal('tree', { cwd: 'C:\\repo\\sub', worktree: 'C:\\wt' }),
      terminal('s2'),
    ])
    terminals.activate('s2')
    expect(review.targets('C:\\repo').map((t) => t.id)).toEqual(['s2', 's1'])
    terminals.activate('s1')
    expect(review.targets('C:\\repo').map((t) => t.id)).toEqual(['s1', 's2'])
    expect(review.targets('C:\\wt').map((t) => t.id)).toEqual(['tree'])
    expect(review.targets('C:\\repo\\sub')).toEqual([])
  })
})

describe('send', () => {
  it('pastes the comments into the session, shows it, and takes them', async () => {
    const { terminals, review } = await setup([terminal('s1'), terminal('s2')])
    terminals.activate('s1')
    const pasted: string[] = []
    const off = terminalBus.onPaste('s2', (text) => pasted.push(text))
    review.add(draft())
    review.add(draft({ root: 'C:\\other' }))

    const result = await review.send('C:\\repo', 's2')
    off()
    expect(result?.pasted).toBe(true)
    expect(result?.taken).toHaveLength(1)
    expect(pasted).toEqual(['Kommentare zu den Änderungen:\n\n@src/a.ts#L3-4\nBitte anders.\n'])
    expect(terminals.activeId).toBe('s2')
    expect(writeText).not.toHaveBeenCalled()
    expect(review.of('C:\\repo')).toEqual([])
    expect(review.of('C:\\other')).toHaveLength(1)
  })

  it('copies them without a session, or when it has no view', async () => {
    const { review } = await setup([terminal('s1')])
    review.add(draft())
    const copied = await review.send('C:\\repo', null)
    expect(copied?.pasted).toBe(false)
    expect(writeText).toHaveBeenCalledWith('Kommentare zu den Änderungen:\n\n@src/a.ts#L3-4\nBitte anders.\n')

    review.add(draft())
    expect((await review.send('C:\\repo', 's1'))?.pasted).toBe(false)
    review.add(draft())
    expect((await review.send('C:\\repo', 'gone'))?.pasted).toBe(false)
    expect(writeText).toHaveBeenCalledTimes(3)
  })

  it('does nothing without comments', async () => {
    const { review } = await setup([terminal('s1')])
    expect(await review.send('C:\\repo', 's1')).toBeNull()
    expect(writeText).not.toHaveBeenCalled()
  })
})
