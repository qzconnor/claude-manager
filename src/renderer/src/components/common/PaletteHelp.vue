<script setup lang="ts">
import { ChevronRightIcon, CircleHelpIcon, SearchIcon } from '@lucide/vue'
import { ListboxContent, ListboxFilter, ListboxItem, ListboxRoot } from 'reka-ui'

/** The help mode of the quick open (`?`): what each prefix does; choosing one types it. */
const query = defineModel<string>('query', { required: true })

const MODES = [
  { prefix: '', label: 'Tabs und Sessions suchen', detail: 'Titel, Ordner und Verlauf der Sessions', shortcut: 'Strg+Umschalt+A', icon: SearchIcon },
  { prefix: '>', label: 'Befehle anzeigen und ausführen', detail: 'Aktionen, Seiten, Einstellungen', shortcut: 'Strg+Umschalt+P', icon: ChevronRightIcon },
  { prefix: '?', label: 'Hilfe', detail: 'Diese Liste', shortcut: '', icon: CircleHelpIcon },
]
</script>

<template>
  <ListboxRoot highlight-on-hover class="flex min-h-0 flex-col">
    <div class="flex items-center gap-2.5 border-b px-3.5">
      <CircleHelpIcon class="size-4 shrink-0 text-muted-foreground" />
      <ListboxFilter
        v-model="query"
        auto-focus
        aria-label="Suchmodus wählen"
        spellcheck="false"
        class="h-11 min-w-0 flex-1 bg-transparent text-sm outline-none"
      />
    </div>
    <ListboxContent class="p-1.5 outline-none">
      <ListboxItem
        v-for="mode in MODES"
        :key="mode.prefix || 'none'"
        :value="mode.prefix || 'none'"
        class="flex cursor-pointer items-center gap-3 rounded-lg px-2 py-1.5 outline-none select-none data-highlighted:bg-accent"
        @select="query = mode.prefix"
      >
        <span class="w-4 shrink-0 text-center font-mono text-sm text-muted-foreground">{{ mode.prefix || '…' }}</span>
        <span class="flex min-w-0 flex-1 flex-col">
          <span class="truncate text-sm">{{ mode.label }}</span>
          <span class="truncate text-xs text-muted-foreground">{{ mode.detail }}</span>
        </span>
        <span v-if="mode.shortcut" class="shrink-0 text-xs text-muted-foreground">{{ mode.shortcut }}</span>
      </ListboxItem>
    </ListboxContent>
  </ListboxRoot>
</template>
