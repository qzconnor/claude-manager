import { computed, inject, provide, reactive, type InjectionKey } from 'vue'
import { pageOf, PAGE_SIZE } from '@/lib/session-tree'

/** How many sessions each folder and section of the session list shows, by id. */
const PAGES: InjectionKey<Map<string, number>> = Symbol('session-pages')

/**
 * For the session list: how far each folder in it shows its sessions. The list keeps it, not each
 * folder, so a Shift+click range knows which sessions one sees (see `sessionsInView`).
 */
export function provideSessionPages(): Map<string, number> {
  const pages = reactive(new Map<string, number>())
  provide(PAGES, pages)
  return pages
}

/** For a folder or section of the list: its own sessions as far as it shows them, and showing more. */
export function useSessionPage<T>(id: () => string, sessions: () => readonly T[]) {
  // Outside a list (on its own), a folder keeps it for itself.
  const pages = inject(PAGES, () => reactive(new Map<string, number>()), true)
  const shown = computed(() => pageOf(sessions(), id(), pages))
  /** How many it doesn't show yet. */
  const hidden = computed(() => sessions().length - shown.value.length)
  function showMore() {
    pages.set(id(), shown.value.length + PAGE_SIZE)
  }
  return { shown, hidden, showMore }
}
