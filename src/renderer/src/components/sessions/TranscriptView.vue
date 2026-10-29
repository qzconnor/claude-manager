<script setup lang="ts">
import type { TranscriptMessage as TranscriptMessageData } from '@shared/types'
import { Marker, MarkerContent } from '@/components/ui/marker'
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from '@/components/ui/message-scroller'
import TranscriptMessage from './TranscriptMessage.vue'

defineProps<{ messages: TranscriptMessageData[]; truncated: boolean; accountId: string; sessionId: string }>()
</script>

<template>
  <MessageScrollerProvider default-scroll-position="end">
    <MessageScroller>
      <MessageScrollerViewport>
        <MessageScrollerContent class="mx-auto w-full max-w-3xl gap-6 px-6 py-6">
          <Marker v-if="truncated" variant="separator" class="text-xs">
            <MarkerContent>Ältere Nachrichten ausgeblendet – nur der neueste Teil wird angezeigt.</MarkerContent>
          </Marker>
          <MessageScrollerItem v-for="message in messages" :key="message.uuid" :message-id="message.uuid">
            <TranscriptMessage :message="message" :account-id="accountId" :session-id="sessionId" />
          </MessageScrollerItem>
        </MessageScrollerContent>
      </MessageScrollerViewport>
      <MessageScrollerButton />
    </MessageScroller>
  </MessageScrollerProvider>
</template>
