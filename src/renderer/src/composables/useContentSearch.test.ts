import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { effectScope, nextTick, reactive } from 'vue'
import type { ContentSearchResult } from '@shared/types'
import type { TreeModel } from '@/stores/file-tree'
import { useContentSearch } from './useContentSearch'

describe('useContentSearch', () => {
  /** Calls of `files.grep`, answered when the test wants. */
  let calls: { root: string; query: string; resolve: (result: ContentSearchResult) => void }[]

  beforeEach(() => {
    vi.useFakeTimers()
    calls = []
    vi.stubGlobal('window', {
      api: {
        files: {
          grep: (root: string, query: string) =>
            new Promise<ContentSearchResult>((resolve) => {
              calls.push({ root, query, resolve })
            }),
        },
      },
    })
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  const found = (path: string): ContentSearchResult => ({ files: [{ path, matches: [] }], matches: 1, truncated: false })

  function setup(query: string, searchContent = true) {
    const model = reactive({ root: '/repo', query, searchContent }) as unknown as TreeModel
    const scope = effectScope()
    const search = scope.run(() => useContentSearch(() => model))!
    return { model, search, scope }
  }

  it('searches the content only while asked to, and from two characters on', async () => {
    const { model, scope } = setup('a', true)
    await vi.advanceTimersByTimeAsync(300)
    expect(calls).toEqual([])
    model.searchContent = false
    model.query = 'abc'
    await nextTick()
    await vi.advanceTimersByTimeAsync(300)
    expect(calls).toEqual([])
    model.searchContent = true
    await nextTick()
    await vi.advanceTimersByTimeAsync(300)
    expect(calls.map((c) => [c.root, c.query])).toEqual([['/repo', 'abc']])
    scope.stop()
  })

  it('searches once for the last text typed in a row', async () => {
    const { model, scope } = setup('ne')
    model.query = 'net'
    await nextTick()
    await vi.advanceTimersByTimeAsync(100)
    model.query = 'netz'
    await nextTick()
    await vi.advanceTimersByTimeAsync(300)
    expect(calls.map((c) => c.query)).toEqual(['netz'])
    scope.stop()
  })

  it('drops the answer to an older text', async () => {
    const { model, search, scope } = setup('old')
    await vi.advanceTimersByTimeAsync(300)
    model.query = 'new'
    await nextTick()
    await vi.advanceTimersByTimeAsync(300)
    calls[1]!.resolve(found('new.ts'))
    await vi.advanceTimersByTimeAsync(0)
    calls[0]!.resolve(found('old.ts'))
    await vi.advanceTimersByTimeAsync(0)
    expect(search.result.value?.files[0]?.path).toBe('new.ts')
    expect(search.loading.value).toBe(false)
    scope.stop()
  })

  it('forgets the hits once the text is gone', async () => {
    const { model, search, scope } = setup('net')
    await vi.advanceTimersByTimeAsync(300)
    calls[0]!.resolve(found('a.ts'))
    await vi.advanceTimersByTimeAsync(0)
    expect(search.result.value).not.toBeNull()
    model.query = ''
    await nextTick()
    expect(search.result.value).toBeNull()
    scope.stop()
  })
})
