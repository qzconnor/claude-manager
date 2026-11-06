<script setup lang="ts">
import { CircleStopIcon, FileInputIcon, RotateCwIcon, XIcon } from '@lucide/vue'
import { computed, nextTick, ref, toRef, watch } from 'vue'
import type { TerminalInfo } from '@shared/types'
import { Button } from '@/components/ui/button'
import { useClock } from '@/composables/useClock'
import { useTerminal } from '@/composables/useTerminal'
import { useTerminalActions } from '@/composables/useTerminalActions'
import { useTerminalAppearance } from '@/composables/useTerminalAppearance'
import { formatArgs } from '@/lib/args'
import { cn } from '@/lib/utils'
import { useBrowsersStore } from '@/stores/browsers'
import { useSettingsStore } from '@/stores/settings'
import { useUiStore } from '@/stores/ui'
import TerminalChromeBanner from './TerminalChromeBanner.vue'
import TerminalLimitBanner from './TerminalLimitBanner.vue'
import TerminalSearch from './TerminalSearch.vue'

/** `active`: has the keyboard while the terminals page is shown. `dimmed`: a part of a split tab without the keyboard. */
// Placed by TerminalWorkspace (absolute, with its share of the tab).
const props = defineProps<{ terminal: TerminalInfo; active: boolean; dimmed?: boolean }>()
/** The terminal was clicked or took the keyboard: it should become the active one. */
const emit = defineEmits<{ focus: [] }>()

const container = ref<HTMLElement | null>(null)
const search = ref<InstanceType<typeof TerminalSearch> | null>(null)
const searchOpen = ref(false)

const term = useTerminal({
  terminalId: props.terminal.id,
  claudeSession: props.terminal.mode === 'session',
  container,
  active: toRef(props, 'active'),
})
const { containerBackground, inactiveVeil } = useTerminalAppearance()
const settings = useSettingsStore()
const ui = useUiStore()
const { closeTerminal, restartTerminal } = useTerminalActions()

// Only the bottom padding is set here. At the top the rows reach up to the edge, useTerminal's
// align keeps the top padding while the start of the output is visible. Left and right
// useTerminal's fit places the columns, the scrollbar lies in the right padding.
const paddingBottom = computed(() => `${settings.settings.terminal.padding.bottom}px`)
const exited = computed(() => props.terminal.status === 'exited')

// Files dropped on the terminal: their paths are pasted, like in Windows Terminal. Claude Code
// attaches pasted image paths as images.
const dragging = ref(false)
/** dragenter/dragleave also fire for every child element. */
let dragDepth = 0
const carriesFiles = (event: DragEvent) => !exited.value && !!event.dataTransfer?.types.includes('Files')

function onDragEnter(event: DragEvent) {
  if (!carriesFiles(event)) return
  dragDepth++
  dragging.value = true
}
function onDragOver(event: DragEvent) {
  if (!carriesFiles(event)) return
  event.preventDefault()
  event.dataTransfer!.dropEffect = 'copy'
}
function onDragLeave(event: DragEvent) {
  if (!carriesFiles(event)) return
  dragDepth = Math.max(0, dragDepth - 1)
  if (dragDepth === 0) dragging.value = false
}
function onDrop(event: DragEvent) {
  dragDepth = 0
  dragging.value = false
  if (!carriesFiles(event)) return
  event.preventDefault()
  const paths = [...event.dataTransfer!.files].map((file) => window.api.app.pathForFile(file)).filter(Boolean)
  if (paths.length) term.paste(formatArgs(paths))
}

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

// A session with the app's browser that also starts with Claude in Chrome: Claude might take Chrome.
const browsers = useBrowsersStore()
if (props.terminal.mode === 'session') browsers.refreshChromeStatus()
const chromeHint = computed(() => {
  const claude = settings.settings.claude
  // Started without it already (the setting was on then).
  if (props.terminal.mode !== 'session' || exited.value || /(^|\s)--no-chrome(\s|$)/.test(props.terminal.commandLine)) return false
  if (!claude.browserTools || claude.noClaudeInChrome || claude.claudeInChromeHintDismissed) return false
  const status = browsers.chromeStatus
  return !!status && (status.env || status.accounts.some((account) => account.id === props.terminal.accountId))
})

watch(
  () => ui.searchRequest,
  () => {
    if (!props.active) return
    searchOpen.value = true
    void nextTick(() => search.value?.focus())
  },
)

watch(
  () => ui.focusTerminalRequest,
  () => {
    if (props.active && !searchOpen.value) term.focus()
  },
)

function closeSearch() {
  searchOpen.value = false
  term.clearSearch()
  term.focus()
}
</script>

<template>
  <div
    class="size-full overflow-hidden"
    :style="{ background: containerBackground, paddingBottom }"
    @dragenter="onDragEnter"
    @dragover="onDragOver"
    @dragleave="onDragLeave"
    @drop="onDrop"
    @pointerdown.capture="!active && emit('focus')"
    @focusin="!active && emit('focus')"
  >
    <!-- Aligned to the bottom, so the prompt keeps just the padding there; the top row reaches above
         the container and is cut at the edge of the pane. -->
    <div ref="container" class="flex size-full flex-col justify-end *:shrink-0" />

    <div
      v-if="limit || chromeHint"
      class="pointer-events-none absolute inset-x-0 top-3 z-10 flex flex-col items-center gap-2 px-4"
    >
      <TerminalLimitBanner
        v-if="limit"
        class="pointer-events-auto"
        :terminal="terminal"
        :limit="limit"
        @dismiss="dismissedLimit = limitKey"
      />
      <TerminalChromeBanner v-if="chromeHint" class="pointer-events-auto" :terminal="terminal" />
    </div>

    <div v-if="searchOpen" class="absolute top-3 right-5 z-10">
      <TerminalSearch ref="search" :find-next="term.findNext" :find-previous="term.findPrevious" @close="closeSearch" />
    </div>

    <!-- In a split tab the parts without the keyboard step back. -->
    <div
      aria-hidden="true"
      :class="cn('pointer-events-none absolute inset-0 z-20 transition-opacity duration-150', dimmed ? 'opacity-100' : 'opacity-0')"
      :style="{ background: inactiveVeil }"
    />

    <div
      v-if="dragging"
      class="pointer-events-none absolute inset-2 z-20 flex items-center justify-center rounded-xl border-2 border-dashed border-primary/60 bg-background/30"
    >
      <div class="glass flex items-center gap-2 rounded-xl px-4 py-2 text-sm shadow-lg ring-1 ring-foreground/10">
        <FileInputIcon class="size-4 text-primary" />
        {{ terminal.mode === 'session' ? 'Loslassen fügt den Pfad ein, Bilder hängt Claude an' : 'Loslassen fügt den Pfad ein' }}
      </div>
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
