<script setup lang="ts">
import { useEventListener } from '@vueuse/core'
import { nextTick, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useTerminalsStore } from '@/stores/terminals'
import NewTerminalMenu from './NewTerminalMenu.vue'
import TerminalTab from './TerminalTab.vue'

const route = useRoute()
const router = useRouter()
const terminals = useTerminalsStore()
const strip = ref<HTMLElement | null>(null)

function select(id: string) {
  terminals.activate(id)
  if (route.name !== 'terminals') void router.push({ name: 'terminals' })
}

// A vertical mouse wheel scrolls the tab strip horizontally.
useEventListener(
  strip,
  'wheel',
  (event: WheelEvent) => {
    if (!strip.value || Math.abs(event.deltaY) < Math.abs(event.deltaX)) return
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
  <div class="flex min-w-0 items-center">
    <!-- The padding keeps the selected tab's ring from being clipped; -ml-1 still lets the first
         tab start at the edge, where the + button sits while there are no tabs. -->
    <div
      v-show="terminals.terminals.length > 0"
      ref="strip"
      role="tablist"
      class="no-scrollbar -ml-1 flex min-w-0 items-center gap-1 overflow-x-auto p-1"
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
