<script setup lang="ts">
import { useEventListener } from '@vueuse/core'
import { nextTick, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useTerminalsStore } from '@/stores/terminals'
import NewTerminalMenu from './NewTerminalMenu.vue'
import TerminalTab from './TerminalTab.vue'

/** `vertical`: listed in the sidebar instead of the title bar. */
const props = defineProps<{ vertical?: boolean }>()

const route = useRoute()
const router = useRouter()
const terminals = useTerminalsStore()
const strip = ref<HTMLElement | null>(null)

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
    <div class="flex shrink-0 items-center justify-between gap-2 pl-2.5">
      <span class="text-xs font-medium text-muted-foreground">Tabs</span>
      <NewTerminalMenu />
    </div>
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
    <p v-else class="px-2.5 py-1 text-xs text-muted-foreground">Keine offenen Tabs</p>
  </div>
  <div v-else class="flex min-w-0 items-center">
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
