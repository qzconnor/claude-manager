<script setup lang="ts">
import { useElementSize } from '@vueuse/core'
import { computed, ref, watch, type Component } from 'vue'
import { layoutPanes, type PaneDivider, type PaneRect } from '@shared/panes'
import ChangesView from '@/components/files/ChangesView.vue'
import DiffView from '@/components/files/DiffView.vue'
import FileTreePanel from '@/components/files/FileTreePanel.vue'
import { PAGE_INFO } from '@/lib/pages'
import { separatorValue } from '@/lib/separator-keys'
import { dockRect } from '@/lib/tab-drag'
import { inOpeningOrder } from '@/lib/tabs'
import { cn } from '@/lib/utils'
import { baseName } from '@/lib/file-tree'
import { BROWSER_BAR_HEIGHT, BROWSER_TAB, diffOfTab, PAGES, pageTab, TAB_BAR_HEIGHT, type DiffFile, type PageName } from '@/lib/workspace'
import { useBrowsersStore } from '@/stores/browsers'
import { MAX_TREE_SHARE, useFileTreeStore, type TreeTarget } from '@/stores/file-tree'
import { useSettingsStore } from '@/stores/settings'
import { useTerminalsStore } from '@/stores/terminals'
import { useUiStore } from '@/stores/ui'
import AccountsView from '@/views/AccountsView.vue'
import ArtifactsView from '@/views/ArtifactsView.vue'
import DashboardView from '@/views/DashboardView.vue'
import OverviewView from '@/views/OverviewView.vue'
import SessionsView from '@/views/SessionsView.vue'
import SettingsView from '@/views/SettingsView.vue'
import BrowserBar from './BrowserBar.vue'
import BrowserEmpty from './BrowserEmpty.vue'
import BrowserPane from './BrowserPane.vue'
import GroupTabBar from './GroupTabBar.vue'
import SleepingPane from './SleepingPane.vue'
import TerminalEmptyState from './TerminalEmptyState.vue'
import TerminalPane from './TerminalPane.vue'

/**
 * The window below the title bar, as in VS Code: groups share its space, each with a tab bar of its
 * own and the tab it shows below. Every terminal is mounted here once and only placed and shown, so
 * xterm keeps its state when tabs or groups change; they are never moved to another parent, which
 * would start xterm anew. Pages that are open as tabs are kept alive while hidden. A group whose tab
 * has its file tree open shares its content with the tree, on the side the settings name; a file's
 * changes opened from the tree are a tab of the group, with the tree still beside them.
 *
 * The sessions' browsers are pages of the one browser tab: all of them lie where it shows its page,
 * the one of the session it follows is shown. A page Claude drives is drawn there unseen, in the same
 * size, so its screenshots look as the page would.
 */
const terminals = useTerminalsStore()
const browsers = useBrowsersStore()
const fileTree = useFileTreeStore()
const settings = useSettingsStore()
const ui = useUiStore()
const root = ref<HTMLElement | null>(null)
const { width: rootWidth, height: rootHeight } = useElementSize(root)
const treeSide = computed(() => settings.settings.appearance.fileTreeSide)

const PAGE_VIEWS: Record<PageName, Component> = {
  overview: OverviewView,
  sessions: SessionsView,
  artifacts: ArtifactsView,
  dashboard: DashboardView,
  accounts: AccountsView,
  settings: SettingsView,
}

/** A group may not get narrower or lower than this while dragging a divider (px). */
const MIN_GROUP_PX = 160

const geometry = computed(() => layoutPanes(terminals.workspace.layout))
const FULL: PaneRect = { left: 0, top: 0, width: 1, height: 1 }
const rectOf = (groupId: string | undefined) => (groupId && geometry.value.panes.get(groupId)) || FULL
const several = computed(() => terminals.groups.length > 1)

const percent = (value: number) => `${value * 100}%`
function areaStyle(rect: PaneRect) {
  return { left: percent(rect.left), top: percent(rect.top), width: percent(rect.width), height: percent(rect.height) }
}
function barStyle(rect: PaneRect) {
  return { left: percent(rect.left), top: percent(rect.top), width: percent(rect.width) }
}
/**
 * Below the group's tab bar (and `below` px more); beside the file tree (`tree` px wide) if the group
 * shows one.
 */
function contentStyle(rect: PaneRect, tree = 0, below = 0) {
  return {
    left: tree && treeSide.value === 'left' ? `calc(${percent(rect.left)} + ${tree}px)` : percent(rect.left),
    width: tree ? `calc(${percent(rect.width)} - ${tree}px)` : percent(rect.width),
    top: `calc(${percent(rect.top)} + ${TAB_BAR_HEIGHT + below}px)`,
    height: `calc(${percent(rect.height)} - ${TAB_BAR_HEIGHT + below}px)`,
  }
}

/** The file tree of a group: at its left or right edge, below the tab bar. */
function treeStyle(rect: PaneRect, width: number) {
  return {
    left: treeSide.value === 'left' ? percent(rect.left) : `calc(${percent(rect.left + rect.width)} - ${width}px)`,
    width: `${width}px`,
    top: `calc(${percent(rect.top)} + ${TAB_BAR_HEIGHT}px)`,
    height: `calc(${percent(rect.height)} - ${TAB_BAR_HEIGHT}px)`,
  }
}

/**
 * The groups whose shown tab has its file tree open: the tree, the tab it is beside, how wide it is
 * there (px), and the file of its folder whose changes the group shows.
 */
const trees = computed(() => {
  const map = new Map<string, { target: TreeTarget; tab: string; width: number; max: number; current: string | null }>()
  for (const group of terminals.groups) {
    const target = fileTree.targetOfGroup(group)
    if (!target || !group.active || !fileTree.shownIn(target, group)) continue
    const max = Math.floor(rectOf(group.id).width * rootWidth.value * MAX_TREE_SHARE)
    const diff = diffOfTab(group.active)
    const current = diff?.root === target.root ? diff.path : null
    if (max > 0) map.set(group.id, { target, tab: group.active, width: Math.min(fileTree.width, max), max, current })
  }
  return map
})

/** Every tab's group, and for the tabs the groups show, that group. */
const tabGroups = computed(() => {
  const all = new Map<string, string>()
  const shown = new Map<string, string>()
  for (const group of terminals.groups) {
    for (const tab of group.tabs) all.set(tab.id, group.id)
    if (group.active) shown.set(group.active, group.id)
  }
  return { all, shown }
})
const isShown = (tab: string) => tabGroups.value.shown.has(tab)
/** A tab's place: beside the tree of its group, while it is the tab whose tree that is. */
function contentOf(tab: string) {
  const groupId = tabGroups.value.all.get(tab)
  const tree = groupId ? trees.value.get(groupId) : undefined
  return contentStyle(rectOf(groupId), tree?.tab === tab ? tree.width : 0)
}

/** The files whose changes are open as tabs; only the shown ones are drawn. */
const openDiffs = computed(() =>
  terminals.groups.flatMap((group) => group.tabs.flatMap((tab) => (tab.diff ? [{ id: tab.id, file: tab.diff as DiffFile }] : []))),
)

function focusTab(tab: string) {
  if (terminals.focusedTab !== tab) terminals.activateTab(tab)
}

/** The group of the browser tab: the sessions' pages lie in it, below the tab's bar, also while hidden. */
const browserGroup = computed(() => tabGroups.value.all.get(BROWSER_TAB))
const browserShown = computed(() => isShown(BROWSER_TAB))
/** The page the browser tab shows right now; null while it is hidden or its session has none. */
const pageShown = computed(() => (browserShown.value ? (terminals.browserPage?.id ?? null) : null))
/** Where the sessions' pages lie; without the browser tab in the whole window, for those Claude drives. */
const pageStyle = computed(() => contentStyle(rectOf(browserGroup.value), 0, BROWSER_BAR_HEIGHT))
/** The browser tab's bar, at the top of its content. */
const browserBarStyle = computed(() => {
  const rect = rectOf(browserGroup.value)
  return { left: percent(rect.left), width: percent(rect.width), top: `calc(${percent(rect.top)} + ${TAB_BAR_HEIGHT}px)`, height: `${BROWSER_BAR_HEIGHT}px` }
})

/** A terminal on screen: shown by its group, a session's page shown by the browser tab. */
const onScreen = (id: string) => (terminals.isSessionPage(id) ? pageShown.value === id : isShown(id))
/** A terminal with the keyboard: its tab has it, a session's page while the browser tab shows it. */
const hasKeyboard = (id: string) =>
  terminals.isSessionPage(id) ? terminals.focusedTab === BROWSER_TAB && pageShown.value === id : terminals.focusedTab === id
const placeOf = (id: string) => (terminals.isSessionPage(id) ? pageStyle.value : contentOf(id))

/**
 * A browser Claude drives in a hidden tab is drawn, unseen: a page that isn't drawn has no size,
 * and neither its screenshots nor the clicks on it would work.
 */
const driven = (id: string) => browsers.controls.get(id)?.active === true
const inBackground = (id: string) => !onScreen(id) && driven(id)

/** Browsers of the last run load once they are shown or Claude drives them (see `terminals.sleeping`). */
// Not in the order of the tabs: reordering them would move the elements, and a browser would load again.
const mounted = computed(() => inOpeningOrder(terminals.terminals.filter((t) => !terminals.sleeping.has(t.id))))
const waking = computed(() => [...terminals.sleeping].filter((id) => onScreen(id) || browsers.controls.get(id)?.busy === true || driven(id)))
watch(waking, (ids) => ids.forEach((id) => terminals.wake(id)), { immediate: true })

const openPages = computed(() =>
  PAGES.flatMap((page) => {
    const groupId = tabGroups.value.all.get(pageTab(page))
    return groupId ? [{ page, groupId }] : []
  }),
)

/** A press or the keyboard in a page gives it the focus, as a click into a terminal does. */
function focusPage(page: PageName) {
  const tab = pageTab(page)
  if (terminals.focusedTab !== tab) terminals.activateTab(tab)
}

/** The divider lies on the line between the two parts; its grip reaches a little into both. */
function dividerStyle(divider: PaneDivider) {
  const { area, ratio } = divider
  return divider.direction === 'row'
    ? { left: percent(area.left + area.width * ratio), top: percent(area.top), height: percent(area.height) }
    : { top: percent(area.top + area.height * ratio), left: percent(area.left), width: percent(area.width) }
}

const dragging = ref<PaneDivider | null>(null)

function onDividerDown(event: PointerEvent, divider: PaneDivider) {
  if (event.button !== 0 || !root.value) return
  event.preventDefault()
  const handle = event.currentTarget as HTMLElement
  handle.setPointerCapture(event.pointerId)
  const bounds = root.value.getBoundingClientRect()
  const row = divider.direction === 'row'
  const size = (row ? bounds.width * divider.area.width : bounds.height * divider.area.height) || 1
  const start = row ? bounds.left + bounds.width * divider.area.left : bounds.top + bounds.height * divider.area.top
  const min = Math.min(0.5, MIN_GROUP_PX / size)
  const ratioAt = (e: PointerEvent) => Math.min(1 - min, Math.max(min, ((row ? e.clientX : e.clientY) - start) / size))
  dragging.value = divider

  const move = (e: PointerEvent) => terminals.resizeGroups(divider.path, ratioAt(e))
  const end = () => {
    handle.removeEventListener('pointermove', move)
    handle.removeEventListener('pointerup', end)
    handle.removeEventListener('pointercancel', end)
    dragging.value = null
  }
  handle.addEventListener('pointermove', move)
  handle.addEventListener('pointerup', end)
  handle.addEventListener('pointercancel', end)
}

/** The least share a divider leaves either of its groups, so none gets smaller than `MIN_GROUP_PX`. */
function minRatio(divider: PaneDivider): number {
  const size = (divider.direction === 'row' ? rootWidth.value * divider.area.width : rootHeight.value * divider.area.height) || 1
  return Math.min(0.5, MIN_GROUP_PX / size)
}

/** A divider moved with the keyboard, 2 % of its groups a step; Enter shares them in half again. */
function onDividerKey(event: KeyboardEvent, divider: PaneDivider) {
  const min = minRatio(divider) * 100
  const percent = separatorValue(event, divider.direction === 'row', { value: divider.ratio * 100, min, max: 100 - min, step: 2, initial: 50 })
  if (percent === null) return
  event.preventDefault()
  terminals.resizeGroups(divider.path, percent / 100)
}

/** A tab dragged over the window: the group it joins, or the half of it a new group takes. */
const dockPreview = computed(() => {
  const dock = ui.groupDock
  if (!dock) return null
  const rect = rectOf(dock.groupId)
  const page = PAGES.find((p) => pageTab(p) === dock.tabId)
  const diff = diffOfTab(dock.tabId)
  const title = page
    ? PAGE_INFO[page].label
    : diff
      ? diff.path
        ? baseName(diff.path)
        : 'Alle Änderungen'
      : dock.tabId === BROWSER_TAB
        ? 'Browser'
        : (terminals.terminals.find((t) => t.id === dock.tabId)?.title ?? '')
  return { rect: dock.side === 'center' ? rect : dockRect(rect, dock.side), title }
})
</script>

<template>
  <div
    ref="root"
    data-slot="terminal-workspace"
    :class="
      cn(
        'relative size-full',
        dragging && (dragging.direction === 'row' ? 'cursor-col-resize' : 'cursor-row-resize'),
        // A browser page would take the pointer while it passes over it.
        (dragging || ui.draggingTab) && 'select-none [&_webview]:pointer-events-none',
      )
    "
  >
    <!-- The groups' content area; a press on an empty one gives it the keyboard. -->
    <div
      v-for="group in terminals.groups"
      :key="`area-${group.id}`"
      class="absolute bg-surface"
      :style="contentStyle(rectOf(group.id))"
      @pointerdown="terminals.focusGroup(group.id)"
    >
      <TerminalEmptyState v-if="group.tabs.length === 0" />
    </div>

    <!-- A browser shows its page instead of a terminal; a session's page lies in the browser tab. -->
    <component
      :is="terminal.mode === 'browser' ? BrowserPane : terminal.status === 'asleep' ? SleepingPane : TerminalPane"
      v-for="terminal in mounted"
      v-show="onScreen(terminal.id) || inBackground(terminal.id)"
      :key="terminal.id"
      :class="cn('absolute', inBackground(terminal.id) && 'pointer-events-none -z-10 opacity-0')"
      :aria-hidden="inBackground(terminal.id) || undefined"
      :style="placeOf(terminal.id)"
      :terminal="terminal"
      :active="hasKeyboard(terminal.id)"
      :dimmed="several && !hasKeyboard(terminal.id)"
      @focus="terminals.activate(terminal.id)"
    />

    <!-- The browser tab: its bar with the session and its pages, and while the session has none, the way to one. -->
    <template v-if="browserShown">
      <BrowserBar class="absolute" :style="browserBarStyle" />
      <BrowserEmpty
        v-if="!pageShown"
        class="absolute"
        :style="pageStyle"
        :active="terminals.focusedTab === BROWSER_TAB"
        @pointerdown.capture="focusTab(BROWSER_TAB)"
      />
    </template>

    <!-- The file trees, by their tab: each tab comes back to its own place in the tree. -->
    <FileTreePanel
      v-for="[groupId, tree] in trees"
      :key="`tree-${groupId}-${tree.target.id}`"
      class="absolute z-[5]"
      :style="treeStyle(rectOf(groupId), tree.width)"
      :target="tree.target"
      :side="treeSide"
      :max-width="tree.max"
      :group-id="groupId"
      :current="tree.current"
      @pointerdown="terminals.focusGroup(groupId)"
    />

    <!-- The changes of files, as tabs; drawn while shown, they load again when they come back. -->
    <template v-for="diff in openDiffs" :key="diff.id">
      <template v-if="isShown(diff.id)">
        <!-- All changes of the folder, one below the other. -->
        <ChangesView
          v-if="diff.file.path === ''"
          class="absolute overflow-hidden"
          :style="contentOf(diff.id)"
          :root="diff.file.root"
          @pointerdown.capture="focusTab(diff.id)"
          @focusin="focusTab(diff.id)"
        />
        <DiffView
          v-else
          class="absolute overflow-hidden"
          :style="contentOf(diff.id)"
          :root="diff.file.root"
          :path="diff.file.path"
          @pointerdown.capture="focusTab(diff.id)"
          @focusin="focusTab(diff.id)"
        />
      </template>
    </template>

    <!-- Pages open as tabs; KeepAlive keeps a hidden one with its state (and calls onActivated when shown). -->
    <div
      v-for="{ page, groupId } in openPages"
      v-show="isShown(pageTab(page))"
      :key="page"
      class="absolute overflow-hidden"
      :style="contentStyle(rectOf(groupId))"
      @pointerdown.capture="focusPage(page)"
      @focusin="focusPage(page)"
    >
      <KeepAlive>
        <component :is="PAGE_VIEWS[page]" v-if="isShown(pageTab(page))" />
      </KeepAlive>
    </div>

    <GroupTabBar
      v-for="group in terminals.groups"
      :key="`bar-${group.id}`"
      class="absolute z-10"
      :style="barStyle(rectOf(group.id))"
      :group="group"
      :focused="group.id === terminals.activeGroup?.id"
    />

    <template v-if="several">
      <div
        v-for="divider in geometry.dividers"
        :key="divider.path.join('-') || 'root'"
        role="separator"
        :aria-orientation="divider.direction === 'row' ? 'vertical' : 'horizontal'"
        :aria-valuenow="Math.round(divider.ratio * 100)"
        :aria-valuemin="Math.round(minRatio(divider) * 100)"
        :aria-valuemax="Math.round((1 - minRatio(divider)) * 100)"
        aria-label="Größe der Gruppen ändern"
        tabindex="0"
        :class="
          cn(
            'group/divider absolute z-30 flex items-center justify-center outline-none',
            divider.direction === 'row' ? 'w-2 -translate-x-1/2 cursor-col-resize' : 'h-2 -translate-y-1/2 cursor-row-resize',
          )
        "
        :style="dividerStyle(divider)"
        @pointerdown="onDividerDown($event, divider)"
        @dblclick="terminals.resizeGroups(divider.path, 0.5)"
        @keydown="onDividerKey($event, divider)"
      >
        <div
          :class="
            cn(
              'bg-border transition-colors group-hover/divider:bg-primary/60 group-focus-visible/divider:bg-primary',
              divider.direction === 'row' ? 'h-full w-px' : 'h-px w-full',
              dragging?.path.join() === divider.path.join() && 'bg-primary/60',
            )
          "
        />
      </div>
    </template>

    <!-- A tab dragged over the window: where it lands, with its title. -->
    <div
      v-if="dockPreview"
      class="pointer-events-none absolute z-40 p-1.5 transition-[left,top,width,height] duration-150 ease-out"
      :style="areaStyle(dockPreview.rect)"
    >
      <div class="flex size-full items-center justify-center rounded-lg border-2 border-primary/70 bg-primary/15 p-3">
        <span class="max-w-full truncate rounded-md bg-popover px-2.5 py-1 text-sm text-popover-foreground shadow-md ring-1 ring-foreground/10">
          {{ dockPreview.title }}
        </span>
      </div>
    </div>
  </div>
</template>
