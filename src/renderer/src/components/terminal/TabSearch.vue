<script setup lang="ts">
import { SearchIcon } from '@lucide/vue'
import { computed } from 'vue'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { useUiStore } from '@/stores/ui'

/**
 * Opens the quick open on the search through the tabs and sessions (Strg+Umschalt+A). `vertical`: a
 * search field at the top of the tabs in the sidebar; otherwise a button in the title bar.
 */
defineProps<{ vertical?: boolean }>()

const ui = useUiStore()
/** Open on the tabs, not on the commands. */
const open = computed(() => ui.paletteOpen && !/^[>?]/.test(ui.paletteQuery))
</script>

<template>
  <button
    v-if="vertical"
    type="button"
    :aria-expanded="open"
    :class="
      cn(
        'flex h-8 w-full shrink-0 cursor-pointer items-center gap-2 rounded-lg px-2.5 text-xs text-muted-foreground ring-1 ring-foreground/10 transition-colors outline-none',
        'hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 aria-expanded:bg-accent aria-expanded:text-foreground',
      )
    "
    @click="ui.openPalette()"
  >
    <SearchIcon class="size-3.5 shrink-0" />
    <span class="min-w-0 flex-1 truncate text-left">Tabs und Sessions suchen</span>
  </button>
  <Tooltip v-else>
    <TooltipTrigger as-child>
      <button
        type="button"
        aria-label="Tabs und Sessions suchen"
        :aria-expanded="open"
        class="app-no-drag flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-lg text-muted-foreground transition-colors outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 aria-expanded:bg-accent aria-expanded:text-foreground"
        @click="ui.openPalette()"
      >
        <SearchIcon class="size-4" />
      </button>
    </TooltipTrigger>
    <TooltipContent>Tabs und Sessions suchen (Strg+Umschalt+A)</TooltipContent>
  </Tooltip>
</template>
