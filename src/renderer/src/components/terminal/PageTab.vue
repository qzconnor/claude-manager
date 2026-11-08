<script setup lang="ts">
import { PanelBottomIcon, PanelRightIcon, XIcon } from '@lucide/vue'
import { computed } from 'vue'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuTrigger,
} from '@/components/ui/context-menu'
import { PAGE_INFO } from '@/lib/pages'
import { cn } from '@/lib/utils'
import { pageTab, type PageName } from '@/lib/workspace'
import { useTerminalsStore } from '@/stores/terminals'
import { useUpdatesStore } from '@/stores/updates'

/** A page of the app (settings, sessions, …) as a tab of a group, like VS Code's settings editor. */
const props = defineProps<{ page: PageName; groupId: string; selected: boolean; focused: boolean; joined: Record<string, string> }>()
const emit = defineEmits<{ select: [id: string] }>()

const terminals = useTerminalsStore()
const updates = useUpdatesStore()
const info = computed(() => PAGE_INFO[props.page])
const id = computed(() => pageTab(props.page))
const alone = computed(() => (terminals.groups.find((g) => g.id === props.groupId)?.tabs.length ?? 0) < 2)
/** An update waiting or unread release notes: a dot on the settings, as on their button. */
const dot = computed(() => props.page === 'settings' && (updates.hasUpdate || updates.unseen))

function onMouseDown(event: MouseEvent) {
  if (event.button !== 1) return
  event.preventDefault()
  terminals.closePage(props.page)
}
</script>

<template>
  <ContextMenu>
    <ContextMenuTrigger as-child>
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
        @mousedown="onMouseDown"
      >
        <component :is="info.icon" class="size-3.5 shrink-0" />
        <span class="min-w-0 flex-1 truncate">{{ info.label }}</span>
        <button
          type="button"
          :aria-label="`${info.label} schließen`"
          :class="
            cn(
              'flex size-5 shrink-0 items-center justify-center rounded-md text-muted-foreground opacity-0 transition-opacity group-hover/tab:opacity-100 hover:bg-accent hover:text-foreground',
              (selected || dot) && 'opacity-100',
            )
          "
          @click.stop="terminals.closePage(page)"
        >
          <span v-if="dot" class="size-2 rounded-full bg-success group-hover/tab:hidden" />
          <XIcon :class="cn('size-3.5', dot && 'hidden group-hover/tab:block')" />
        </button>
      </div>
    </ContextMenuTrigger>
    <ContextMenuContent class="w-60">
      <ContextMenuItem :disabled="alone" @select="terminals.dropTab(id, groupId, 'right')">
        <PanelRightIcon />
        In Gruppe rechts verschieben
      </ContextMenuItem>
      <ContextMenuItem :disabled="alone" @select="terminals.dropTab(id, groupId, 'down')">
        <PanelBottomIcon />
        In Gruppe unten verschieben
      </ContextMenuItem>
      <ContextMenuSeparator />
      <ContextMenuItem @select="terminals.closePage(page)">
        <XIcon />
        Schließen
        <ContextMenuShortcut v-if="focused">Strg+Umschalt+W</ContextMenuShortcut>
      </ContextMenuItem>
    </ContextMenuContent>
  </ContextMenu>
</template>
