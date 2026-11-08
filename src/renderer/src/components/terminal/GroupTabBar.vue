<script setup lang="ts">
import { Columns2Icon, EllipsisIcon, GlobeIcon, Rows2Icon, XIcon } from '@lucide/vue'
import { useEventListener } from '@vueuse/core'
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { layoutPanes } from '@shared/panes'
import type { SplitDirection } from '@shared/types'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useLauncher } from '@/composables/useLauncher'
import { useTabDrag } from '@/composables/useTabDrag'
import { useTerminalActions } from '@/composables/useTerminalActions'
import { useTerminalAppearance } from '@/composables/useTerminalAppearance'
import { groupDropSpot, TAB_BAR_HEIGHT } from '@/lib/workspace'
import { useTerminalsStore, type GroupView } from '@/stores/terminals'
import { useUiStore } from '@/stores/ui'
import NewTerminalMenu from './NewTerminalMenu.vue'
import PageTab from './PageTab.vue'
import GroupTerminalTab from './GroupTerminalTab.vue'

/**
 * The tab bar of a group, like an editor group's in VS Code: its tabs, a button for a new session in
 * it, and on the right the split button and the group's menu. Tabs are dragged within the bar to
 * reorder them, onto another group's bar to move them there, or onto a group's content to split it.
 */
const props = defineProps<{ group: GroupView; focused: boolean }>()

const terminals = useTerminalsStore()
const ui = useUiStore()
const launcher = useLauncher()
const { closeGroup } = useTerminalActions()
const bar = ref<HTMLElement | null>(null)
const strip = ref<HTMLElement | null>(null)

// The selected tab stacks the same layers as the content below it, so it has exactly its colour.
const { containerBackground } = useTerminalAppearance()
const joined = computed(() => {
  const shown = props.group.tabs.find((t) => t.id === props.group.active)
  return shown?.terminal
    ? { background: `linear-gradient(${containerBackground.value}, ${containerBackground.value}), var(--surface)` }
    : { background: 'var(--surface)' }
})

function select(id: string) {
  terminals.activateTab(id)
}

/** The terminal the group shows, which a split starts like. */
const shownTerminal = computed(() => props.group.tabs.find((t) => t.id === props.group.active)?.terminal ?? null)

/** A new session beside the group; with a page shown, an empty group takes it. */
async function split(direction: SplitDirection) {
  if (shownTerminal.value) {
    await launcher.split(shownTerminal.value, direction)
    return
  }
  const id = terminals.splitEmpty(props.group.id, direction === 'row' ? 'right' : 'down')
  const info = await launcher.newSession()
  if (!info) terminals.removeEmptyGroup(id)
}

/** A browser always belongs to a session: the one the group shows, or the session of the browser it shows. */
const sessionShown = computed(() => terminals.sessionFor(shownTerminal.value))

/** Where a tab dragged to this point (viewport px) lands; null over its own bar, where it is reordered. */
function dropAt(tabId: string, x: number, y: number) {
  const own = bar.value?.getBoundingClientRect()
  if (own && x >= own.left && x <= own.right && y >= own.top && y <= own.bottom) return null
  const page = document.querySelector('[data-slot="terminal-workspace"]')?.getBoundingClientRect()
  if (!page?.width || !page.height) return null
  const rects = new Map(
    [...layoutPanes(terminals.workspace.layout).panes].map(([id, r]) => [
      id,
      { left: r.left * page.width, top: r.top * page.height, width: r.width * page.width, height: r.height * page.height },
    ]),
  )
  const spot = groupDropSpot(rects, x - page.left, y - page.top, TAB_BAR_HEIGHT)
  if (!spot) return null
  if (spot.groupId === props.group.id && (spot.side === 'center' || props.group.tabs.length < 2)) return null
  return { tabId, ...spot }
}

const { dragging } = useTabDrag(strip, {
  vertical: false,
  onDrop: (tabId, index) => terminals.move(tabId, index),
  lone: true,
  outside: {
    over: (tabId, x, y) => {
      const next = dropAt(tabId, x, y)
      const current = ui.groupDock
      if (next?.groupId !== current?.groupId || next?.side !== current?.side) ui.groupDock = next
      return next !== null
    },
    drop: () => {
      const dock = ui.groupDock
      if (dock) terminals.dropTab(dock.tabId, dock.groupId, dock.side)
    },
    end: () => (ui.groupDock = null),
  },
})
watch(dragging, (id) => (ui.draggingTab = id))
onBeforeUnmount(() => {
  if (dragging.value) ui.draggingTab = null
})

// A vertical mouse wheel scrolls the tabs horizontally.
useEventListener(
  strip,
  'wheel',
  (event: WheelEvent) => {
    if (!strip.value || Math.abs(event.deltaY) < Math.abs(event.deltaX)) return
    strip.value.scrollLeft += event.deltaY
    event.preventDefault()
  },
  { passive: false },
)

// The shown tab stays in view.
watch(
  () => props.group.active,
  (id) => {
    if (!id) return
    void nextTick(() => {
      const el = strip.value?.querySelector<HTMLElement>(`[data-terminal-id="${CSS.escape(id)}"]`)
      el?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
    })
  },
  { immediate: true },
)

const iconButton =
  'app-no-drag flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground transition-colors outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 aria-expanded:bg-accent aria-expanded:text-foreground'
</script>

<template>
  <!-- A press anywhere on the bar gives its group the keyboard, so "+" opens the session in it. -->
  <div
    ref="bar"
    data-group-bar
    :data-group-id="group.id"
    class="flex min-w-0 items-stretch pt-1"
    :style="{ height: `${TAB_BAR_HEIGHT}px` }"
    @pointerdown.capture="!focused && terminals.focusGroup(group.id)"
  >
    <div class="w-1.5 shrink-0 border-b" />
    <div ref="strip" role="tablist" class="no-scrollbar flex min-w-0 overflow-x-auto">
      <template v-for="tab in group.tabs" :key="tab.id">
        <GroupTerminalTab
          v-if="tab.terminal"
          :terminal="tab.terminal"
          :group-id="group.id"
          :selected="tab.id === group.active"
          :focused="focused && tab.id === group.active"
          :joined="joined"
          @select="select"
        />
        <PageTab
          v-else
          :page="tab.page"
          :group-id="group.id"
          :selected="tab.id === group.active"
          :focused="focused && tab.id === group.active"
          :joined="joined"
          @select="select"
        />
      </template>
    </div>
    <div class="flex min-w-0 flex-1 items-center gap-0.5 border-b pr-1.5 pl-0.5">
      <NewTerminalMenu class="[&_button]:h-7" />
      <div class="min-w-0 flex-1" />
      <Tooltip>
        <TooltipTrigger as-child>
          <button type="button" aria-label="Neue Session rechts" :class="iconButton" @click="split('row')">
            <Columns2Icon class="size-4" />
          </button>
        </TooltipTrigger>
        <TooltipContent>Neue Session rechts (Alt+Umschalt+Plus)</TooltipContent>
      </Tooltip>
      <DropdownMenu>
        <DropdownMenuTrigger as-child>
          <button type="button" aria-label="Gruppe" :class="iconButton">
            <EllipsisIcon class="size-4" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" class="w-64">
          <DropdownMenuItem @select="split('row')">
            <Columns2Icon />
            Neue Session rechts
            <DropdownMenuShortcut>Alt+Umschalt+Plus</DropdownMenuShortcut>
          </DropdownMenuItem>
          <DropdownMenuItem @select="split('column')">
            <Rows2Icon />
            Neue Session unten
            <DropdownMenuShortcut>Alt+Umschalt+Minus</DropdownMenuShortcut>
          </DropdownMenuItem>
          <DropdownMenuItem :disabled="!sessionShown" @select="launcher.browserFor(shownTerminal)">
            <GlobeIcon />
            Browser daneben öffnen
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem :disabled="terminals.groups.length < 2 && group.tabs.length === 0" @select="closeGroup(group.id)">
            <XIcon />
            Gruppe schließen
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  </div>
</template>
