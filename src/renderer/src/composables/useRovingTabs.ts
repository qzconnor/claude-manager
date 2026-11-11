import { useEventListener } from '@vueuse/core'
import type { Ref } from 'vue'
import { rovingIndex } from '@/lib/tab-keys'

/**
 * The arrow keys move the keyboard from tab to tab in a tab strip (`role="tablist"`), Home and End to the
 * first and the last, as in the tabs pattern of WAI-ARIA. Only the tab in front is a stop for Tab
 * (`tabindex="0"`, set by the tabs themselves); the others are reached with the arrows.
 */
export function useRovingTabs(list: Ref<HTMLElement | null>, vertical = false): void {
  useEventListener(list, 'keydown', (event: KeyboardEvent) => {
    const strip = list.value
    const target = event.target
    if (!strip || !(target instanceof HTMLElement) || target.getAttribute('role') !== 'tab') return
    if (event.shiftKey || event.altKey || event.ctrlKey || event.metaKey) return
    // Only the strip's own tabs, not those of a strip inside one of them.
    const tabs = [...strip.querySelectorAll<HTMLElement>('[role="tab"]')].filter((tab) => tab.closest('[role="tablist"]') === strip)
    const next = rovingIndex(event.key, tabs.indexOf(target), tabs.length, vertical)
    if (next === null) return
    event.preventDefault()
    tabs[next]!.focus()
  })
}
