<script setup lang="ts">
import { Columns2Icon, Rows2Icon } from '@lucide/vue'
import { computed } from 'vue'
import { useRoute } from 'vue-router'
import type { SplitDirection } from '@shared/types'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useLauncher } from '@/composables/useLauncher'
import { useTerminalsStore } from '@/stores/terminals'

/** Buttons that split the active terminal, beside the bell; only while the terminals are shown. */
const route = useRoute()
const terminals = useTerminalsStore()
const launcher = useLauncher()

const terminal = computed(() => (route.name === 'terminals' ? terminals.active : null))

const buttons: { direction: SplitDirection; label: string; shortcut: string; icon: typeof Columns2Icon }[] = [
  { direction: 'row', label: 'Vertikal teilen', shortcut: 'Alt+Umschalt+Plus', icon: Columns2Icon },
  { direction: 'column', label: 'Horizontal teilen', shortcut: 'Alt+Umschalt+Minus', icon: Rows2Icon },
]

function split(direction: SplitDirection) {
  if (terminal.value) void launcher.split(terminal.value, direction)
}
</script>

<template>
  <div v-if="terminal" class="flex shrink-0 items-center">
    <Tooltip v-for="button in buttons" :key="button.direction">
      <TooltipTrigger as-child>
        <button
          type="button"
          :aria-label="button.label"
          class="app-no-drag flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-lg text-muted-foreground transition-colors outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
          @click="split(button.direction)"
        >
          <component :is="button.icon" class="size-4" />
        </button>
      </TooltipTrigger>
      <TooltipContent>{{ button.label }} ({{ button.shortcut }})</TooltipContent>
    </Tooltip>
  </div>
</template>
