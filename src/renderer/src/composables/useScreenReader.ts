import { computed, ref, type ComputedRef } from 'vue'
import type { ScreenReaderMode } from '@shared/types'
import { useSettingsStore } from '@/stores/settings'

/** Whether the terminals are readable for a screen reader, by the setting and whether the system reports one. */
export function screenReaderOn(mode: ScreenReaderMode, system: boolean): boolean {
  return mode === 'on' || (mode === 'auto' && system)
}

/** Whether the system reports a screen reader: asked once for the whole app, then kept up to date. */
const system = ref(false)
let asked = false

/**
 * Whether the terminals are readable for a screen reader (xterm's screen reader mode): always, never, or
 * while the system reports one, as VS Code's `accessibilitySupport: auto` does.
 */
export function useScreenReader(): ComputedRef<boolean> {
  const settings = useSettingsStore()
  if (!asked) {
    asked = true
    window.api.app.onScreenReader((active) => (system.value = active))
    window.api.app.screenReader().then(
      (active) => (system.value = active),
      () => {},
    )
  }
  return computed(() => screenReaderOn(settings.settings.terminal.screenReader, system.value))
}
