<script setup lang="ts">
import { computed, ref, type Component } from 'vue'
import { layoutPanes, type PaneDivider, type PaneRect } from '@shared/panes'
import { PAGE_INFO } from '@/lib/pages'
import { dockRect } from '@/lib/tab-drag'
import { cn } from '@/lib/utils'
import { PAGES, pageTab, TAB_BAR_HEIGHT, type PageName } from '@/lib/workspace'
import { useBrowsersStore } from '@/stores/browsers'
import { useTerminalsStore } from '@/stores/terminals'
import { useUiStore } from '@/stores/ui'
import AccountsView from '@/views/AccountsView.vue'
import DashboardView from '@/views/DashboardView.vue'
import SessionsView from '@/views/SessionsView.vue'
import SettingsView from '@/views/SettingsView.vue'
import BrowserPane from './BrowserPane.vue'
import GroupTabBar from './GroupTabBar.vue'
import TerminalEmptyState from './TerminalEmptyState.vue'
import TerminalPane from './TerminalPane.vue'

/**
 * The window below the title bar, as in VS Code: groups share its space, each with a tab bar of its
 * own and the tab it shows below. Every terminal is mounted here once and only placed and shown, so
 * xterm keeps its state when tabs or groups change; they are never moved to another parent, which
 * would start xterm anew. Pages that are open as tabs are kept alive while hidden.
 */
const terminals = useTerminalsStore()
const browsers = useBrowsersStore()
const ui = useUiStore()
const root = ref<HTMLElement | null>(null)

const PAGE_VIEWS: Record<PageName, Component> = {
  sessions: SessionsView,
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
/** Below the group's tab bar. */
function contentStyle(rect: PaneRect) {
  return {
    left: percent(rect.left),
    width: percent(rect.width),
    top: `calc(${percent(rect.top)} + ${TAB_BAR_HEIGHT}px)`,
    height: `calc(${percent(rect.height)} - ${TAB_BAR_HEIGHT}px)`,
  }
}

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
const contentOf = (tab: string) => contentStyle(rectOf(tabGroups.value.all.get(tab)))

/**
 * A browser Claude drives in a hidden tab is drawn, unseen: a page that isn't drawn has no size,
 * and neither its screenshots nor the clicks on it would work.
 */
const driven = (id: string) => browsers.controls.get(id)?.active === true
const inBackground = (id: string) => !isShown(id) && driven(id)

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

/** A tab dragged over the window: the group it joins, or the half of it a new group takes. */
const dockPreview = computed(() => {
  const dock = ui.groupDock
  if (!dock) return null
  const rect = rectOf(dock.groupId)
  const page = PAGES.find((p) => pageTab(p) === dock.tabId)
  const title = page ? PAGE_INFO[page].label : (terminals.terminals.find((t) => t.id === dock.tabId)?.title ?? '')
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

    <!-- A browser tab shows its page instead of a terminal. -->
    <component
      :is="terminal.mode === 'browser' ? BrowserPane : TerminalPane"
      v-for="terminal in terminals.terminals"
      v-show="isShown(terminal.id) || inBackground(terminal.id)"
      :key="terminal.id"
      :class="cn('absolute', inBackground(terminal.id) && 'pointer-events-none -z-10 opacity-0')"
      :aria-hidden="inBackground(terminal.id) || undefined"
      :style="contentOf(terminal.id)"
      :terminal="terminal"
      :active="terminals.focusedTab === terminal.id"
      :dimmed="several && terminals.focusedTab !== terminal.id"
      @focus="terminals.activate(terminal.id)"
    />

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
        aria-label="Größe der Gruppen ändern"
        :class="
          cn(
            'group/divider absolute z-30 flex items-center justify-center',
            divider.direction === 'row' ? 'w-2 -translate-x-1/2 cursor-col-resize' : 'h-2 -translate-y-1/2 cursor-row-resize',
          )
        "
        :style="dividerStyle(divider)"
        @pointerdown="onDividerDown($event, divider)"
        @dblclick="terminals.resizeGroups(divider.path, 0.5)"
      >
        <div
          :class="
            cn(
              'bg-border transition-colors group-hover/divider:bg-primary/60',
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
