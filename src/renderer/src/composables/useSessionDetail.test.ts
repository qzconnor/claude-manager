import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick, ref } from 'vue'
import { CONVERSATION_PAGE_MESSAGES } from '@shared/defaults'
import type { SessionDetail, SessionRef } from '@shared/types'
import { useSessionDetail } from './useSessionDetail'

/** A history of `total` messages, of which the newest `limit` come along. */
const answer = (total: number) =>
  vi.fn(async (accountId: string, sessionId: string, limit = CONVERSATION_PAGE_MESSAGES): Promise<SessionDetail> => {
    const count = Math.min(total, limit)
    return {
      summary: { id: sessionId, accountId } as SessionDetail['summary'],
      messages: Array.from({ length: count }, (_, i) => ({
        uuid: `${sessionId}-${total - count + i}`,
        role: 'user' as const,
        timestamp: null,
        text: 'x',
        tools: [],
        model: null,
      })),
      truncated: count < total,
      total,
    }
  })

let get: ReturnType<typeof answer>

beforeEach(() => {
  get = answer(1500)
  vi.stubGlobal('window', { api: { sessions: { get, list: vi.fn(async () => []), onChanged: () => () => {} } } })
  setActivePinia(createPinia())
})

afterEach(() => vi.unstubAllGlobals())

const settled = async () => {
  for (let i = 0; i < 5; i++) await nextTick()
}

describe('useSessionDetail', () => {
  it('loads older messages a page at a time, and starts over with another session', async () => {
    const selected = ref<SessionRef | null>({ accountId: 'a', sessionId: 's1' })
    const { detail, loadOlder, loadingOlder } = useSessionDetail(selected)
    await settled()
    expect(get).toHaveBeenLastCalledWith('a', 's1', CONVERSATION_PAGE_MESSAGES)
    expect(detail.value?.messages).toHaveLength(CONVERSATION_PAGE_MESSAGES)

    loadOlder()
    expect(loadingOlder.value).toBe(true)
    // The messages shown stay while the older ones load.
    expect(detail.value?.messages).toHaveLength(CONVERSATION_PAGE_MESSAGES)
    await settled()
    expect(get).toHaveBeenLastCalledWith('a', 's1', 2 * CONVERSATION_PAGE_MESSAGES)
    expect(loadingOlder.value).toBe(false)

    loadOlder()
    await settled()
    expect(detail.value).toMatchObject({ truncated: false, total: 1500 })
    expect(detail.value?.messages).toHaveLength(1500)
    // Nothing older left: nothing to load.
    get.mockClear()
    loadOlder()
    expect(get).not.toHaveBeenCalled()

    selected.value = { accountId: 'a', sessionId: 's2' }
    await settled()
    expect(get).toHaveBeenLastCalledWith('a', 's2', CONVERSATION_PAGE_MESSAGES)
  })
})
