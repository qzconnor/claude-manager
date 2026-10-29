import { useDebounceFn } from '@vueuse/core'
import { computed, ref, watch, type WritableComputedRef } from 'vue'
import type { AppSettings, DeepPartial } from '@shared/types'
import { toastError } from '@/lib/errors'
import { useSettingsStore } from '@/stores/settings'

/**
 * Two-way binding for a single setting. The UI updates immediately; the change is persisted
 * (debounced for sliders) and the sanitized value from the main process flows back.
 */
export function useSetting<T>(
  read: (settings: AppSettings) => T,
  patch: (value: T) => DeepPartial<AppSettings>,
  delay = 0,
): WritableComputedRef<T> {
  const store = useSettingsStore()
  const local = ref(read(store.settings)) as { value: T }
  /** Incremented on every local change; a save only syncs back if nothing changed meanwhile. */
  let revision = 0
  let dirty = false

  watch(
    () => read(store.settings),
    (value) => {
      if (!dirty) local.value = value
    },
  )

  const persist = useDebounceFn(async (value: T) => {
    const saving = revision
    try {
      await store.update(patch(value))
    } catch (error) {
      toastError(error, 'Einstellung konnte nicht gespeichert werden')
    } finally {
      if (revision === saving) {
        dirty = false
        local.value = read(store.settings)
      }
    }
  }, delay)

  return computed({
    get: () => local.value,
    set: (value: T) => {
      local.value = value
      revision++
      dirty = true
      void persist(value)
    },
  })
}
