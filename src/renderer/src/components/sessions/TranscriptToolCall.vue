<script setup lang="ts">
import { CircleAlertIcon, WrenchIcon } from '@lucide/vue'
import { ref, watch } from 'vue'
import type { TranscriptToolCall, TranscriptToolDetail } from '@shared/types'
import { Skeleton } from '@/components/ui/skeleton'
import {
  TraceCollapsible,
  TraceCollapsibleContent,
  TraceCollapsibleTrigger,
  TraceDescription,
  TraceIcon,
  TraceTitle,
} from '@/components/ui/trace'
import { errorMessage } from '@/lib/errors'
import { cn } from '@/lib/utils'

const props = defineProps<{ tool: TranscriptToolCall; accountId: string; sessionId: string }>()

const open = ref(false)
const detail = ref<TranscriptToolDetail | null>(null)
const loading = ref(false)
const error = ref<string | null>(null)
let requestId = 0

/** Input and output are only read from disk when the call is expanded. */
async function load() {
  const id = props.tool.id
  if (!id) return
  const request = ++requestId
  loading.value = true
  error.value = null
  try {
    const result = await window.api.sessions.toolCall(props.accountId, props.sessionId, id)
    if (request !== requestId) return
    detail.value = result
    if (!result) error.value = 'Der Aufruf wurde im Transcript nicht gefunden.'
  } catch (e) {
    if (request === requestId) error.value = errorMessage(e)
  } finally {
    if (request === requestId) loading.value = false
  }
}

watch(open, (isOpen) => {
  if (isOpen && !detail.value) void load()
})
// A running session writes the result later: refresh an open call once it arrives.
watch(
  () => props.tool.status,
  () => {
    if (open.value) void load()
    else detail.value = null
  },
)
</script>

<template>
  <TraceCollapsible v-model:open="open" :disabled="!tool.id">
    <TraceCollapsibleTrigger class="gap-2">
      <TraceIcon :data-status="tool.status === 'error' ? 'error' : undefined">
        <CircleAlertIcon v-if="tool.status === 'error'" />
        <WrenchIcon v-else />
      </TraceIcon>
      <TraceTitle class="shrink-0 font-medium text-foreground">{{ tool.name }}</TraceTitle>
      <TraceDescription v-if="tool.summary" class="min-w-0 shrink truncate font-mono text-xs">
        {{ tool.summary }}
      </TraceDescription>
    </TraceCollapsibleTrigger>

    <TraceCollapsibleContent class="flex flex-col gap-3">
      <template v-if="loading && !detail">
        <Skeleton class="h-4 w-1/3" />
        <Skeleton class="h-16 w-full" />
      </template>
      <p v-else-if="error" class="text-xs text-destructive">{{ error }}</p>
      <template v-else-if="detail">
        <section v-for="field in detail.input" :key="field.key" class="flex min-w-0 flex-col gap-1">
          <h4 class="text-xs font-medium text-muted-foreground">{{ field.key }}</h4>
          <pre
            class="selectable max-h-96 overflow-auto rounded-md bg-muted/60 px-3 py-2 font-mono text-xs leading-relaxed whitespace-pre-wrap text-foreground [overflow-wrap:anywhere]"
          >{{ field.value }}</pre>
        </section>
        <section class="flex min-w-0 flex-col gap-1">
          <h4 :class="cn('text-xs font-medium', detail.isError ? 'text-destructive' : 'text-muted-foreground')">
            {{ detail.isError ? 'Fehler' : 'Ergebnis' }}
          </h4>
          <pre
            v-if="detail.output"
            :class="
              cn(
                'selectable max-h-96 overflow-auto rounded-md px-3 py-2 font-mono text-xs leading-relaxed whitespace-pre-wrap [overflow-wrap:anywhere]',
                detail.isError ? 'bg-destructive/10 text-destructive' : 'bg-muted/60 text-foreground',
              )
            "
          >{{ detail.output }}</pre>
          <p v-else class="text-xs">{{ detail.output === null ? 'Kein Ergebnis aufgezeichnet.' : 'Leere Ausgabe.' }}</p>
        </section>
        <p v-if="detail.truncated" class="text-xs">Sehr lange Werte sind nach 200.000 Zeichen gekürzt.</p>
      </template>
    </TraceCollapsibleContent>
  </TraceCollapsible>
</template>
