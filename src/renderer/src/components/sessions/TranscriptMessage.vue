<script setup lang="ts">
import { BellIcon, ChevronRightIcon, InfoIcon, ScrollTextIcon } from '@lucide/vue'
import { computed } from 'vue'
import type { TranscriptMessage } from '@shared/types'
import { Bubble, BubbleContent } from '@/components/ui/bubble'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Marker, MarkerContent, MarkerIcon } from '@/components/ui/marker'
import { Message, MessageContent, MessageHeader } from '@/components/ui/message'
import {
  Trace,
  TraceCollapsible,
  TraceCollapsibleContent,
  TraceCollapsibleTrigger,
  TraceDescription,
  TraceIcon,
  TraceTitle,
} from '@/components/ui/trace'
import CodeBlock from './CodeBlock.vue'
import MarkdownContent from './MarkdownContent.vue'
import TranscriptPrompt from './TranscriptPrompt.vue'
import TranscriptToolCall from './TranscriptToolCall.vue'

/** `continued`: it goes on from the message before it, by the same author: without its head. */
const props = defineProps<{ message: TranscriptMessage; continued?: boolean; accountId: string; sessionId: string }>()

const timeFormat = new Intl.DateTimeFormat('de', { hour: '2-digit', minute: '2-digit' })
const time = computed(() => {
  const ms = props.message.timestamp ? Date.parse(props.message.timestamp) : NaN
  return Number.isNaN(ms) ? '' : timeFormat.format(ms)
})
</script>

<template>
  <Marker v-if="message.kind === 'compact'" variant="separator" class="text-xs">
    <MarkerIcon><InfoIcon /></MarkerIcon>
    <MarkerContent>{{ message.text }}</MarkerContent>
  </Marker>

  <!-- What a compaction kept: closed, it is a line between the parts of the conversation. -->
  <Collapsible v-else-if="message.kind === 'summary'" class="flex flex-col">
    <CollapsibleTrigger
      class="group/summary flex w-full cursor-pointer items-center gap-2 rounded-md text-xs text-muted-foreground transition-colors outline-none before:mr-1 before:h-px before:min-w-0 before:flex-1 before:bg-border after:ml-1 after:h-px after:min-w-0 after:flex-1 after:bg-border hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
    >
      <ScrollTextIcon class="size-4 shrink-0" />
      Zusammenfassung des bisherigen Gesprächs
      <ChevronRightIcon class="size-3.5 shrink-0 transition-transform group-data-[state=open]/summary:rotate-90" />
    </CollapsibleTrigger>
    <CollapsibleContent>
      <div class="mt-3 rounded-lg border bg-muted/40 px-4 py-3 text-sm">
        <MarkdownContent :source="message.text" />
      </div>
    </CollapsibleContent>
  </Collapsible>

  <!-- A background task Claude started reports back: in Claude's flow, its result inside. -->
  <Trace v-else-if="message.kind === 'task'">
    <TraceCollapsible :disabled="!message.output">
      <TraceCollapsibleTrigger class="gap-2">
        <TraceIcon :data-status="message.failed ? 'error' : undefined"><BellIcon /></TraceIcon>
        <TraceTitle class="shrink-0 font-medium text-foreground">Hintergrundaufgabe</TraceTitle>
        <TraceDescription class="min-w-0 shrink truncate text-xs">{{ message.text }}</TraceDescription>
        <span v-if="time" class="shrink-0 text-xs text-muted-foreground/70">· {{ time }}</span>
      </TraceCollapsibleTrigger>
      <TraceCollapsibleContent v-if="message.output" class="text-sm text-foreground">
        <MarkdownContent :source="message.output" />
      </TraceCollapsibleContent>
    </TraceCollapsible>
  </Trace>

  <!-- A slash command or one typed after „!“, with what it printed, as in the terminal. -->
  <Message v-else-if="message.kind === 'command' || message.kind === 'shell'" align="end">
    <MessageContent>
      <MessageHeader v-if="!continued" class="justify-end px-0">Du<template v-if="time"> · {{ time }}</template></MessageHeader>
      <div
        :class="[
          'flex w-fit max-w-[80%] min-w-0 flex-col self-end overflow-hidden rounded-md border bg-(--code-bg)',
          message.failed ? 'border-destructive/40' : 'border-border/70',
        ]"
      >
        <CodeBlock
          bare
          :code="message.text"
          :language="message.kind === 'shell' ? 'bash' : null"
          :prompt="message.kind === 'shell' ? '!' : ''"
        />
        <CodeBlock
          v-if="message.output"
          bare
          class="border-t border-border/50"
          :code="message.output"
          :tone="message.failed ? 'error' : 'default'"
          :max-lines="12"
        />
      </div>
    </MessageContent>
  </Message>

  <TranscriptPrompt v-else-if="message.role === 'user'" :message="message" :time="time" :continued="continued" />

  <Message v-else>
    <MessageContent>
      <MessageHeader v-if="!continued" class="gap-1.5 px-0">
        Claude
        <span v-if="message.model" class="font-normal">· {{ message.model }}</span>
        <span v-if="time" class="font-normal">· {{ time }}</span>
      </MessageHeader>
      <Bubble v-if="message.text" variant="ghost">
        <BubbleContent>
          <MarkdownContent :source="message.text" />
        </BubbleContent>
      </Bubble>
      <Trace v-if="message.tools.length" class="gap-1.5">
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
