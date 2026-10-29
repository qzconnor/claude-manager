import { useIntervalFn } from '@vueuse/core'
import { shallowRef } from 'vue'

/** Current timestamp (ms) that refreshes every `intervalMs` – for relative time labels. */
export function useClock(intervalMs = 30_000) {
  const now = shallowRef(Date.now())
  useIntervalFn(() => {
    now.value = Date.now()
  }, intervalMs)
  return now
}
