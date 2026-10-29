import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { AppInfo, WindowState } from '@shared/types'

export const useAppStore = defineStore('app', () => {
  const info = ref<AppInfo | null>(null)
  const windowState = ref<WindowState>({ maximized: false, focused: true, fullscreen: false })

  async function load(): Promise<void> {
    const [appInfo, state] = await Promise.all([window.api.app.info(), window.api.window.state()])
    info.value = appInfo
    windowState.value = state
  }

  window.api.window.onState((state) => {
    windowState.value = state
  })

  return { info, windowState, load }
})
