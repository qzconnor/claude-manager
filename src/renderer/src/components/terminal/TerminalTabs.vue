<script setup lang="ts">
import { useEventListener, useMutationObserver } from '@vueuse/core'
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch, watchEffect } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useTabDrag } from '@/composables/useTabDrag'
import { useTerminalsStore, type TerminalTab as Tab } from '@/stores/terminals'
import { useUiStore } from '@/stores/ui'
import NewTerminalMenu from './NewTerminalMenu.vue'
import TabSearch from './TabSearch.vue'
import TerminalTab from './TerminalTab.vue'

/** `vertical`: listed in the sidebar instead of the title bar. */
const props = defineProps<{ vertical?: boolean }>()

const route = useRoute()
const router = useRouter()
const terminals = useTerminalsStore()
const ui = useUiStore()
const strip = ref<HTMLElement | null>(null)

/** Width of the fade at an edge of the strip behind which more tabs are scrolled away. */
const FADE = 24
const overflow = ref({ start: false, end: false })
/** Fades out tabs cut by the edge of the strip instead of cutting them off hard. */
const stripMask = computed(() => {
  const { start, end } = overflow.value
  if (!start && !end) return undefined
  const from = start ? 'transparent' : 'black'
  const to = end ? 'transparent' : 'black'
  return { maskImage: `linear-gradient(to right, ${from}, black ${FADE}px, black calc(100% - ${FADE}px), ${to})` }
})

/** Tells the page below where the selected tab sits, clipped to the visible part of the strip. */
function measureSelected() {
  const el = strip.value
  overflow.value = el
    ? { start: el.scrollLeft > 1, end: el.scrollLeft + el.clientWidth < el.scrollWidth - 1 }
    : { start: false, end: false }
  const tab = el?.querySelector('[role="tab"][aria-selected="true"]')
  if (!el || !tab) {
    ui.selectedTabEdges = null
    return
  }
  const bounds = el.getBoundingClientRect()
  const rect = tab.getBoundingClientRect()
  const left = Math.max(rect.left, bounds.left)
  const right = Math.min(rect.right, bounds.right)
  ui.selectedTabEdges = right > left ? { left, right } : null
}

/** Scrolls the strip so a tab (by its id) is fully visible and clear of the fades, as far as the strip is wide enough. */
function reveal(id: string | null) {
  const el = strip.value
  const tab = id ? el?.querySelector<HTMLElement>(`[data-terminal-id="${CSS.escape(id)}"]`) : null
  if (!el || !tab) return
  const bounds = el.getBoundingClientRect()
  const rect = tab.getBoundingClientRect()
  const margin = Math.max(0, Math.min(FADE, (bounds.width - rect.width) / 2))
  if (rect.left < bounds.left + margin) el.scrollLeft -= bounds.left + margin - rect.left
  else if (rect.right > bounds.right - margin) el.scrollLeft += rect.right - (bounds.right - margin)
}

// In the title bar the tab moves when tabs are added, closed, renamed (other width) or scrolled.
if (!props.vertical) {
  const resizeObserver = new ResizeObserver((entries) => {
    // A narrower window keeps the selected tab in view. Tabs changing width (new title) don't,
    // so a strip scrolled by hand stays where it is.
    if (entries.some((entry) => entry.target === strip.value)) reveal(terminals.activeTab?.id ?? null)
    measureSelected()
  })
  const observeTabs = () => {
    resizeObserver.disconnect()
    if (!strip.value) return
    resizeObserver.observe(strip.value)
    for (const tab of strip.value.children) resizeObserver.observe(tab)
  }
  onMounted(observeTabs)
  useMutationObserver(strip, observeTabs, { childList: true })
  useEventListener(strip, 'scroll', measureSelected, { passive: true })
  watch([() => terminals.activeId, () => route.name], () => void nextTick(measureSelected))
  onBeforeUnmount(() => {
    resizeObserver.disconnect()
    ui.selectedTabEdges = null
  })
}

function select(tab: Tab) {
  terminals.activate(tab.focused.id)
  if (route.name !== 'terminals') void router.push({ name: 'terminals' })
}

// Tabs are reordered by dragging; in the title bar the page follows the selected tab while they move.
const { dragging } = useTabDrag(strip, {
  vertical: props.vertical,
  onDrop: (tabId, index) => terminals.move(tabId, index),
  onMove: props.vertical ? undefined : measureSelected,
})
watchEffect(() => (ui.draggingTab = dragging.value))
onBeforeUnmount(() => (ui.draggingTab = null))

// A vertical mouse wheel scrolls the tab strip in the title bar horizontally.
useEventListener(
  strip,
  'wheel',
  (event: WheelEvent) => {
    if (props.vertical || !strip.value || Math.abs(event.deltaY) < Math.abs(event.deltaX)) return
    strip.value.scrollLeft += event.deltaY
    event.preventDefault()
  },
  { passive: false },
)

watch(
  () => terminals.activeTab?.id,
  (id) => {
    if (!id) return
    void nextTick(() => {
      if (props.vertical) {
        strip.value?.querySelector(`[data-terminal-id="${CSS.escape(id)}"]`)?.scrollIntoView({ block: 'nearest' })
      } else {
        reveal(id)
      }
    })
  },
)
</script>

<template>
  <div v-if="vertical" class="flex flex-col gap-1">
    <!-- Takes the place of a "Tabs" heading: it searches them, and the sessions as well. -->
    <TabSearch vertical />
    <!-- The padding keeps the selected tab's ring from being clipped, -mx-1 lines the tabs up with the nav. -->
    <div
      v-if="terminals.terminals.length > 0"
      ref="strip"
      role="tablist"
      aria-orientation="vertical"
      class="-mx-1 flex min-h-0 flex-col gap-1 overflow-y-auto p-1"
    >
      <TerminalTab
        v-for="tab in terminals.tabs"
        :key="tab.id"
        :tab="tab"
        :selected="route.name === 'terminals' && tab.id === terminals.activeTab?.id"
        vertical
        @select="select(tab)"
      />
    </div>
    <!-- Stays below the list while it scrolls; -mt-1 gives it the same gap as between two tabs. -->
    <NewTerminalMenu vertical :class="terminals.terminals.length > 0 && '-mt-1'" />
  </div>
  <!-- The tabs reach down to the bottom of the title bar, where the selected one joins the page.
       The first tab starts right at the page's left edge, where the + button sits while there are no tabs. -->
  <div v-else class="flex min-w-0 gap-1 self-stretch pt-1.5">
    <div
      v-show="terminals.terminals.length > 0"
      ref="strip"
      role="tablist"
      class="no-scrollbar flex min-w-0 gap-0.5 overflow-x-auto"
      :style="stripMask"
    >
      <TerminalTab
        v-for="tab in terminals.tabs"
        :key="tab.id"
        :tab="tab"
        :selected="route.name === 'terminals' && tab.id === terminals.activeTab?.id"
        @select="select(tab)"
      />
    </div>
    <NewTerminalMenu />
  </div>
</template>
