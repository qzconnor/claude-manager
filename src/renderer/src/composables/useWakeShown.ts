import { useDocumentVisibility } from '@vueuse/core'
import { watch } from 'vue'
import { useTerminalsStore } from '@/stores/terminals'

/**
 * Starts the tabs of the last run that wait (status `asleep`) once they are on screen: among `shown`,
 * the terminals the window shows, while the window can be seen (not hidden in the tray or minimized).
 */
export function useWakeShown(shown: () => readonly string[]): void {
  const terminals = useTerminalsStore()
  const visibility = useDocumentVisibility()
  watch(
    () => {
      if (visibility.value !== 'visible') return ''
      return shown()
        .filter((id) => terminals.terminals.some((t) => t.id === id && t.status === 'asleep'))
        .join(',')
    },
    (ids) => {
      if (ids) terminals.wakeShown(ids.split(','))
    },
    { immediate: true },
  )
}
