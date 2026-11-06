<script setup lang="ts">
import { ChevronDownIcon, ChevronUpIcon, XIcon } from '@lucide/vue'
import { computed, nextTick, ref, watch } from 'vue'
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from '@/components/ui/input-group'

/**
 * The search in a browser page (Ctrl+F), like the terminal's. The page searches by itself and
 * reports its matches later (`matches`), so the pane runs it: `search` with the text, from the start
 * (`again` false) or to the next match.
 */
const props = defineProps<{ matches: { active: number; total: number } | null }>()
const emit = defineEmits<{ search: [query: string, forward: boolean, again: boolean]; close: [] }>()

const query = ref('')
const root = ref<HTMLElement | null>(null)

const notFound = computed(() => !!query.value && props.matches?.total === 0)
const count = computed(() => {
  if (!query.value || !props.matches) return ''
  return `${props.matches.total ? props.matches.active : 0}/${props.matches.total}`
})

watch(query, (text) => emit('search', text, true, false))

/** The next (or previous) match; a search that found nothing starts again. */
function step(forward: boolean) {
  if (query.value) emit('search', query.value, forward, true)
}

function focus() {
  void nextTick(() => {
    const el = root.value?.querySelector('input')
    el?.focus()
    el?.select()
  })
}

function onKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape') {
    event.preventDefault()
    emit('close')
  } else if (event.key === 'Enter') {
    event.preventDefault()
    step(!event.shiftKey)
  }
}

defineExpose({ focus, step, query })
</script>

<template>
  <div ref="root" class="glass w-80 rounded-lg shadow-lg ring-1 ring-foreground/10">
    <InputGroup>
      <InputGroupInput
        v-model="query"
        placeholder="Auf der Seite suchen"
        aria-label="Auf der Seite suchen"
        spellcheck="false"
        :aria-invalid="notFound || undefined"
        @keydown="onKeydown"
      />
      <InputGroupAddon align="inline-end">
        <span v-if="count" class="pr-1 text-xs text-muted-foreground tabular-nums" aria-live="polite">{{ count }}</span>
        <InputGroupButton size="icon-xs" aria-label="Vorheriger Treffer" title="Vorheriger Treffer (Umschalt+Enter)" @click="step(false)">
          <ChevronUpIcon />
        </InputGroupButton>
        <InputGroupButton size="icon-xs" aria-label="Nächster Treffer" title="Nächster Treffer (Enter)" @click="step(true)">
          <ChevronDownIcon />
        </InputGroupButton>
        <InputGroupButton size="icon-xs" aria-label="Suche schließen" title="Suche schließen (Esc)" @click="emit('close')">
          <XIcon />
        </InputGroupButton>
      </InputGroupAddon>
    </InputGroup>
  </div>
</template>
