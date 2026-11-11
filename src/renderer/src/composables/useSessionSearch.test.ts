import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick, ref } from 'vue'
import type { SessionSearchHit } from '@shared/types'
import { sessionKey, useSessionSearch } from './useSessionSearch'

describe('sessionKey', () => {
  it('tells the same session id in two accounts apart', () => {
    expect(sessionKey('a', 'session-1')).toBe('a:session-1')
    expect(sessionKey('a', 'session-1')).not.toBe(sessionKey('b', 'session-1'))
  })
})

describe('useSessionSearch', () => {
  /** Answers to `sessions.search`, given when the test wants. */
  let answers: { query: string; resolve: (hits: SessionSearchHit[]) => void; reject: (error: Error) => void }[]

  beforeEach(() => {
    answers = []
    vi.stubGlobal('window', {
      api: {
        sessions: {
          search: (query: string) =>
            new Promise<SessionSearchHit[]>((resolve, reject) => {
              answers.push({ query, resolve, reject })
            }),
        },
      },
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  const hit = (sessionId: string) => ({ accountId: 'a', sessionId }) as SessionSearchHit

  it('drops the hits of the query before as soon as the query changes', async () => {
    const query = ref('foo')
    const { hits, searching } = useSessionSearch(query)
    answers.shift()?.resolve([hit('only-foo')])
    await vi.waitFor(() => expect(hits.value.has('a:only-foo')).toBe(true))

    query.value = 'foobar'
    await nextTick()
    // Not one that matches only „foo“, while „foobar“ is being searched.
    expect(hits.value.size).toBe(0)
    expect(searching.value).toBe(true)

    answers.shift()?.resolve([hit('foobar')])
    await vi.waitFor(() => expect([...hits.value.keys()]).toEqual(['a:foobar']))
    expect(searching.value).toBe(false)
  })

  it('says why the search failed', async () => {
    const query = ref('foo')
    const { hits, error, searching } = useSessionSearch(query)
    answers.shift()?.reject(new Error("Error invoking remote method 'sessions:search': Error: Index kaputt"))
    await vi.waitFor(() => expect(error.value).toBe('Index kaputt'))
    expect([hits.value.size, searching.value]).toEqual([0, false])

    // The next query starts afresh.
    query.value = 'bar'
    await nextTick()
    expect(error.value).toBeNull()
  })
})
