import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionGroup, SessionSummary } from '@shared/types'
import { useSessionsStore } from './sessions'

function session(id: string, accountId: string): SessionSummary {
  return {
    id,
    accountId,
    projectKey: 'C--dev',
    cwd: 'C:\\dev',
    worktree: null,
    title: id,
    name: null,
    firstPrompt: null,
    lastPrompt: null,
    gitBranch: null,
    model: null,
    messageCount: 1,
    messageCountExact: true,
    createdAt: '2026-11-01T10:00:00.000Z',
    updatedAt: '2026-11-01T10:00:00.000Z',
    sizeBytes: 100,
    version: null,
  }
}

const group = (accountId: string, ...ids: string[]): SessionGroup => ({
  accountId,
  sessions: ids.map((id) => session(id, accountId)),
  error: null,
})

/** Answers to `sessions.list` that the test gives when it wants, in the order it wants. */
let answers: { accountId: string | undefined; resolve: (groups: SessionGroup[]) => void }[]
let changed: (accountId: string) => void

const api = {
  sessions: {
    list: vi.fn(
      (accountId?: string) =>
        new Promise<SessionGroup[]>((resolve) => {
          answers.push({ accountId, resolve })
        }),
    ),
    onChanged: (callback: (accountId: string) => void) => {
      changed = callback
      return () => {}
    },
  },
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

beforeEach(() => {
  answers = []
  vi.stubGlobal('window', { api })
  setActivePinia(createPinia())
})

async function loaded(...initial: SessionGroup[]) {
  const store = useSessionsStore()
  const load = store.load()
  answers.shift()?.resolve(initial)
  await load
  return store
}

describe('sessions store', () => {
  it('says why loading failed, until it works again', async () => {
    const store = useSessionsStore()
    let reject: (error: Error) => void = () => {}
    api.sessions.list.mockImplementationOnce(() => new Promise((_, r) => (reject = r)))
    const failing = store.load()
    reject(new Error("Error invoking remote method 'sessions:list': Error: Der Indexer läuft nicht"))
    await failing

    expect(store).toMatchObject({ loaded: false, loading: false, error: 'Der Indexer läuft nicht' })

    const again = store.load()
    answers.shift()?.resolve([group('a', 's1')])
    await again
    expect(store).toMatchObject({ loaded: true, error: null })
  })

  it('drops the sessions of an account that was removed', async () => {
    const store = await loaded(group('a', 's1'), group('b', 's2'))

    changed('b')
    await flush()
    answers.shift()?.resolve([])
    await flush()

    expect(store.groups.map((g) => g.accountId)).toEqual(['a'])
  })

  it('adds the sessions of an account that came', async () => {
    const store = await loaded(group('a', 's1'))

    changed('b')
    await flush()
    answers.shift()?.resolve([group('b', 's2')])
    await flush()

    expect(store.groups.map((g) => g.accountId)).toEqual(['a', 'b'])
  })

  it('keeps the newer list when an older answer comes in later', async () => {
    const store = await loaded(group('a', 's1'))

    changed('a')
    await flush()
    changed('a')
    await flush()
    const [older, newer] = answers.splice(0)
    newer?.resolve([group('a', 's1', 's2', 's3')])
    await flush()
    older?.resolve([group('a', 's1', 's2')])
    await flush()

    expect(store.groups[0]?.sessions.map((s) => s.id)).toEqual(['s1', 's2', 's3'])
  })

  it('asks again after a full load under way, whose older list would replace the answer', async () => {
    const store = await loaded(group('a', 's1'))
    // A full load (the list opened again), then an account comes while it runs.
    const load = store.load()
    changed('b')
    await flush()
    expect(answers.map((a) => a.accountId)).toEqual([undefined])

    answers.shift()?.resolve([group('a', 's1')])
    await load
    await flush()
    answers.shift()?.resolve([group('b', 's2')])
    await flush()

    expect(store.groups.map((g) => g.accountId)).toEqual(['a', 'b'])
  })
})
