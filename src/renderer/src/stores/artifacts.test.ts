import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Artifact, ArtifactList, SessionSearchHit } from '@shared/types'
import { useArtifactsStore } from './artifacts'

function artifact(id: string, patch: Partial<Artifact> = {}): Artifact {
  return {
    id,
    url: `https://claude.ai/code/artifact/${id}`,
    title: id,
    description: null,
    label: null,
    kind: 'page',
    mine: true,
    renamable: true,
    ownerEmail: null,
    external: false,
    audience: 'owner',
    createdAt: null,
    updatedAt: null,
    lastViewedAt: null,
    views: null,
    pinned: false,
    ...patch,
  }
}

const listOf = (...artifacts: Artifact[]): ArtifactList => ({
  accountId: 'a1',
  status: 'ok',
  message: null,
  artifacts,
  pinsEnabled: true,
  truncated: false,
  fetchedAt: '2026-11-12T10:00:00Z',
})

const hit = (sessionId: string): SessionSearchHit => ({ accountId: 'a1', sessionId, role: 'assistant', snippet: '', matches: 1 })

const api = {
  artifacts: {
    list: vi.fn<(accountId: string) => Promise<ArtifactList>>(),
    thumbnail: vi.fn<(accountId: string, id: string, dark: boolean) => Promise<string | null>>(),
    rename: vi.fn<(accountId: string, id: string, title: string) => Promise<void>>(),
    remove: vi.fn<(accountId: string, id: string) => Promise<'deleted' | 'gone'>>(),
    setPinned: vi.fn<(accountId: string, id: string, pinned: boolean) => Promise<void>>(),
  },
  sessions: { search: vi.fn<(query: string) => Promise<SessionSearchHit[]>>() },
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

beforeEach(() => {
  vi.resetAllMocks()
  api.sessions.search.mockResolvedValue([])
  vi.stubGlobal('window', { api })
  setActivePinia(createPinia())
})

describe('artifacts store', () => {
  it('keeps the list and finds the session that names each artifact', async () => {
    api.artifacts.list.mockResolvedValue(listOf(artifact('x1'), artifact('x2')))
    api.sessions.search.mockImplementation(async (query) => (query === 'artifact/x2' ? [hit('s9')] : []))
    const store = useArtifactsStore()

    await store.load('a1')
    await flush()

    expect(store.lists.a1!.artifacts.map((a) => a.id)).toEqual(['x1', 'x2'])
    expect(api.sessions.search.mock.calls.map(([query]) => query)).toEqual(['artifact/x1', 'artifact/x2'])
    expect(store.sessionOf('a1', 'x1')).toBeNull()
    expect(store.sessionOf('a1', 'x2')).toEqual({ accountId: 'a1', sessionId: 's9' })
  })

  it('asks for a thumbnail once and forgets it with the next list', async () => {
    api.artifacts.list.mockResolvedValue(listOf(artifact('x1')))
    api.artifacts.thumbnail.mockResolvedValue('data:image/png;base64,AA')
    const store = useArtifactsStore()
    await store.load('a1')

    store.requestThumbnail('a1', 'x1', false)
    store.requestThumbnail('a1', 'x1', false)
    expect(store.thumbnailOf('a1', 'x1', false)).toBeUndefined()
    await flush()
    expect(api.artifacts.thumbnail).toHaveBeenCalledOnce()
    expect(store.thumbnailOf('a1', 'x1', false)).toBe('data:image/png;base64,AA')

    await store.load('a1')
    expect(store.thumbnailOf('a1', 'x1', false)).toBeUndefined()
  })

  it('pins at once and takes it back when claude.ai refuses', async () => {
    api.artifacts.list.mockResolvedValue(listOf(artifact('x1')))
    let refuse!: (error: Error) => void
    api.artifacts.setPinned.mockReturnValue(new Promise((_resolve, reject) => (refuse = reject)))
    const store = useArtifactsStore()
    await store.load('a1')

    const pinning = store.setPinned('a1', 'x1', true)
    expect(store.lists.a1!.artifacts[0]!.pinned).toBe(true)
    refuse(new Error('HTTP 403'))
    await expect(pinning).rejects.toThrow('HTTP 403')
    expect(store.lists.a1!.artifacts[0]!.pinned).toBe(false)
  })

  it('renames and removes in the list only after claude.ai did', async () => {
    api.artifacts.list.mockResolvedValue(listOf(artifact('x1'), artifact('x2')))
    api.artifacts.rename.mockRejectedValueOnce(new Error('nein')).mockResolvedValue(undefined)
    api.artifacts.remove.mockResolvedValue('gone')
    const store = useArtifactsStore()
    await store.load('a1')

    await expect(store.rename('a1', 'x1', 'Neu')).rejects.toThrow('nein')
    expect(store.lists.a1!.artifacts[0]!.title).toBe('x1')
    await store.rename('a1', 'x1', '  Neuer   Titel ')
    expect(store.lists.a1!.artifacts[0]!.title).toBe('Neuer Titel')

    expect(await store.remove('a1', 'x2')).toBe('gone')
    expect(store.lists.a1!.artifacts.map((a) => a.id)).toEqual(['x1'])
  })
})
