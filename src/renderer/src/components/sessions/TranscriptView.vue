<script setup lang="ts">
import { computed } from 'vue'
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
import { useClock } from '@/composables/useClock'
import { formatNumber } from '@/lib/format'
import { transcriptRows } from '@/lib/transcript-days'
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
defineEmits<{ loadOlder: [] }>()

// „Heute“ becomes „Gestern“ after midnight.
const now = useClock(60_000)
const rows = computed(() => transcriptRows(props.messages, now.value))
const older = computed(() => Math.max(0, props.total - props.messages.length))
</script>

<template>
  <MessageScrollerProvider default-scroll-position="end">
    <MessageScroller>
      <MessageScrollerViewport>
        <MessageScrollerContent class="mx-auto w-full max-w-3xl gap-6 px-6 py-6">
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
            <MessageScrollerItem v-else :message-id="row.message.uuid">
              <TranscriptMessage :message="row.message" :account-id="accountId" :session-id="sessionId" />
            </MessageScrollerItem>
          </template>
        </MessageScrollerContent>
      </MessageScrollerViewport>
      <MessageScrollerButton />
    </MessageScroller>
  </MessageScrollerProvider>
</template>
