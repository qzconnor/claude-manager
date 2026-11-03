import { ref, shallowRef, watch, type Ref } from 'vue'
import type { SessionSearchHit } from '@shared/types'
import { searchTerms } from '@shared/utils'

/** Key of a session across accounts. */
export function sessionKey(accountId: string, sessionId: string): string {
  return `${accountId}:${sessionId}`
}

/**
 * Searches the conversations of all sessions (prompts and answers) in the indexer.
 * `query` should be debounced; answers to an older query are dropped.
 */
export function useSessionSearch(query: Ref<string>) {
  /** By `sessionKey`. */
  const hits = shallowRef(new Map<string, SessionSearchHit>())
  const searching = ref(false)
  let latest = 0

  watch(
    query,
    async (value) => {
      const id = ++latest
      if (searchTerms(value).length === 0) {
        hits.value = new Map()
        searching.value = false
        return
      }
      searching.value = true
      try {
        const result = await window.api.sessions.search(value)
        if (id === latest) hits.value = new Map(result.map((hit) => [sessionKey(hit.accountId, hit.sessionId), hit]))
      } catch {
        if (id === latest) hits.value = new Map()
      } finally {
        if (id === latest) searching.value = false
      }
    },
    { immediate: true },
  )

  /** Brings the index up to date before the first word is typed. */
  function prepare(): void {
    void window.api.sessions.search('').catch(() => undefined)
  }

  return { hits, searching, prepare }
}
