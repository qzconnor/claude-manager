<script setup lang="ts">
import { FilesIcon } from '@lucide/vue'
import { useMediaQuery } from '@vueuse/core'
import { computed, useId } from 'vue'
import type { FileTouchKind } from '@shared/types'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useFileTreeToggle } from '@/composables/useFileTreeToggle'
import { cn } from '@/lib/utils'
import { useFileTreeStore, type TreeTarget } from '@/stores/file-tree'

/**
 * Opens and closes a file tree: in a group's tab bar that of the tab the group shows (`group`), in the
 * title bar that of the terminal the window works in (`titlebar`). It sits on the side the tree opens on.
 * While Claude works in the session's files and the tree is closed, a light runs across its icon in the
 * colour of what it does, like across the names in the tree.
 */
const props = defineProps<{ target: TreeTarget | null; variant: 'group' | 'titlebar' }>()

const { shown, toggle } = useFileTreeToggle()
const fileTree = useFileTreeStore()

/** In the title bar the tree belongs to the terminals page: on another page the button is not pressed. */
const pressed = computed(() => shown(props.target))

const label = computed(() => (pressed.value ? 'Dateibaum schließen' : 'Dateibaum öffnen'))
const tooltip = computed(() => (props.target ? `${label.value} (Strg+Umschalt+E)` : 'Dateibaum: Dieser Tab arbeitet in keinem Ordner'))

/**
 * The strongest of what Claude does in the session's files right now, as in the tree; only while the
 * tree is closed, an open one shows it itself.
 */
const RANK: Record<FileTouchKind, number> = { search: 0, read: 1, commit: 2, write: 3 }
const activity = computed<FileTouchKind | null>(() => {
  if (pressed.value) return null
  let strongest: FileTouchKind | null = null
  for (const touch of fileTree.touchesOf(props.target?.session.id)?.values() ?? []) {
    if (!strongest || RANK[touch.kind] > RANK[strongest]) strongest = touch.kind
  }
  return strongest
})

// The light is a gradient the icon's lines are drawn with; without motion the icon only takes the colour.
const shine = `file-tree-shine-${useId()}`
const still = useMediaQuery('(prefers-reduced-motion: reduce)')
</script>

<template>
  <Tooltip>
    <TooltipTrigger as-child>
      <button
        type="button"
        :aria-label="label"
        :aria-pressed="pressed"
        :aria-disabled="!target || undefined"
        :data-touch="activity ?? undefined"
        :class="
          cn(
            'app-no-drag relative flex shrink-0 cursor-pointer items-center justify-center text-muted-foreground transition-colors outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50',
            'aria-pressed:bg-accent aria-pressed:text-foreground aria-disabled:cursor-default aria-disabled:opacity-40 aria-disabled:hover:bg-transparent aria-disabled:hover:text-muted-foreground',
            variant === 'group' ? 'size-[24px] rounded-md' : 'size-[32px] rounded-lg',
            activity && 'text-(--touch) hover:text-(--touch)',
          )
        "
        @click="toggle(target)"
      >
        <!-- In the icon's own units (24 wide): a bright band runs from left to right. -->
        <svg v-if="activity && !still" aria-hidden="true" class="absolute size-0">
          <defs>
            <linearGradient :id="shine" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="24" y2="0">
              <stop offset="0.3" style="stop-color: var(--touch)" />
              <stop offset="0.5" style="stop-color: color-mix(in oklab, var(--touch) 25%, var(--foreground))" />
              <stop offset="0.7" style="stop-color: var(--touch)" />
              <animateTransform attributeName="gradientTransform" type="translate" from="-24 0" to="24 0" dur="1.3s" repeatCount="indefinite" />
            </linearGradient>
          </defs>
        </svg>
        <FilesIcon class="size-[16px]" :style="activity && !still ? { stroke: `url(#${shine})` } : undefined" />
      </button>
    </TooltipTrigger>
    <TooltipContent>{{ tooltip }}</TooltipContent>
  </Tooltip>
</template>
