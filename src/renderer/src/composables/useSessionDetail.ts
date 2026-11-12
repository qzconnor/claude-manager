import { computed, ref, watch, type Ref } from 'vue'
import { CONVERSATION_PAGE_MESSAGES } from '@shared/defaults'
import type { SessionDetail, SessionRef } from '@shared/types'
import { errorMessage } from '@/lib/errors'
import { useSessionsStore } from '@/stores/sessions'

export type { SessionRef }

/**
 * Loads the transcript of the selected session and reloads it when the session changes on
 * disk (e.g. while it is still running in a tab). Stale responses are discarded.
 */
export function useSessionDetail(selected: Ref<SessionRef | null>) {
  const sessions = useSessionsStore()
  const detail = ref<SessionDetail | null>(null)
  const loading = ref(false)
  const error = ref<string | null>(null)
  /** How many of the newest messages are shown; „Ältere laden“ adds a page, another session starts over. */
  const limit = ref(CONVERSATION_PAGE_MESSAGES)
  const loadingOlder = ref(false)
  let requestId = 0

  const summary = computed(() => {
    const sel = selected.value
    if (!sel) return null
    return sessions.groups.find((g) => g.accountId === sel.accountId)?.sessions.find((s) => s.id === sel.sessionId) ?? null
  })

  async function load(sel: SessionRef | null, keepContent: boolean) {
    const id = ++requestId
    if (!sel) {
      detail.value = null
      error.value = null
      return
    }
    if (!keepContent) detail.value = null
    loading.value = true
    error.value = null
    try {
      const result = await window.api.sessions.get(sel.accountId, sel.sessionId, limit.value)
      if (id === requestId) detail.value = result
    } catch (e) {
      if (id === requestId) error.value = errorMessage(e)
    } finally {
      if (id === requestId) {
        loading.value = false
        loadingOlder.value = false
      }
    }
  }

  /** The next page of older messages, above the ones shown. */
  function loadOlder() {
    if (!detail.value?.truncated || loadingOlder.value) return
    limit.value += CONVERSATION_PAGE_MESSAGES
    loadingOlder.value = true
    void load(selected.value, true)
  }

  watch(selected, (sel, prev) => {
    if (sel?.accountId === prev?.accountId && sel?.sessionId === prev?.sessionId) return
    limit.value = CONVERSATION_PAGE_MESSAGES
    loadingOlder.value = false
    void load(sel, false)
  }, { immediate: true })

  watch(
    () => summary.value?.updatedAt,
    (updatedAt, previous) => {
      if (updatedAt && previous && updatedAt !== previous) void load(selected.value, true)
    },
  )

  return { detail, summary, loading, loadingOlder, error, loadOlder, reload: () => load(selected.value, true) }
}
