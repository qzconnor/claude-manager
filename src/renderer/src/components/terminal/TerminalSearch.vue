<script setup lang="ts">
import { ChevronDownIcon, ChevronUpIcon, XIcon } from '@lucide/vue'
import { nextTick, ref, watch } from 'vue'
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from '@/components/ui/input-group'

const props = defineProps<{
  findNext: (query: string) => boolean
  findPrevious: (query: string) => boolean
}>()
const emit = defineEmits<{ close: [] }>()

const query = ref('')
const notFound = ref(false)
const root = ref<HTMLElement | null>(null)

function run(direction: 'next' | 'previous') {
  if (!query.value) {
    notFound.value = false
    return
  }
  notFound.value = !(direction === 'next' ? props.findNext(query.value) : props.findPrevious(query.value))
}

watch(query, () => run('next'))

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
    run(event.shiftKey ? 'previous' : 'next')
  }
}

defineExpose({ focus })
</script>

<template>
  <div ref="root" class="glass w-72 rounded-lg shadow-lg ring-1 ring-foreground/10">
    <InputGroup>
      <InputGroupInput
        v-model="query"
        placeholder="Im Terminal suchen"
        :aria-invalid="notFound || undefined"
        @keydown="onKeydown"
      />
      <InputGroupAddon align="inline-end">
        <InputGroupButton size="icon-xs" aria-label="Vorheriger Treffer" @click="run('previous')">
          <ChevronUpIcon />
        </InputGroupButton>
        <InputGroupButton size="icon-xs" aria-label="Nächster Treffer" @click="run('next')">
          <ChevronDownIcon />
        </InputGroupButton>
        <InputGroupButton size="icon-xs" aria-label="Suche schließen" @click="emit('close')">
          <XIcon />
        </InputGroupButton>
      </InputGroupAddon>
    </InputGroup>
  </div>
</template>
