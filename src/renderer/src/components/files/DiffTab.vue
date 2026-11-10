<script setup lang="ts">
import { FileDiffIcon, PanelBottomIcon, PanelRightIcon, PinIcon, XIcon } from '@lucide/vue'
import { computed } from 'vue'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuTrigger,
} from '@/components/ui/context-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { fileIcon } from '@/lib/file-icons'
import { baseName } from '@/lib/file-tree'
import { cn } from '@/lib/utils'
import { diffTab, type DiffFile } from '@/lib/workspace'
import { SEPARATOR } from '@/stores/file-tree'
import { useTerminalsStore } from '@/stores/terminals'

/**
 * The changes of a file as a tab of a group, as VS Code shows a file opened from its explorer: one
 * opened by a click previews (its name in italics) and the next click takes its place; a double click
 * on the file or on the tab keeps it. The folder itself (`''`): all its changes, one below the other.
 */
const props = defineProps<{ file: DiffFile; groupId: string; selected: boolean; focused: boolean; joined: Record<string, string> }>()
const emit = defineEmits<{ select: [id: string] }>()

const terminals = useTerminalsStore()
const id = computed(() => diffTab(props.file))
/** All changes of the folder, not those of one file. */
const all = computed(() => props.file.path === '')
const name = computed(() => (all.value ? 'Alle Änderungen' : baseName(props.file.path)))
const icon = computed(() =>
  all.value ? { icon: FileDiffIcon, class: 'text-muted-foreground' } : fileIcon(props.file.path, { dir: false, link: false, broken: false }),
)
const preview = computed(() => terminals.previewTabs.has(id.value))
const fullPath = computed(() => (all.value ? props.file.root : `${props.file.root}${SEPARATOR}${props.file.path.replaceAll('/', SEPARATOR)}`))
const alone = computed(() => (terminals.groups.find((g) => g.id === props.groupId)?.tabs.length ?? 0) < 2)

function onMouseDown(event: MouseEvent) {
  if (event.button !== 1) return
  event.preventDefault()
  terminals.closeDiff(id.value)
}
</script>

<template>
  <ContextMenu>
    <Tooltip :delay-duration="600">
      <ContextMenuTrigger as-child>
        <TooltipTrigger as-child>
          <div
            role="tab"
            :data-terminal-id="id"
            :aria-selected="selected"
            :class="
              cn(
                'app-no-drag group/tab relative flex h-full max-w-56 min-w-28 shrink-0 cursor-pointer items-center gap-2 rounded-t-lg border pr-1 pl-3 text-xs transition-colors data-docking:opacity-50',
                selected
                  ? cn('border-border border-b-transparent', focused ? 'text-foreground' : 'text-muted-foreground')
                  : 'border-transparent border-b-border text-muted-foreground hover:bg-accent/60 hover:text-foreground data-dragging:bg-surface-strong data-dragging:text-foreground data-dragging:shadow-md',
              )
            "
            :style="selected ? joined : undefined"
            @click="emit('select', id)"
            @dblclick="terminals.keepDiff(id)"
            @mousedown="onMouseDown"
          >
            <component :is="icon.icon" :class="cn('size-3.5 shrink-0', icon.class)" />
            <span :class="cn('min-w-0 flex-1 truncate', preview && 'italic')">{{ name }}</span>
            <button
              type="button"
              :aria-label="`${name} schließen`"
              :class="
                cn(
                  'flex size-5 shrink-0 items-center justify-center rounded-md text-muted-foreground opacity-0 transition-opacity group-hover/tab:opacity-100 hover:bg-accent hover:text-foreground',
                  selected && 'opacity-100',
                )
              "
              @click.stop="terminals.closeDiff(id)"
            >
              <XIcon class="size-3.5" />
            </button>
          </div>
        </TooltipTrigger>
      </ContextMenuTrigger>
      <TooltipContent side="bottom" class="max-w-[min(36rem,80vw)] break-all">
        {{ all ? 'Alle Änderungen' : 'Änderungen' }}: {{ fullPath }}<span v-if="preview" class="text-muted-foreground"> · Vorschau</span>
      </TooltipContent>
    </Tooltip>
    <ContextMenuContent class="w-60">
      <ContextMenuItem v-if="preview" @select="terminals.keepDiff(id)">
        <PinIcon />
        Tab behalten
      </ContextMenuItem>
      <ContextMenuItem :disabled="alone" @select="terminals.dropTab(id, groupId, 'right')">
        <PanelRightIcon />
        In Gruppe rechts verschieben
      </ContextMenuItem>
      <ContextMenuItem :disabled="alone" @select="terminals.dropTab(id, groupId, 'down')">
        <PanelBottomIcon />
        In Gruppe unten verschieben
      </ContextMenuItem>
      <ContextMenuSeparator />
      <ContextMenuItem @select="terminals.closeDiff(id)">
        <XIcon />
        Schließen
        <ContextMenuShortcut v-if="focused">Strg+Umschalt+W</ContextMenuShortcut>
      </ContextMenuItem>
    </ContextMenuContent>
  </ContextMenu>
</template>
