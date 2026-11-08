<script setup lang="ts">
import { SearchIcon } from '@lucide/vue'
import { ListboxFilter } from 'reka-ui'
import { nextTick, onMounted, ref, watch } from 'vue'
import { useCommand } from '@/components/ui/command'

/**
 * The input of the quick open in the commands mode: shows the whole text with the `>`, but the
 * commands are filtered by what follows it.
 */
defineProps<{ placeholder: string; hint?: string }>()
const query = defineModel<string>({ required: true })
const { filterState } = useCommand()
const field = ref<InstanceType<typeof ListboxFilter> | null>(null)

watch(
  query,
  (value) => {
    filterState.search = value.replace(/^>\s*/, '')
  },
  { immediate: true },
)

// Coming from another mode with the prefix typed: the caret goes behind it.
onMounted(() =>
  nextTick(() => {
    const input = (field.value?.$el as HTMLElement | undefined)?.closest('input') ?? (field.value?.$el as HTMLInputElement | undefined)
    if (input instanceof HTMLInputElement) input.setSelectionRange(input.value.length, input.value.length)
  }),
)
</script>

<template>
  <div class="flex items-center gap-2.5 border-b px-3.5">
    <SearchIcon class="size-4 shrink-0 text-muted-foreground" />
    <ListboxFilter
      ref="field"
      v-model="query"
      auto-focus
      :placeholder="placeholder"
      :aria-label="placeholder"
      spellcheck="false"
      class="h-11 min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
    />
    <span v-if="hint" class="shrink-0 text-xs text-muted-foreground">{{ hint }}</span>
  </div>
</template>
