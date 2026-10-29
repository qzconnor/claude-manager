import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { DialogOptions } from '@shared/types'

export type ConfirmOptions = DialogOptions

/** Transient UI state shared across components (dialogs, palette, search requests). */
export const useUiStore = defineStore('ui', () => {
  const paletteOpen = ref(false)
  /** Incremented to ask the active terminal to open its search bar. */
  const searchRequest = ref(0)

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

  return { paletteOpen, searchRequest, confirmState, confirm, settleConfirm }
})
