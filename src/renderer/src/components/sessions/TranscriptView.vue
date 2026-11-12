<script setup lang="ts">
import { useEventListener } from '@vueuse/core'
import { computed, nextTick, ref } from 'vue'
import { CONVERSATION_PAGE_MESSAGES } from '@shared/defaults'
import type { TranscriptMessage as TranscriptMessageData } from '@shared/types'
import { Button } from '@/components/ui/button'
import { Marker, MarkerContent } from '@/components/ui/marker'
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from '@/components/ui/message-scroller'
import { Spinner } from '@/components/ui/spinner'
import BrowserFind from '@/components/terminal/BrowserFind.vue'
import { useClock } from '@/composables/useClock'
import { useDiffStyle } from '@/composables/useDiffStyle'
import { useDomFind } from '@/composables/useDomFind'
import { usePauseWhileHidden } from '@/composables/usePauseWhileHidden'
import { formatNumber } from '@/lib/format'
import { transcriptRows } from '@/lib/transcript-days'
import { useSettingsStore } from '@/stores/settings'
import TranscriptMessage from './TranscriptMessage.vue'

const props = defineProps<{
  messages: TranscriptMessageData[]
  truncated: boolean
  /** All messages of the history; more than `messages` while older ones aren't loaded. */
  total: number
  loadingOlder?: boolean
  accountId: string
  sessionId: string
}>()
const emit = defineEmits<{ loadOlder: [] }>()

// „Heute“ becomes „Gestern“ after midnight, but not while the page is hidden.
usePauseWhileHidden()
const now = useClock(60_000)
const rows = computed(() => transcriptRows(props.messages, now.value))
const older = computed(() => Math.max(0, props.total - props.messages.length))

// Code, commands and diffs in the terminal's colours and font, as the file diff shows them.
// A little smaller than the text around it (13 px at the usual 16).
const { colors, fontFamily } = useDiffStyle()
const settings = useSettingsStore()
const codeStyle = computed(() => {
  const { background, color, ...vars } = colors.value
  const size = Math.max(10, Math.round(settings.settings.appearance.uiFontSize * 0.8125))
  return { ...vars, '--code-bg': background, '--code-fg': color, '--code-font': fontFamily.value, '--code-size': `${size}px` }
})

// --- find in the history (Ctrl+F) -------------------------------------------
const root = ref<HTMLElement | null>(null)
const content = ref<{ $el: HTMLElement } | null>(null)
const findBar = ref<InstanceType<typeof BrowserFind> | null>(null)
const findOpen = ref(false)
/** Searches the messages shown, each as one text. */
const find = useDomFind(() => (findOpen.value ? content.value?.$el : null), '[data-slot=message-scroller-item]')

function openFind() {
  findOpen.value = true
  void nextTick(() => findBar.value?.focus())
}

function closeFind() {
  findOpen.value = false
  find.clear()
}

/** Ctrl+F and F3 while the history is to be seen, unless a terminal or another field has the keyboard for its own search. */
useEventListener(window, 'keydown', (event: KeyboardEvent) => {
  const el = root.value
  if (event.defaultPrevented || event.altKey || !el?.checkVisibility()) return
  const target = event.target instanceof Element ? event.target : null
  if (target?.closest('.xterm, webview') || (target && !el.contains(target) && target.closest('[role=dialog]'))) return
  const ctrlF = (event.ctrlKey || event.metaKey) && !event.shiftKey && event.key.toLowerCase() === 'f'
  if (ctrlF) {
    event.preventDefault()
    openFind()
  } else if (event.key === 'F3' && !event.ctrlKey && !event.metaKey) {
    event.preventDefault()
    if (findOpen.value && findBar.value?.query) findBar.value.step(!event.shiftKey)
    else openFind()
  }
})

function loadOlderForFind() {
  emit('loadOlder')
  findBar.value?.focus()
}
</script>

<template>
  <div ref="root" class="relative flex size-full min-h-0 flex-col">
    <MessageScrollerProvider default-scroll-position="end">
      <MessageScroller>
        <MessageScrollerViewport>
          <MessageScrollerContent ref="content" class="w-full gap-6 px-6 py-6 lg:px-10" :style="codeStyle">
            <div v-if="truncated" class="flex flex-col items-center gap-2 text-xs text-muted-foreground">
              <span>{{ formatNumber(older) }} ältere {{ older === 1 ? 'Nachricht' : 'Nachrichten' }}</span>
              <Button variant="outline" size="xs" :disabled="loadingOlder" @click="$emit('loadOlder')">
                <Spinner v-if="loadingOlder" data-icon="inline-start" />
                {{ older > CONVERSATION_PAGE_MESSAGES ? `${formatNumber(CONVERSATION_PAGE_MESSAGES)} ältere laden` : 'Alle älteren laden' }}
              </Button>
            </div>
            <template v-for="row in rows" :key="row.key">
              <Marker v-if="row.kind === 'day'" variant="separator" class="text-xs">
                <MarkerContent>{{ row.label }}</MarkerContent>
              </Marker>
              <!-- A message that goes on from the one before stands closer to it, without its head. -->
              <MessageScrollerItem v-else :message-id="row.message.uuid" :class="row.continued && '-mt-3'">
                <TranscriptMessage :message="row.message" :continued="row.continued" :account-id="accountId" :session-id="sessionId" />
              </MessageScrollerItem>
            </template>
          </MessageScrollerContent>
        </MessageScrollerViewport>
        <MessageScrollerButton />
      </MessageScroller>
    </MessageScrollerProvider>
    <!-- In the corner like a browser's find bar, clear of the scrollbar. -->
    <div
      v-if="findOpen"
      class="absolute top-2 right-5 z-20 flex max-w-[calc(100%-1.75rem)] flex-col items-end gap-1.5 animate-in fade-in slide-in-from-top-1 duration-150"
    >
      <BrowserFind ref="findBar" label="Im Verlauf suchen" :matches="find.matches.value" @search="find.search" @close="closeFind" />
      <div
        v-if="truncated"
        class="glass flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-xs text-muted-foreground shadow-lg ring-1 ring-foreground/10"
      >
        <span>{{ formatNumber(older) }} ältere {{ older === 1 ? 'Nachricht ist' : 'Nachrichten sind' }} nicht geladen</span>
        <Button variant="outline" size="xs" :disabled="loadingOlder" @click="loadOlderForFind">
          <Spinner v-if="loadingOlder" data-icon="inline-start" />
          Laden
        </Button>
      </div>
    </div>
  </div>
</template>
