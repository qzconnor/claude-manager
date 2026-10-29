import { computed, ref, watch, type Ref } from 'vue'
import type { SessionDetail } from '@shared/types'
import { errorMessage } from '@/lib/errors'
import { useSessionsStore } from '@/stores/sessions'

export interface SessionRef {
  accountId: string
  sessionId: string
}

/**
 * Loads the transcript of the selected session and reloads it when the session changes on
 * disk (e.g. while it is still running in a tab). Stale responses are discarded.
 */
export function useSessionDetail(selected: Ref<SessionRef | null>) {
  const sessions = useSessionsStore()
  const detail = ref<SessionDetail | null>(null)
  const loading = ref(false)
  const error = ref<string | null>(null)
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
      const result = await window.api.sessions.get(sel.accountId, sel.sessionId)
      if (id === requestId) detail.value = result
    } catch (e) {
      if (id === requestId) error.value = errorMessage(e)
    } finally {
      if (id === requestId) loading.value = false
    }
  }

  watch(selected, (sel, prev) => {
    if (sel?.accountId === prev?.accountId && sel?.sessionId === prev?.sessionId) return
    void load(sel, false)
  }, { immediate: true })

  watch(
    () => summary.value?.updatedAt,
    (updatedAt, previous) => {
      if (updatedAt && previous && updatedAt !== previous) void load(selected.value, true)
    },
  )

  return { detail, summary, loading, error, reload: () => load(selected.value, true) }
}
