<script setup lang="ts">
import { CheckIcon, ChevronRightIcon, ExternalLinkIcon } from '@lucide/vue'
import { computed } from 'vue'
import type { GitFileState } from '@shared/types'
import { fileIcon } from '@/lib/file-icons'
import { baseName, parentPath, STATUS_CLASS, STATUS_LABEL, STATUS_LETTER } from '@/lib/file-tree'
import type { SeenState } from '@/lib/file-diff'
import { cn } from '@/lib/utils'

/**
 * The head of a file in the review of all changes: a click on it folds the file, then its name and
 * folder, its state in git and what changed, and the mark that it was seen (which folds it too).
 * The card of the file rounds it; unfolded, a line parts it from the lines.
 */
const props = defineProps<{
  path: string
  /** The file in the file system, for the tooltip. */
  absolute: string
  state: GitFileState | null
  added: number
  removed: number
  collapsed: boolean
  seen: SeenState
  /** Something to know about the changes, beside the name (e.g. that only line endings changed). */
  notice?: string | null
}>()
const emit = defineEmits<{ toggle: []; seen: []; open: [] }>()

const icon = computed(() => fileIcon(props.path, { dir: false, link: false, broken: false }))
const name = computed(() => baseName(props.path))
const dir = computed(() => parentPath(props.path))

const iconButton =
  'flex size-[24px] shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground transition-colors outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50'
</script>

<template>
  <div
    :class="
      cn(
        'flex h-full cursor-pointer items-center gap-1.5 pr-1.5 pl-1.5 font-sans text-xs text-foreground [background:linear-gradient(var(--diff-header),var(--diff-header)),var(--background)]',
        !collapsed && 'border-b',
      )
    "
    @click="emit('toggle')"
  >
    <button
      type="button"
      :aria-label="collapsed ? `${name} aufklappen` : `${name} zuklappen`"
      :aria-expanded="!collapsed"
      :class="iconButton"
      @click.stop="emit('toggle')"
    >
      <ChevronRightIcon :class="cn('size-[14px] transition-transform duration-150', !collapsed && 'rotate-90')" />
    </button>
    <component :is="icon.icon" :class="cn('size-[16px] shrink-0', icon.class)" />
    <span :class="cn('shrink-0 font-medium', state?.status === 'deleted' && 'line-through')" v-tooltip="absolute">{{ name }}</span>
    <span v-if="dir" class="min-w-0 truncate text-muted-foreground" v-tooltip="absolute">{{ dir }}</span>
    <span v-if="notice" class="min-w-0 truncate text-muted-foreground/80" v-tooltip="notice">· {{ notice }}</span>
    <span class="flex-1" />
    <span v-if="seen === 'changed'" class="shrink-0 truncate text-[11px] text-warning">Geändert, seit gesehen</span>
    <span
      v-if="state"
      :class="cn('shrink-0 font-mono text-[11px] font-semibold', STATUS_CLASS[state.status])"
      v-tooltip="STATUS_LABEL[state.status] + (state.staged ? ', vorgemerkt' : '')"
    >
      {{ STATUS_LETTER[state.status] }}
    </span>
    <span v-if="added || removed" class="shrink-0 font-mono text-[11px] tabular-nums">
      <span v-if="added" class="text-success">+{{ added }}</span>
      <span v-if="added && removed">&nbsp;</span>
      <span v-if="removed" class="text-destructive">−{{ removed }}</span>
    </span>
    <!-- Like the mark on GitHub: seen files fold, the next one follows. -->
    <button
      type="button"
      :aria-pressed="seen === 'yes'"
      :class="
        cn(
          'ml-1 flex h-[22px] shrink-0 cursor-pointer items-center gap-1.5 rounded-md px-[6px] text-[11px] text-muted-foreground ring-1 ring-foreground/12 transition-colors outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50',
          seen === 'yes' && 'bg-foreground/8 text-foreground',
        )
      "
      v-tooltip="seen === 'yes' ? 'Als nicht gesehen markieren' : 'Als gesehen markieren und zuklappen'"
      @click.stop="emit('seen')"
    >
      <span
        :class="
          cn(
            'flex size-[13px] items-center justify-center rounded-[4px] ring-1 ring-foreground/30',
            seen === 'yes' && 'bg-primary text-primary-foreground ring-primary',
          )
        "
      >
        <CheckIcon v-if="seen === 'yes'" class="size-[10px]" :stroke-width="3" />
      </span>
      Gesehen
    </button>
    <button type="button" aria-label="Mit dem Standardprogramm öffnen" :class="iconButton" v-tooltip="'Mit dem Standardprogramm öffnen'" @click.stop="emit('open')">
      <ExternalLinkIcon class="size-[14px]" />
    </button>
  </div>
</template>
