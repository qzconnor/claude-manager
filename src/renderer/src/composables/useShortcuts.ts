import { tryOnScopeDispose, useEventListener } from '@vueuse/core'
import { useRouter } from 'vue-router'
import { createDefaultSettings } from '@shared/defaults'
import { matchBrowserShortcut, matchShortcut, type Shortcut } from '@shared/shortcuts'
import { useBrowsersStore } from '@/stores/browsers'
import { useSettingsStore } from '@/stores/settings'
import { useTerminalsStore } from '@/stores/terminals'
import { useUiStore } from '@/stores/ui'
import { useLauncher } from './useLauncher'
import { useTerminalActions } from './useTerminalActions'

/**
 * Registers the global keyboard shortcuts (see src/shared/shortcuts.ts). A browser page's keys come
 * from the main process, which sees them instead of the window.
 */
export function useShortcuts() {
  const router = useRouter()
  const terminals = useTerminalsStore()
  const settings = useSettingsStore()
  const ui = useUiStore()
  const launcher = useLauncher()
  const { closeTerminal } = useTerminalActions()
  const browsers = useBrowsersStore()

  const zoom = (delta: number | null) => {
    const current = settings.settings.terminal.fontSize
    const next = delta === null ? createDefaultSettings(window.api.platform).terminal.fontSize : Math.min(40, Math.max(6, current + delta))
    if (next !== current) void settings.update({ terminal: { fontSize: next } })
  }

  const showTerminals = () => {
    if (router.currentRoute.value.name !== 'terminals') void router.push({ name: 'terminals' })
  }

  const onTerminals = () => router.currentRoute.value.name === 'terminals'
  /** The browser with the keyboard, if a browser has it. */
  const activeBrowser = () => (onTerminals() ? browsers.get(terminals.activeId) : undefined)

  /** `event`: the key in the window, which is kept from the page; a browser page's key has been already. */
  function run(shortcut: Shortcut, event?: KeyboardEvent): void {
    if (shortcut.action === 'focus-pane') {
      const next = onTerminals() && terminals.activeId ? terminals.neighbour(terminals.activeId, shortcut.direction!) : null
      if (next) {
        event?.preventDefault()
        terminals.activate(next)
        return
      }
      // At the edge of the tab a browser goes back or forward like Chrome; a terminal keeps the keys.
      const browser = activeBrowser()
      if (browser && (shortcut.direction === 'left' || shortcut.direction === 'right')) {
        event?.preventDefault()
        if (shortcut.direction === 'left') browser.back()
        else browser.forward()
      }
      return
    }
    event?.preventDefault()
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
      case 'browser-address':
        activeBrowser()?.focusAddress()
        break
      case 'browser-reload':
        activeBrowser()?.reload()
        break
    }
  }

  useEventListener(window, 'keydown', (event: KeyboardEvent) => {
    // The browser keys count while a browser has the keyboard, e.g. in its address bar.
    const shortcut = matchShortcut(event) ?? (activeBrowser() ? matchBrowserShortcut(event) : null)
    if (shortcut) run(shortcut, event)
  })
  tryOnScopeDispose(window.api.browser.onShortcut((shortcut) => run(shortcut)))
}
