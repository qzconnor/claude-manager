import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { PaneDirection } from '@shared/panes'
import type { DialogOptions } from '@shared/types'
import type { SessionRef } from '@/composables/useSessionDetail'

export type ConfirmOptions = DialogOptions

/** A tab dragged over the page: dropped now, it goes on `side` of the terminal `targetId`. */
export interface TabDock {
  tabId: string
  targetId: string
  side: PaneDirection
}

/** Transient UI state shared across components (dialogs, palette, search requests). */
export const useUiStore = defineStore('ui', () => {
  const paletteOpen = ref(false)
  /** The search through the open tabs and the sessions. */
  const tabSearchOpen = ref(false)
  /** Incremented to ask the active terminal to open its search bar. */
  const searchRequest = ref(0)
  /** Incremented to put the keyboard into the search of the settings page. */
  const settingsSearchRequest = ref(0)
  /** Incremented to give the keyboard back to the active terminal, e.g. after a popup closed. */
  const focusTerminalRequest = ref(0)
  /** A session the sessions page should select, with the search that found it. */
  const sessionToShow = ref<(SessionRef & { query: string }) | null>(null)
  /**
   * Left and right edge (viewport px) of the selected tab in the title bar, as far as it is visible.
   * The page below opens its top border there, so the tab merges into it.
   */
  const selectedTabEdges = ref<{ left: number; right: number } | null>(null)
  /** Id of the tab being dragged to another position; hover cards stay closed meanwhile. */
  const draggingTab = ref<string | null>(null)
  /** Where the dragged tab lands if dropped on the page now; the page shows it. */
  const tabDock = ref<TabDock | null>(null)

  const confirmState = ref<(ConfirmOptions & { open: boolean }) | null>(null)
  let confirmResolve: ((value: boolean) => void) | null = null

  function confirm(options: ConfirmOptions): Promise<boolean> {
    confirmResolve?.(false)
    confirmState.value = { ...options, open: true }
    return new Promise((resolve) => {
      confirmResolve = resolve
    })
  }

  function settleConfirm(result: boolean): void {
    confirmResolve?.(result)
    confirmResolve = null
    if (confirmState.value) confirmState.value = { ...confirmState.value, open: false }
  }

  return {
    paletteOpen,
    tabSearchOpen,
    searchRequest,
    settingsSearchRequest,
    focusTerminalRequest,
    sessionToShow,
    selectedTabEdges,
    draggingTab,
    tabDock,
    confirmState,
    confirm,
    settleConfirm,
  }
})
