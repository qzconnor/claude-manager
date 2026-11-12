<script setup lang="ts">
import { computed, ref } from 'vue'
import { promptParts } from '@shared/pasted'
import type { TranscriptMessage } from '@shared/types'
import { Bubble, BubbleContent } from '@/components/ui/bubble'
import { Message, MessageContent, MessageHeader } from '@/components/ui/message'
import MarkdownContent from './MarkdownContent.vue'
import PastedBlock from './PastedBlock.vue'

/**
 * What the user wrote, in a bubble: as markdown with every line break as typed, or with a click as the
 * plain text. Pasted text is a block of its own, as it was pasted.
 */
const props = defineProps<{ message: TranscriptMessage; time: string; continued?: boolean }>()

const parts = computed(() => promptParts(props.message.text))
const typed = computed(() => parts.value.some((part) => part.kind === 'text'))
const markdown = ref(true)
</script>

<template>
  <Message align="end">
    <MessageContent>
      <MessageHeader v-if="typed || !continued" class="justify-end gap-2 px-0">
        <button
          v-if="typed"
          type="button"
          :aria-pressed="markdown"
          v-tooltip="markdown ? 'Als Text anzeigen' : 'Als Markdown anzeigen'"
          class="cursor-pointer rounded-sm px-1 text-[0.7rem] text-muted-foreground/70 opacity-0 transition-opacity outline-none group-hover/message:opacity-100 hover:text-foreground focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring/50"
          @click="markdown = !markdown"
        >
          {{ markdown ? 'Markdown' : 'Text' }}
        </button>
        <span v-if="!continued">Du<template v-if="time"> · {{ time }}</template></span>
      </MessageHeader>
      <Bubble variant="tinted" align="end">
        <BubbleContent class="flex min-w-0 flex-col gap-2">
          <template v-for="(part, index) in parts" :key="index">
            <PastedBlock v-if="part.kind === 'pasted'" :text="part.text" />
            <MarkdownContent v-else-if="markdown" :source="part.text" breaks />
            <p v-else class="selectable whitespace-pre-wrap">{{ part.text }}</p>
          </template>
        </BubbleContent>
      </Bubble>
    </MessageContent>
  </Message>
</template>
