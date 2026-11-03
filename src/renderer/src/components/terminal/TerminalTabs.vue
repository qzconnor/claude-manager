<script setup lang="ts">
import { useEventListener, useMutationObserver } from '@vueuse/core'
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useTerminalsStore } from '@/stores/terminals'
import { useUiStore } from '@/stores/ui'
import NewTerminalMenu from './NewTerminalMenu.vue'
import TerminalTab from './TerminalTab.vue'

/** `vertical`: listed in the sidebar instead of the title bar. */
const props = defineProps<{ vertical?: boolean }>()

const route = useRoute()
const router = useRouter()
const terminals = useTerminalsStore()
const ui = useUiStore()
const strip = ref<HTMLElement | null>(null)

/** Tells the page below where the selected tab sits, clipped to the visible part of the strip. */
function measureSelected() {
  const tab = strip.value?.querySelector('[role="tab"][aria-selected="true"]')
  if (!strip.value || !tab) {
    ui.selectedTabEdges = null
    return
  }
  const bounds = strip.value.getBoundingClientRect()
  const rect = tab.getBoundingClientRect()
  const left = Math.max(rect.left, bounds.left)
  const right = Math.min(rect.right, bounds.right)
  ui.selectedTabEdges = right > left ? { left, right } : null
}

// In the title bar the tab moves when tabs are added, closed, renamed (other width) or scrolled.
if (!props.vertical) {
  const resizeObserver = new ResizeObserver(measureSelected)
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

function select(id: string) {
  terminals.activate(id)
  if (route.name !== 'terminals') void router.push({ name: 'terminals' })
}

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
  () => terminals.activeId,
  (id) => {
    if (!id) return
    void nextTick(() => {
      strip.value
        ?.querySelector(`[data-terminal-id="${CSS.escape(id)}"]`)
        ?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
    })
  },
)
</script>

<template>
  <div v-if="vertical" class="flex flex-col gap-1">
    <span class="shrink-0 px-2.5 py-1 text-xs font-medium text-muted-foreground">Tabs</span>
    <!-- The padding keeps the selected tab's ring from being clipped, -mx-1 lines the tabs up with the nav. -->
    <div
      v-if="terminals.terminals.length > 0"
      ref="strip"
      role="tablist"
      aria-orientation="vertical"
      class="-mx-1 flex min-h-0 flex-col gap-1 overflow-y-auto p-1"
    >
      <TerminalTab
        v-for="terminal in terminals.terminals"
        :key="terminal.id"
        :terminal="terminal"
        :selected="route.name === 'terminals' && terminal.id === terminals.activeId"
        vertical
        @select="select(terminal.id)"
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
    >
      <TerminalTab
        v-for="terminal in terminals.terminals"
        :key="terminal.id"
        :terminal="terminal"
        :selected="route.name === 'terminals' && terminal.id === terminals.activeId"
        @select="select(terminal.id)"
      />
    </div>
    <NewTerminalMenu />
  </div>
</template>
