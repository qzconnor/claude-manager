<script setup lang="ts">
import { SearchIcon } from '@lucide/vue'
import { ListboxRoot } from 'reka-ui'
import { useRoute } from 'vue-router'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { useUiStore } from '@/stores/ui'
import TabSearchList from './TabSearchList.vue'

/**
 * Opens the search through the tabs and sessions (Strg+Umschalt+A). `vertical`: a search field
 * at the top of the tabs in the sidebar, with the results beside it; otherwise a button in the title bar.
 */
defineProps<{ vertical?: boolean }>()

const route = useRoute()
const ui = useUiStore()

/** Back to the terminal instead of the button, also after Escape. */
function onCloseAutoFocus(event: Event) {
  if (route.name !== 'terminals') return
  event.preventDefault()
  ui.focusTerminalRequest++
}
</script>

<template>
  <Popover v-model:open="ui.tabSearchOpen">
    <PopoverTrigger v-if="vertical" as-child>
      <button
        type="button"
        :class="
          cn(
            'flex h-8 w-full shrink-0 cursor-pointer items-center gap-2 rounded-lg px-2.5 text-xs text-muted-foreground ring-1 ring-foreground/10 transition-colors outline-none',
            'hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 aria-expanded:bg-accent aria-expanded:text-foreground',
          )
        "
      >
        <SearchIcon class="size-3.5 shrink-0" />
        <span class="min-w-0 flex-1 truncate text-left">Tabs und Sessions suchen</span>
      </button>
    </PopoverTrigger>
    <!-- The tooltip sits inside the trigger: a popover trigger inside a tooltip would anchor the
         popover to the tooltip's own positioning and leave it nowhere. -->
    <PopoverTrigger v-else as-child>
      <span class="group/search app-no-drag flex shrink-0">
        <Tooltip>
          <TooltipTrigger as-child>
            <button
              type="button"
              aria-label="Tabs und Sessions suchen"
              class="flex size-8 cursor-pointer items-center justify-center rounded-lg text-muted-foreground transition-colors outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 group-aria-expanded/search:bg-accent group-aria-expanded/search:text-foreground"
            >
              <SearchIcon class="size-4" />
            </button>
          </TooltipTrigger>
          <TooltipContent>Tabs und Sessions suchen (Strg+Umschalt+A)</TooltipContent>
        </Tooltip>
      </span>
    </PopoverTrigger>

    <PopoverContent
      :side="vertical ? 'right' : 'bottom'"
      :align="vertical ? 'start' : 'end'"
      :side-offset="vertical ? 12 : 6"
      :collision-padding="8"
      class="w-[32rem] gap-0 overflow-hidden p-0"
      @close-auto-focus="onCloseAutoFocus"
    >
      <ListboxRoot highlight-on-hover class="flex min-h-0 flex-col">
        <TabSearchList @done="ui.tabSearchOpen = false" />
      </ListboxRoot>
    </PopoverContent>
  </Popover>
</template>
