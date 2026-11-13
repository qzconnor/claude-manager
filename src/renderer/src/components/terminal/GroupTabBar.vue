<script setup lang="ts">
import { Columns2Icon, EllipsisIcon, GlobeIcon, Rows2Icon, XIcon } from '@lucide/vue'
import { useEventListener } from '@vueuse/core'
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { layoutPanes } from '@shared/panes'
import type { SplitDirection } from '@shared/types'
import GitBranchChip from '@/components/common/GitBranchChip.vue'
import FileTreeButton from '@/components/files/FileTreeButton.vue'
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
import { useOverflowFade } from '@/composables/useOverflowFade'
import { useRovingTabs } from '@/composables/useRovingTabs'
import { useTabDrag } from '@/composables/useTabDrag'
import { useTerminalActions } from '@/composables/useTerminalActions'
import { useTerminalAppearance } from '@/composables/useTerminalAppearance'
import { BROWSER_TAB, groupDropSpot, TAB_BAR_HEIGHT } from '@/lib/workspace'
import { useFileTreeStore } from '@/stores/file-tree'
import { useSettingsStore } from '@/stores/settings'
import { useTerminalsStore, type GroupView } from '@/stores/terminals'
import { useUiStore } from '@/stores/ui'
import NewTerminalMenu from './NewTerminalMenu.vue'
import DiffTab from '@/components/files/DiffTab.vue'
import BrowserTab from './BrowserTab.vue'
import PageTab from './PageTab.vue'
import GroupTerminalTab from './GroupTerminalTab.vue'

/**
 * The tab bar of a group, like an editor group's in VS Code: its tabs, a button for a new session in
 * it, and on the right the branch of the shown tab, the split button and the group's menu. The button
 * of the file tree sits on the side the tree opens: before the tabs, or after the menu. Tabs are dragged
 * within the bar to reorder them, onto another group's bar to move them there, or onto a group's content
 * to split it.
 */
const props = defineProps<{ group: GroupView; focused: boolean }>()

const terminals = useTerminalsStore()
const settings = useSettingsStore()
const treeSide = computed(() => settings.settings.appearance.fileTreeSide)
const ui = useUiStore()
const launcher = useLauncher()
const { closeGroup } = useTerminalActions()
const bar = ref<HTMLElement | null>(null)
const strip = ref<HTMLElement | null>(null)
// The arrows go from tab to tab; Tab stops at the one in front (the tabs set that).
useRovingTabs(strip)

// The selected tab stacks the same layers as the content below it, so it has exactly its colour.
const { containerBackground } = useTerminalAppearance()
// The same object while the colour stays, so the tabs don't render again for it.
const joined = computed<Record<string, string>>((previous) => {
  const shown = props.group.tabs.find((t) => t.id === props.group.active)
  // A file's changes and the browser tab are drawn on the terminal's background too.
  const background = shown?.terminal || shown?.diff || shown?.browser
    ? `linear-gradient(${containerBackground.value}, ${containerBackground.value}), var(--surface)`
    : 'var(--surface)'
  return previous?.background === background ? previous : { background }
})

function select(id: string) {
  terminals.activateTab(id)
}

/**
 * The terminal the group shows, which a split starts like; for the browser tab its page, or the
 * session it shows while that has none.
 */
const shownTerminal = computed(() => {
  const shown = props.group.tabs.find((t) => t.id === props.group.active)
  return shown?.browser ? (terminals.browserPage ?? terminals.browserSession) : (shown?.terminal ?? null)
})
/** The tree the group shows beside its tab; for a file's changes that of a tab in its folder. */
const fileTree = useFileTreeStore()
const treeTarget = computed(() => fileTree.targetOfGroup(props.group))

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

/** A session or shell is open in the group; the browser tab, pages and changes of files alone are no terminal. */
const holdsTerminal = computed(() => props.group.tabs.some((t) => t.terminal && t.terminal.mode !== 'browser'))
/** The tree's button: not in a group without a session or shell, unless its tab has a tree (a file's changes). */
const treeButton = computed(() => holdsTerminal.value || treeTarget.value !== null)

/**
 * Folder of the shown tab, whose branch the bar names: each group its own, they can show different
 * repositories. A browser works in the folder of the terminal beside it, a session in a worktree in its folder.
 * A group without a session or shell names none: the branch is in the bar of the session's group.
 */
const branchDir = computed(() => {
  if (!holdsTerminal.value) return null
  const terminal = terminals.workingTerminalOf(shownTerminal.value)
  return terminal?.worktree?.path || terminal?.cwd || treeTarget.value?.root || null
})

/** A browser always belongs to a session: the one the group shows, or the session of the page it shows. */
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

// Tabs cut by an edge fade out there, as in the title bar; the bar's line below them stays.
const fade = useOverflowFade(strip, 1)

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
  <!-- A press anywhere on the bar gives its group the keyboard, so "+" opens the session in it.
       Clipped: in a group narrower than its buttons they must not reach over the bar beside it. -->
  <div
    ref="bar"
    data-group-bar
    :data-group-id="group.id"
    class="flex min-w-0 items-stretch overflow-hidden pt-1"
    :style="{ height: `${TAB_BAR_HEIGHT}px` }"
    @pointerdown.capture="!focused && terminals.focusGroup(group.id)"
  >
    <div v-if="treeSide === 'left' && treeButton" class="flex shrink-0 items-center border-b pl-1.5">
      <FileTreeButton :target="treeTarget" :group="group" variant="group" />
    </div>
    <div class="w-1.5 shrink-0 border-b" />
    <!-- A small gap between the tabs. Each tab draws its piece of the bar's bottom line, so it carries
         it on through the gap to its right; a line under the whole strip would shine through the selected tab. -->
    <div
      ref="strip"
      role="tablist"
      aria-label="Tabs der Gruppe"
      data-terminal-tabs
      class="no-scrollbar flex min-w-0 gap-[3px] overflow-x-auto *:not-last:after:absolute *:not-last:after:-bottom-px *:not-last:after:left-[calc(100%+1px)] *:not-last:after:h-px *:not-last:after:w-[3px] *:not-last:after:bg-border"
      :style="fade.style.value"
    >
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
        <DiffTab
          v-else-if="tab.diff"
          :file="tab.diff"
          :group-id="group.id"
          :selected="tab.id === group.active"
          :focused="focused && tab.id === group.active"
          :joined="joined"
          @select="select"
        />
        <PageTab
          v-else-if="tab.page"
          :page="tab.page"
          :group-id="group.id"
          :selected="tab.id === group.active"
          :focused="focused && tab.id === group.active"
          :joined="joined"
          @select="select"
        />
        <BrowserTab
          v-else-if="tab.browser"
          :group-id="group.id"
          :selected="tab.id === group.active"
          :focused="focused && tab.id === group.active"
          :joined="joined"
          @select="select"
        />
      </template>
    </div>
    <!-- The buttons keep their width, the tabs scroll instead: only the branch between them gives way. -->
    <div class="flex shrink-0 items-center border-b pl-0.5">
      <NewTerminalMenu class="[&_button]:h-7" />
    </div>
    <!-- A container: the branch only shows while the tabs leave room for it. It can't hold the buttons:
         a container is 0 wide at the least, and they would spill over the bar of the group beside it. -->
    <div class="@container flex min-w-0 flex-1 items-center justify-end border-b pl-0.5">
      <!-- Shortened when the tabs take up the bar, gone before it would be only its icon. -->
      <GitBranchChip :cwd="branchDir" class="mr-1 hidden min-w-0 @min-[6rem]:flex" />
    </div>
    <div class="flex shrink-0 items-center gap-0.5 border-b pr-1.5 pl-0.5">
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
        <DropdownMenuContent align="end" class="w-84">
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
          <DropdownMenuItem v-if="group.active === BROWSER_TAB || terminals.browserShownFor(sessionShown?.id)" @select="terminals.closeBrowserTab()">
            <XIcon />
            Browser schließen
          </DropdownMenuItem>
          <DropdownMenuItem v-else :disabled="!sessionShown" @select="launcher.browserFor(shownTerminal)">
            <GlobeIcon />
            Browser öffnen
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem :disabled="terminals.groups.length < 2 && group.tabs.length === 0" @select="closeGroup(group.id)">
            <XIcon />
            Gruppe schließen
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <FileTreeButton v-if="treeSide === 'right' && treeButton" :target="treeTarget" :group="group" variant="group" />
    </div>
  </div>
</template>
