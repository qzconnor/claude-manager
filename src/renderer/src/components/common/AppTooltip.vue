<script setup lang="ts">
import { useEventListener } from '@vueuse/core'
import { TooltipRoot } from 'reka-ui'
import { TooltipContent } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { hideTooltip, tooltip } from '@/lib/tooltip'

/**
 * The tooltip of `v-tooltip` (see lib/tooltip.ts): one for the whole app, the same as `<Tooltip>`,
 * at the element the pointer is over. Gone at once when it closes: still fading out, it would take the
 * next one with it.
 */

// It would stay where the element was.
useEventListener(window, 'scroll', () => hideTooltip(), { capture: true, passive: true })
useEventListener(window, 'blur', () => hideTooltip())

function onOpen(open: boolean) {
  if (!open) hideTooltip()
}
</script>

<template>
  <TooltipRoot :open="tooltip.el !== null" disable-hoverable-content @update:open="onOpen">
    <TooltipContent
      v-if="tooltip.el"
      :reference="tooltip.el"
      :side="tooltip.side"
      :aria-label="tooltip.text"
      :class="
        cn(
          // Line breaks of the text stay; a path too long for the width breaks where it must.
          'whitespace-pre-line wrap-anywhere',
          tooltip.animated &&
            'animate-in fade-in-0 zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2',
        )
      "
    >
      {{ tooltip.text }}
    </TooltipContent>
  </TooltipRoot>
</template>
