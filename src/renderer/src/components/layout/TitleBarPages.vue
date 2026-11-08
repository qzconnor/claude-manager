<script setup lang="ts">
import { computed } from 'vue'
import { useRouter } from 'vue-router'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { PAGE_INFO } from '@/lib/pages'
import { cn } from '@/lib/utils'
import { PAGES, type PageName } from '@/lib/workspace'
import { UPDATES_ROUTE } from '@/router'
import { useTerminalsStore } from '@/stores/terminals'
import { useUpdatesStore } from '@/stores/updates'

/** The app's pages, which open as tabs in the active group, where the nav rail used to list them. */
const router = useRouter()
const terminals = useTerminalsStore()
const updates = useUpdatesStore()

/**
 * The updates are a tab of the settings: a waiting update pulses on their button, release notes
 * still unread after an update get a dot. Either way the button then opens the updates tab.
 */
const updatesPending = computed(() => updates.hasUpdate || updates.unseen)

function tooltip(page: PageName) {
  const { label, shortcut } = PAGE_INFO[page]
  const base = shortcut ? `${label} (${shortcut})` : label
  if (page !== 'settings') return base
  if (updates.hasUpdate) return `${base} · Version ${updates.state.next} ist verfügbar`
  if (updates.unseen) return `${base} · Neu in Version ${updates.state.current}`
  return base
}

function open(page: PageName) {
  void router.push(page === 'settings' && updatesPending.value ? UPDATES_ROUTE : { name: page })
}
</script>

<template>
  <div class="flex shrink-0 items-center">
    <Tooltip v-for="page in PAGES" :key="page">
      <TooltipTrigger as-child>
        <button
          type="button"
          :aria-label="PAGE_INFO[page].label"
          :aria-pressed="terminals.focusedPage === page"
          :class="
            cn(
              'app-no-drag relative flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-lg text-muted-foreground transition-colors outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50',
              terminals.focusedPage === page && 'bg-accent text-foreground',
            )
          "
          @click="open(page)"
        >
          <component :is="PAGE_INFO[page].icon" class="size-4" />
          <template v-if="page === 'settings'">
            <span v-if="updates.hasUpdate" class="absolute top-1 right-1 flex size-2">
              <span class="absolute size-full animate-ping rounded-full bg-success opacity-75" />
              <span class="relative size-2 rounded-full bg-success" />
            </span>
            <span v-else-if="updates.unseen" class="absolute top-1 right-1 size-2 rounded-full bg-success" />
          </template>
        </button>
      </TooltipTrigger>
      <TooltipContent>{{ tooltip(page) }}</TooltipContent>
    </Tooltip>
  </div>
</template>
