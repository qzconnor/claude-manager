import { useEventListener } from '@vueuse/core'
import { useRouter } from 'vue-router'
import { createDefaultSettings } from '@shared/defaults'
import { matchShortcut } from '@/lib/shortcuts'
import { useSettingsStore } from '@/stores/settings'
import { useTerminalsStore } from '@/stores/terminals'
import { useUiStore } from '@/stores/ui'
import { useLauncher } from './useLauncher'
import { useTerminalActions } from './useTerminalActions'

/** Registers the global keyboard shortcuts (see lib/shortcuts.ts). */
export function useShortcuts() {
  const router = useRouter()
  const terminals = useTerminalsStore()
  const settings = useSettingsStore()
  const ui = useUiStore()
  const launcher = useLauncher()
  const { closeTerminal } = useTerminalActions()

  const zoom = (delta: number | null) => {
    const current = settings.settings.terminal.fontSize
    const next = delta === null ? createDefaultSettings(window.api.platform).terminal.fontSize : Math.min(40, Math.max(6, current + delta))
    if (next !== current) void settings.update({ terminal: { fontSize: next } })
  }

  const showTerminals = () => {
    if (router.currentRoute.value.name !== 'terminals') void router.push({ name: 'terminals' })
  }

  const onTerminals = () => router.currentRoute.value.name === 'terminals'

  useEventListener(window, 'keydown', (event: KeyboardEvent) => {
    const shortcut = matchShortcut(event)
    if (!shortcut) return
    if (shortcut.action === 'focus-pane') {
      // At the edge of the tab (or in a tab with one terminal) the keys stay with the terminal.
      const next = onTerminals() && terminals.activeId ? terminals.neighbour(terminals.activeId, shortcut.direction!) : null
      if (!next) return
      event.preventDefault()
      terminals.activate(next)
      return
    }
    event.preventDefault()
    const { action } = shortcut
    switch (action) {
      case 'new-tab':
        void launcher.newSession()
        break
      case 'close-tab':
        if (terminals.activeId) void closeTerminal(terminals.activeId)
        break
      case 'next-tab':
      case 'previous-tab':
        terminals.cycle(action === 'next-tab' ? 1 : -1)
        showTerminals()
        break
      case 'select-tab':
        if (terminals.activateAt(shortcut.index ?? 0)) showTerminals()
        break
      case 'open-settings':
        void router.push({ name: 'settings' })
        break
      case 'command-palette':
        ui.paletteOpen = true
        break
      case 'tab-search':
        ui.tabSearchOpen = !ui.tabSearchOpen
        break
      case 'zoom-in':
        zoom(1)
        break
      case 'zoom-out':
        zoom(-1)
        break
      case 'zoom-reset':
        zoom(null)
        break
      case 'find':
        if (onTerminals()) ui.searchRequest++
        break
      case 'split-right':
      case 'split-down':
        if (onTerminals() && terminals.active) void launcher.split(terminals.active, action === 'split-right' ? 'row' : 'column')
        break
    }
  })
}
