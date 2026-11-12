<script setup lang="ts">
import { ChevronRightIcon, ClipboardPasteIcon } from '@lucide/vue'
import { computed, ref } from 'vue'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { formatNumber } from '@/lib/format'
import { cn } from '@/lib/utils'

/** Text pasted into a prompt, as a block of its own: closed it shows how long it is and how it starts. */
const props = defineProps<{ text: string }>()

const open = ref(false)
const lineCount = computed(() => props.text.split('\n').length)
const firstLine = computed(() => props.text.split('\n').find((line) => line.trim())?.trim() ?? '')
</script>

<template>
  <Collapsible v-model:open="open" class="flex min-w-0 flex-col overflow-hidden rounded-lg border border-foreground/10 bg-background/50">
    <CollapsibleTrigger
      class="flex w-full min-w-0 cursor-pointer items-center gap-2 px-2.5 py-1.5 text-left text-xs outline-none hover:bg-foreground/5 focus-visible:ring-2 focus-visible:ring-ring/50"
    >
      <ClipboardPasteIcon class="size-3.5 shrink-0 text-muted-foreground" />
      <span class="shrink-0 font-medium">Eingefügter Text</span>
      <span class="shrink-0 text-muted-foreground tabular-nums">{{ lineCount === 1 ? '1 Zeile' : `${formatNumber(lineCount)} Zeilen` }}</span>
      <span v-if="!open" class="min-w-0 truncate font-mono text-muted-foreground/80">{{ firstLine }}</span>
      <ChevronRightIcon :class="cn('ml-auto size-3.5 shrink-0 text-muted-foreground transition-transform', open && 'rotate-90')" />
    </CollapsibleTrigger>
    <CollapsibleContent>
      <pre
        class="selectable max-h-96 overflow-auto border-t border-foreground/10 px-3 py-2 font-mono text-xs leading-relaxed whitespace-pre-wrap [overflow-wrap:anywhere]"
      >{{ text }}</pre>
    </CollapsibleContent>
  </Collapsible>
</template>
