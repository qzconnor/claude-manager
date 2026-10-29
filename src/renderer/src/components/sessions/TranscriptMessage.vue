<script setup lang="ts">
import { InfoIcon } from '@lucide/vue'
import type { TranscriptMessage } from '@shared/types'
import { Bubble, BubbleContent } from '@/components/ui/bubble'
import { Marker, MarkerContent, MarkerIcon } from '@/components/ui/marker'
import { Message, MessageContent, MessageHeader } from '@/components/ui/message'
import { Trace } from '@/components/ui/trace'
import MarkdownContent from './MarkdownContent.vue'
import TranscriptToolCall from './TranscriptToolCall.vue'

defineProps<{ message: TranscriptMessage; accountId: string; sessionId: string }>()

const time = new Intl.DateTimeFormat('de', { hour: '2-digit', minute: '2-digit' })
function formatTime(iso: string | null): string {
  if (!iso) return ''
  const ms = Date.parse(iso)
  return Number.isNaN(ms) ? '' : time.format(ms)
}
</script>

<template>
  <Marker v-if="message.role === 'system'" variant="separator" class="text-xs">
    <MarkerIcon><InfoIcon /></MarkerIcon>
    <MarkerContent>{{ message.text }}</MarkerContent>
  </Marker>

  <Message v-else-if="message.role === 'user'" align="end">
    <MessageContent>
      <MessageHeader class="justify-end">Du · {{ formatTime(message.timestamp) }}</MessageHeader>
      <Bubble variant="tinted" align="end">
        <BubbleContent class="selectable whitespace-pre-wrap">{{ message.text }}</BubbleContent>
      </Bubble>
    </MessageContent>
  </Message>

  <Message v-else>
    <MessageContent>
      <MessageHeader class="gap-1.5">
        Claude
        <span v-if="message.model" class="font-normal">· {{ message.model }}</span>
        <span class="font-normal">· {{ formatTime(message.timestamp) }}</span>
      </MessageHeader>
      <Bubble v-if="message.text" variant="ghost">
        <BubbleContent>
          <MarkdownContent :source="message.text" />
        </BubbleContent>
      </Bubble>
      <Trace v-if="message.tools.length" class="gap-1">
        <TranscriptToolCall
          v-for="(tool, index) in message.tools"
          :key="tool.id ?? index"
          :tool="tool"
          :account-id="accountId"
          :session-id="sessionId"
        />
      </Trace>
    </MessageContent>
  </Message>
</template>
