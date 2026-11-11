import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { AppInfo, WindowState } from '@shared/types'

/** The window coming to the front asks for the info again at most this often. */
const REFRESH_MS = 10_000

export const useAppStore = defineStore('app', () => {
  const info = ref<AppInfo | null>(null)
  const windowState = ref<WindowState>({ maximized: false, focused: true, fullscreen: false })
  let refreshedAt = 0

  async function load(): Promise<void> {
    const [appInfo, state] = await Promise.all([window.api.app.info(), window.api.window.state()])
    info.value = appInfo
    windowState.value = state
    refreshedAt = Date.now()
  }

  /**
   * Asks for the info again: Claude Code may have been installed, moved or updated meanwhile (its
   * version, "nicht gefunden"). `force`: also right after the last time.
   */
  async function refreshInfo(force = false): Promise<void> {
    if (!force && Date.now() - refreshedAt < REFRESH_MS) return
    refreshedAt = Date.now()
    try {
      info.value = await window.api.app.info()
    } catch {
      // The info shown stays.
    }
  }

  window.api.window.onState((state) => {
    const focused = state.focused && !windowState.value.focused
    windowState.value = state
    if (focused) void refreshInfo()
  })

  return { info, windowState, load, refreshInfo }
})
