<script setup lang="ts">
import { SearchIcon } from '@lucide/vue'
import { useUiStore } from '@/stores/ui'

/** Like VS Code's command center: opens the quick open, which searches tabs, sessions and commands. */
const ui = useUiStore()
</script>

<template>
  <button
    type="button"
    class="app-no-drag flex h-7 w-[min(32rem,38vw)] min-w-44 cursor-pointer items-center gap-2 rounded-lg bg-foreground/5 px-2.5 text-xs text-muted-foreground ring-1 ring-foreground/10 transition-colors outline-none hover:bg-foreground/8 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
    @click="ui.openPalette()"
  >
    <SearchIcon class="size-3.5 shrink-0" />
    <span class="min-w-0 flex-1 truncate text-center">Tabs, Sessions und Befehle suchen</span>
    <span class="shrink-0 text-[11px] opacity-70">Strg+Umschalt+A</span>
  </button>
</template>
