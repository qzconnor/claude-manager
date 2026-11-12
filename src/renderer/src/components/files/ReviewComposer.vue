<script setup lang="ts">
import { MessageSquarePlusIcon, MessageSquareTextIcon } from '@lucide/vue'
import { nextTick, ref, watch } from 'vue'
import { Button } from '@/components/ui/button'
import { Kbd, KbdGroup } from '@/components/ui/kbd'

/**
 * Writes a comment on the lines picked in the changes, below them: Strg+Enter keeps it with the
 * others for Claude, Esc lets it go. `place`: what it is on, e.g. „a.ts · Zeilen 12–18“; `focusKey`
 * changes when other lines were picked, which gives it the keyboard again.
 */
const props = defineProps<{ place: string; editing: boolean; canSave: boolean; focusKey: string }>()
const text = defineModel<string>({ required: true })
const emit = defineEmits<{ save: []; cancel: []; remove: [] }>()

const area = ref<HTMLTextAreaElement | null>(null)
watch(
  () => props.focusKey,
  () => void nextTick(() => area.value?.focus({ preventScroll: true })),
  { immediate: true },
)

function onKeydown(event: KeyboardEvent) {
  if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
    event.preventDefault()
    if (props.canSave) emit('save')
  } else if (event.key === 'Escape') {
    event.preventDefault()
    event.stopPropagation()
    emit('cancel')
  }
}
</script>

<template>
  <form
    class="flex shrink-0 flex-col gap-2 border-t bg-background px-3 py-2.5 font-sans text-foreground"
    :aria-label="editing ? 'Kommentar ändern' : 'Kommentar für Claude'"
    @submit.prevent="canSave && emit('save')"
  >
    <div class="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
      <MessageSquareTextIcon v-if="editing" class="size-[14px] shrink-0 text-primary" />
      <MessageSquarePlusIcon v-else class="size-[14px] shrink-0 text-primary" />
      <span class="shrink-0 font-medium text-foreground">{{ editing ? 'Kommentar ändern' : 'Kommentar für Claude' }}</span>
      <span class="min-w-0 truncate">· {{ place }}</span>
    </div>
    <textarea
      ref="area"
      v-model="text"
      rows="2"
      aria-label="Kommentar"
      placeholder="Was soll Claude an diesen Zeilen ändern?"
      class="field-sizing-content max-h-40 min-h-14 w-full resize-none rounded-lg border border-input bg-transparent px-2.5 py-2 text-sm outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30"
      @keydown="onKeydown"
    />
    <div class="flex items-center gap-2">
      <KbdGroup class="text-muted-foreground"><Kbd>Strg</Kbd><Kbd>Enter</Kbd></KbdGroup>
      <span class="flex-1" />
      <Button v-if="editing" type="button" variant="ghost" size="sm" class="text-destructive hover:text-destructive" @click="emit('remove')">
        Löschen
      </Button>
      <Button type="button" variant="ghost" size="sm" @click="emit('cancel')">Abbrechen</Button>
      <Button type="submit" size="sm" :disabled="!canSave">{{ editing ? 'Speichern' : 'Hinzufügen' }}</Button>
    </div>
  </form>
</template>
