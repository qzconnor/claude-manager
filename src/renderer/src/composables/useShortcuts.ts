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

  const onTerminals = () => router.currentRoute.value.name === 'terminals'
  /** In one tab bar, a tab chosen by key shows the terminals; in groups the route follows the tab by itself. */
  const showTerminals = () => {
    if (!terminals.grouped && !onTerminals()) void router.push({ name: 'terminals' })
  }
  /** The browser with the keyboard, if a browser has it. */
  const activeBrowser = () => (onTerminals() ? browsers.get(terminals.activeId) : undefined)

  /** `event`: the key in the window, which is kept from the page; a browser page's key has been already. */
  function run(shortcut: Shortcut, event?: KeyboardEvent): void {
    if (shortcut.action === 'focus-pane') {
      // A browser goes back or forward on Alt+Left and Alt+Right, like Chrome; Alt+Up and Alt+Down
      // still move on.
      const browser = activeBrowser()
      if (browser && (shortcut.direction === 'left' || shortcut.direction === 'right')) {
        event?.preventDefault()
        if (shortcut.direction === 'left') browser.back()
        else browser.forward()
        return
      }
      // In groups to the group beside, also from a page; in one tab bar to the terminal beside in the tab.
      if ((terminals.grouped || onTerminals()) && terminals.focusNeighbour(shortcut.direction!)) event?.preventDefault()
      return
    }
    event?.preventDefault()
    const { action } = shortcut
    switch (action) {
      case 'new-tab':
        void launcher.newSession()
        break
      case 'close-tab':
        // The tab with the keyboard: the terminal, in groups also a page.
        if (terminals.focusedTab) void closeTerminal(terminals.focusedTab)
        break
      case 'next-tab':
      case 'previous-tab':
        // In groups within the group with the keyboard, like editor tabs.
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
        ui.openPalette('>')
        break
      case 'tab-search':
        ui.openPalette()
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
        // In a browser Ctrl+Shift+F searches the page, like Ctrl+F.
        if (activeBrowser()) activeBrowser()!.find()
        else if (onTerminals()) ui.searchRequest++
        else if (router.currentRoute.value.name === 'settings') ui.settingsSearchRequest++
        break
      case 'split-right':
      case 'split-down':
        void launcher.splitActive(action === 'split-right' ? 'row' : 'column')
        break
      case 'browser-address':
        activeBrowser()?.focusAddress()
        break
      case 'browser-reload':
        activeBrowser()?.reload()
        break
      case 'browser-reload-hard':
        activeBrowser()?.reload(true)
        break
      case 'browser-devtools':
        activeBrowser()?.toggleDevTools()
        break
      case 'browser-find':
        activeBrowser()?.find()
        break
      case 'browser-find-next':
      case 'browser-find-previous':
        activeBrowser()?.findAgain(action === 'browser-find-next')
        break
      case 'browser-back':
        activeBrowser()?.back()
        break
      case 'browser-forward':
        activeBrowser()?.forward()
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
