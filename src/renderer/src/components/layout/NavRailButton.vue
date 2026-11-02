<script setup lang="ts">
import { computed, type Component } from 'vue'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'

/**
 * An entry of the nav rail. As a narrow rail it is just an icon with a tooltip. In the wide
 * sidebar it also shows its label, and the tooltip only stays for extra details like a shortcut.
 */
const props = defineProps<{
  label: string
  icon: Component
  iconClass?: string
  /** Defaults to the label. */
  tooltip?: string
  expanded: boolean
  active?: boolean
  /** Renders a link (for RouterLink's custom slot) instead of a button. */
  href?: string
}>()
const emit = defineEmits<{ click: [event: MouseEvent] }>()

const tooltipText = computed(() => props.tooltip ?? props.label)
</script>

<template>
  <Tooltip :disabled="expanded && tooltipText === label">
    <TooltipTrigger as-child>
      <Button
        :as="href ? 'a' : 'button'"
        :href="href"
        :variant="active ? 'secondary' : 'ghost'"
        :size="expanded ? 'lg' : 'icon-lg'"
        :class="cn('relative', expanded && 'w-full justify-start gap-2.5')"
        :aria-label="expanded ? undefined : tooltipText"
        :aria-current="href && active ? 'page' : undefined"
        @click="emit('click', $event)"
      >
        <component :is="icon" :class="cn(expanded ? 'size-4.5' : 'size-5', iconClass)" />
        <span v-if="expanded" class="min-w-0 flex-1 truncate text-left">{{ label }}</span>
        <!-- Badges and dots: in the corner of the icon, or at the end of the row. -->
        <slot />
      </Button>
    </TooltipTrigger>
    <TooltipContent side="right">{{ tooltipText }}</TooltipContent>
  </Tooltip>
</template>
