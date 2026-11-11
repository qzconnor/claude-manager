import { computed, onScopeDispose, ref, shallowRef, watch } from 'vue'
import type { ContentSearchResult } from '@shared/types'
import { errorMessage } from '@/lib/errors'
import type { TreeModel } from '@/stores/file-tree'

/** Shorter text finds too much to help. */
export const MIN_CONTENT_QUERY = 2
/** Typing on within this long (ms) searches once, for the last text. */
const DEBOUNCE_MS = 250

/**
 * The content search of a tree: the lines of its files that hold what is typed into its search, while
 * the search looks into the files (`searchContent`). An answer to an older text is dropped.
 */
export function useContentSearch(model: () => TreeModel) {
  const result = shallowRef<ContentSearchResult | null>(null)
  const loading = ref(false)
  const error = ref<string | null>(null)
  /** What is searched for: the text as typed (spaces too), once it is long enough. */
  const query = computed(() => {
    const { searchContent, query } = model()
    return searchContent && query.trim().length >= MIN_CONTENT_QUERY ? query.replace(/[\r\n]/g, '') : ''
  })
  let request = 0
  let timer: ReturnType<typeof setTimeout> | undefined

  function run(root: string, text: string, delay: number): void {
    clearTimeout(timer)
    const id = ++request
    if (!text) {
      result.value = null
      error.value = null
      loading.value = false
      return
    }
    loading.value = true
    timer = setTimeout(async () => {
      try {
        const next = await window.api.files.grep(root, text)
        if (id !== request) return
        result.value = Object.freeze(next)
        error.value = null
      } catch (e) {
        if (id !== request) return
        result.value = null
        error.value = errorMessage(e)
      } finally {
        if (id === request) loading.value = false
      }
    }, delay)
  }

  watch([() => model().root, query], ([root, text]) => run(root, text, DEBOUNCE_MS), { immediate: true })
  onScopeDispose(() => clearTimeout(timer))

  return {
    result,
    loading,
    error,
    query,
    /** Searches again, e.g. after files changed. */
    refresh: () => run(model().root, query.value, 0),
  }
}
