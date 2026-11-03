<script setup lang="ts">
import { ChevronDownIcon, ChevronRightIcon, PlusIcon } from '@lucide/vue'
import { DropdownMenu, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useLauncher } from '@/composables/useLauncher'
import { cn } from '@/lib/utils'
import NewTerminalMenuContent from './NewTerminalMenuContent.vue'

/** `vertical`: a row below the tabs in the sidebar instead of a button pair in the title bar. */
defineProps<{ vertical?: boolean }>()

const launcher = useLauncher()

/** Borderless and with the hover of a tab, so the buttons blend in with the tab strip. */
const titleBarButton =
  'flex h-8 cursor-pointer items-center justify-center rounded-lg transition-colors outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 aria-expanded:bg-accent aria-expanded:text-foreground'
</script>

<template>
  <div
    v-if="vertical"
    class="group/new flex h-8 w-full shrink-0 items-center rounded-lg pr-1 text-xs text-muted-foreground transition-colors has-focus-visible:ring-2 has-focus-visible:ring-ring/50 hover:bg-accent hover:text-foreground has-aria-expanded:bg-accent has-aria-expanded:text-foreground"
  >
    <!-- Looks like a tab, so it reads as the next entry of the list. The chevron shows up on hover
         like the close button of a tab and opens its menu beside the sidebar. -->
    <Tooltip>
      <TooltipTrigger as-child>
        <button
          type="button"
          class="flex h-full min-w-0 flex-1 cursor-pointer items-center gap-2 pl-3 text-left outline-none"
          @click="launcher.newSession()"
        >
          <PlusIcon class="size-3.5 shrink-0" />
          <span class="truncate">Neue Session</span>
        </button>
      </TooltipTrigger>
      <TooltipContent side="right">Neue Session (Strg+Umschalt+T)</TooltipContent>
    </Tooltip>
    <DropdownMenu>
      <DropdownMenuTrigger as-child>
        <button
          type="button"
          aria-label="Weitere Optionen"
          class="flex size-5 shrink-0 cursor-pointer items-center justify-center rounded-md opacity-0 transition-opacity outline-none group-hover/new:opacity-100 hover:bg-foreground/10 focus-visible:opacity-100 aria-expanded:opacity-100"
        >
          <ChevronRightIcon class="size-3.5" />
        </button>
      </DropdownMenuTrigger>
      <NewTerminalMenuContent side="right" :side-offset="12" />
    </DropdownMenu>
  </div>

  <div
    v-else
    class="app-no-drag flex shrink-0 items-center text-muted-foreground transition-opacity in-data-unfocused:opacity-75"
  >
    <!-- Like the new-tab buttons of Windows Terminal: a plus and a narrow chevron, each lit on its own. -->
    <Tooltip>
      <TooltipTrigger as-child>
        <button
          type="button"
          aria-label="Neue Session"
          :class="cn(titleBarButton, 'w-8')"
          @click="launcher.newSession()"
        >
          <PlusIcon class="size-4.5" />
        </button>
      </TooltipTrigger>
      <TooltipContent>Neue Session (Strg+Umschalt+T)</TooltipContent>
    </Tooltip>
    <DropdownMenu>
      <DropdownMenuTrigger as-child>
        <button type="button" aria-label="Weitere Optionen" :class="cn(titleBarButton, 'w-6')">
          <ChevronDownIcon class="size-3.5" />
        </button>
      </DropdownMenuTrigger>
      <NewTerminalMenuContent />
    </DropdownMenu>
  </div>
</template>
