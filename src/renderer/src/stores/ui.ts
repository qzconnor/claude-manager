import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { DialogOptions } from '@shared/types'
import type { SessionRef } from '@/composables/useSessionDetail'

export type ConfirmOptions = DialogOptions

/** Transient UI state shared across components (dialogs, palette, search requests). */
export const useUiStore = defineStore('ui', () => {
  const paletteOpen = ref(false)
  /** The search through the open tabs and the sessions. */
  const tabSearchOpen = ref(false)
  /** Incremented to ask the active terminal to open its search bar. */
  const searchRequest = ref(0)
  /** Incremented to give the keyboard back to the active terminal, e.g. after a popup closed. */
  const focusTerminalRequest = ref(0)
  /** A session the sessions page should select, with the search that found it. */
  const sessionToShow = ref<(SessionRef & { query: string }) | null>(null)
  /**
   * Left and right edge (viewport px) of the selected tab in the title bar, as far as it is visible.
   * The page below opens its top border there, so the tab merges into it.
   */
  const selectedTabEdges = ref<{ left: number; right: number } | null>(null)

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
    focusTerminalRequest,
    sessionToShow,
    selectedTabEdges,
    confirmState,
    confirm,
    settleConfirm,
  }
})
