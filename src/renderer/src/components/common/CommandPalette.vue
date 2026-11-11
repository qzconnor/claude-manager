<script setup lang="ts">
import { ListboxRoot } from 'reka-ui'
import { computed, ref } from 'vue'
import { useRoute } from 'vue-router'
import { searchTerms } from '@shared/utils'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import TabSearchList from '@/components/terminal/TabSearchList.vue'
import { useMatchHighlight } from '@/composables/useMatchHighlight'
import { cn } from '@/lib/utils'
import { useTerminalsStore } from '@/stores/terminals'
import { useUiStore } from '@/stores/ui'
import PaletteCommands from './PaletteCommands.vue'
import PaletteHelp from './PaletteHelp.vue'

/**
 * The quick open, like VS Code's: one field at the top of the window, and what is typed decides what
 * it searches. Without a prefix the open tabs and the sessions (Strg+Umschalt+A), after `>` the
 * commands (Strg+Umschalt+P), after `?` the list of prefixes.
 */
const route = useRoute()
const ui = useUiStore()
const terminals = useTerminalsStore()

const mode = computed(() => (ui.paletteQuery.startsWith('>') ? 'commands' : ui.paletteQuery.startsWith('?') ? 'help' : 'tabs'))

/** What was typed is colored in the commands, tabs and sessions found; the prefixes don't count. */
const results = ref<HTMLElement | null>(null)
const terms = computed(() => (mode.value === 'help' ? [] : searchTerms(ui.paletteQuery.replace(/^>\s*/, ''))))
useMatchHighlight(() => results.value, () => terms.value)

let keepFocus = false
function done(keep = false) {
  keepFocus = keep
  ui.paletteOpen = false
}

/** Back to the terminal with the keyboard instead of the title bar, also after Escape. */
function onCloseAutoFocus(event: Event) {
  if (keepFocus) {
    keepFocus = false
    event.preventDefault()
    return
  }
  // On a page it stays there (in groups: the page's tab has the keyboard).
  if (terminals.grouped ? terminals.focusedPage : route.name !== 'terminals') return
  event.preventDefault()
  ui.focusTerminalRequest++
}
</script>

<template>
  <Dialog v-model:open="ui.paletteOpen">
    <!-- One column no wider than the dialog: with an auto column the rows' long paths widened it past
         the right edge, which cut off the shortcuts and the scrollbar. In groups it hangs under the
         title bar's search, which is centred in the space left of the caption buttons. The backdrop
         leaves the title bar out (as for every dialog), so the search it opened from stays sharp above it. -->
    <DialogContent
      :show-close-button="false"
      :class="
        cn(
          'app-no-drag top-[calc(var(--titlebar-height)+0.375rem)] translate-y-0 grid-cols-[minmax(0,1fr)] gap-0 overflow-hidden rounded-xl! p-0 sm:max-w-[38rem]',
          terminals.grouped && 'left-[calc((100%-var(--caption-buttons-width))/2)]',
        )
      "
      @close-auto-focus="onCloseAutoFocus"
    >
      <DialogHeader class="sr-only">
        <DialogTitle>Suchen</DialogTitle>
        <DialogDescription>Tabs und Sessions suchen, mit &gt; Befehle, mit ? die Möglichkeiten</DialogDescription>
      </DialogHeader>
      <!-- `contents`: no box of its own, the dialog's grid lays out the mode as before. -->
      <div ref="results" class="contents">
        <PaletteCommands v-if="mode === 'commands'" v-model:query="ui.paletteQuery" @done="done" />
        <PaletteHelp v-else-if="mode === 'help'" v-model:query="ui.paletteQuery" />
        <ListboxRoot v-else highlight-on-hover class="flex min-h-0 flex-col">
          <TabSearchList v-model:query="ui.paletteQuery" @done="done()" />
        </ListboxRoot>
      </div>
    </DialogContent>
  </Dialog>
</template>
