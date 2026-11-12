<script setup lang="ts">
import { CheckIcon, XIcon } from '@lucide/vue'
import { computed, ref, watch } from 'vue'
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
import { languageOf } from '@/lib/syntax'
import { editsOf, inputValue, shellLanguage, toolFile, toolIcon, toolTitle } from '@/lib/tool-calls'
import { cn } from '@/lib/utils'
import CodeBlock from './CodeBlock.vue'
import SnippetDiffView from './SnippetDiffView.vue'

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

const name = computed(() => toolTitle(props.tool.name))
const icon = computed(() => toolIcon(props.tool.name))
const shell = computed(() => shellLanguage(props.tool.name))
/** Next to the name: what Claude said a command does (the command stands below it), else the summary. */
const headline = computed(() => (props.tool.command !== null ? (props.tool.description ?? '') : props.tool.summary))

const file = computed(() => (detail.value ? toolFile(detail.value.input) : null))
const fileLanguage = computed(() => (file.value ? languageOf(file.value.replace(/\\/g, '/')) : null))
const edits = computed(() => (detail.value ? editsOf(detail.value.name, detail.value.input) : []))
const written = computed(() => (detail.value?.name === 'Write' ? inputValue(detail.value.input, 'content') : null))

/** Inputs the view shows in another way, per tool: the command, the file, the change. */
const SHOWN_OTHERWISE: Record<string, string[]> = {
  Bash: ['command', 'description'],
  PowerShell: ['command', 'description'],
  Read: ['file_path', 'offset', 'limit', 'pages'],
  Write: ['file_path', 'content'],
  Edit: ['file_path', 'old_string', 'new_string', 'replace_all'],
  MultiEdit: ['file_path', 'edits'],
}
const inputs = computed(() => {
  const hidden = new Set(SHOWN_OTHERWISE[props.tool.name] ?? [])
  // An Edit whose change can't be read shows its inputs as they are.
  if (props.tool.name.endsWith('Edit') && edits.value.length === 0) hidden.clear()
  return detail.value?.input.filter((field) => !hidden.has(field.key)) ?? []
})
const isJson = (value: string) => /^\s*[[{]/.test(value)
</script>

<template>
  <TraceCollapsible v-model:open="open" :disabled="!tool.id">
    <TraceCollapsibleTrigger class="gap-2">
      <TraceIcon :data-status="tool.status === 'error' ? 'error' : undefined">
        <component :is="icon" />
      </TraceIcon>
      <TraceTitle class="shrink-0 font-medium text-foreground">{{ name.title }}</TraceTitle>
      <span v-if="name.server" class="shrink-0 text-xs text-muted-foreground/70">{{ name.server }}</span>
      <TraceDescription
        v-if="headline"
        :class="cn('min-w-0 shrink truncate text-xs', tool.command === null && 'font-mono')"
      >
        {{ headline }}
      </TraceDescription>
      <span v-if="tool.detail" class="shrink-0 text-xs text-muted-foreground/70">· {{ tool.detail }}</span>
      <XIcon v-if="tool.status === 'error'" class="size-3.5 shrink-0" aria-label="Fehlgeschlagen" />
      <CheckIcon v-else-if="tool.status === 'ok'" class="size-3.5 shrink-0 text-muted-foreground/60" aria-label="Erledigt" />
    </TraceCollapsibleTrigger>

    <!-- A command can be read without opening the call. -->
    <CodeBlock v-if="tool.command !== null" class="mt-1.5 ml-6" :code="tool.command" :language="shell" :max-lines="12" />

    <TraceCollapsibleContent class="flex flex-col gap-3">
      <template v-if="loading && !detail">
        <Skeleton class="h-4 w-1/3" />
        <Skeleton class="h-16 w-full" />
      </template>
      <p v-else-if="error" class="text-xs text-destructive">{{ error }}</p>
      <template v-else-if="detail">
        <section v-if="file && detail.name !== 'Read'" class="flex min-w-0 flex-col gap-1">
          <h4 class="text-xs font-medium text-muted-foreground">Datei</h4>
          <span class="selectable font-mono text-xs [overflow-wrap:anywhere] text-foreground">{{ file }}</span>
        </section>
        <SnippetDiffView v-for="(edit, index) in edits" :key="index" :before="edit.before" :after="edit.after" :language="fileLanguage" />
        <CodeBlock v-if="written !== null" :code="written" :language="fileLanguage" :max-lines="20" />
        <section v-for="field in inputs" :key="field.key" class="flex min-w-0 flex-col gap-1">
          <h4 class="text-xs font-medium text-muted-foreground">{{ field.key }}</h4>
          <CodeBlock :code="field.value" :language="isJson(field.value) ? 'json' : null" :max-lines="20" />
        </section>
        <section class="flex min-w-0 flex-col gap-1">
          <h4 :class="cn('text-xs font-medium', detail.isError ? 'text-destructive' : 'text-muted-foreground')">
            {{ detail.isError ? 'Fehler' : 'Ergebnis' }}
          </h4>
          <CodeBlock v-if="detail.output" :code="detail.output" :tone="detail.isError ? 'error' : 'default'" :max-lines="20" />
          <p v-else class="text-xs">{{ detail.output === null ? 'Kein Ergebnis aufgezeichnet.' : 'Leere Ausgabe.' }}</p>
        </section>
        <p v-if="detail.truncated" class="text-xs">Sehr lange Werte sind nach 200.000 Zeichen gekürzt.</p>
      </template>
    </TraceCollapsibleContent>
  </TraceCollapsible>
</template>
