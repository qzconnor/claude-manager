<script setup lang="ts">
import { CircleStopIcon, RotateCwIcon, XIcon } from '@lucide/vue'
import { computed, nextTick, ref, toRef, watch } from 'vue'
import type { TerminalInfo } from '@shared/types'
import { Button } from '@/components/ui/button'
import { useClock } from '@/composables/useClock'
import { useTerminal } from '@/composables/useTerminal'
import { useTerminalActions } from '@/composables/useTerminalActions'
import { useTerminalAppearance } from '@/composables/useTerminalAppearance'
import { useSettingsStore } from '@/stores/settings'
import { useUiStore } from '@/stores/ui'
import TerminalLimitBanner from './TerminalLimitBanner.vue'
import TerminalSearch from './TerminalSearch.vue'

const props = defineProps<{ terminal: TerminalInfo; active: boolean }>()

const container = ref<HTMLElement | null>(null)
const search = ref<InstanceType<typeof TerminalSearch> | null>(null)
const searchOpen = ref(false)

const term = useTerminal({
  terminalId: props.terminal.id,
  claudeSession: props.terminal.mode === 'session',
  container,
  active: toRef(props, 'active'),
})
const { containerBackground } = useTerminalAppearance()
const settings = useSettingsStore()
const ui = useUiStore()
const { closeTerminal, restartTerminal } = useTerminalActions()

// No padding at the top: the rows reach up to the edge there (see useTerminal's fit).
const padding = computed(() => `0 ${settings.settings.terminal.padding}px ${settings.settings.terminal.padding}px`)
const exited = computed(() => props.terminal.status === 'exited')

// The limit hint stays away once dismissed, until the session hits a limit again.
const now = useClock(30_000)
const dismissedLimit = ref<string | null>(null)
const limitKey = computed(() => {
  const { limit, sessionId } = props.terminal
  return limit ? `${sessionId}|${limit.resetsAt}|${limit.message}` : null
})
const limit = computed(() => {
  const current = props.terminal.limit
  if (!current || limitKey.value === dismissedLimit.value) return null
  return current.resetsAt && Date.parse(current.resetsAt) <= now.value ? null : current
})

watch(
  () => ui.searchRequest,
  () => {
    if (!props.active) return
    searchOpen.value = true
    void nextTick(() => search.value?.focus())
  },
)

function closeSearch() {
  searchOpen.value = false
  term.clearSearch()
  term.focus()
}
</script>

<template>
  <div class="relative size-full overflow-hidden" :style="{ background: containerBackground, padding }">
    <!-- Aligned to the bottom, so the prompt keeps just the padding there; the top row reaches above
         the container and is cut at the edge of the pane. -->
    <div ref="container" class="flex size-full flex-col justify-end *:shrink-0" />

    <div v-if="limit" class="pointer-events-none absolute inset-x-0 top-3 z-10 flex justify-center px-4">
      <TerminalLimitBanner
        class="pointer-events-auto"
        :terminal="terminal"
        :limit="limit"
        @dismiss="dismissedLimit = limitKey"
      />
    </div>

    <div v-if="searchOpen" class="absolute top-3 right-5 z-10">
      <TerminalSearch ref="search" :find-next="term.findNext" :find-previous="term.findPrevious" @close="closeSearch" />
    </div>

    <div v-if="exited" class="absolute inset-x-0 bottom-4 z-10 flex justify-center px-4">
      <div class="glass flex items-center gap-3 rounded-xl py-2 pr-2 pl-4 shadow-lg ring-1 ring-foreground/10">
        <CircleStopIcon class="size-4 text-muted-foreground" />
        <span class="text-sm">
          Prozess beendet
          <span class="text-muted-foreground">(Exit-Code {{ terminal.exitCode ?? '?' }})</span>
        </span>
        <Button size="sm" variant="secondary" @click="restartTerminal(terminal.id)">
          <RotateCwIcon data-icon="inline-start" />
          Neu starten
        </Button>
        <Button size="sm" variant="ghost" @click="closeTerminal(terminal.id)">
          <XIcon data-icon="inline-start" />
          Schließen
        </Button>
      </div>
    </div>
  </div>
</template>
