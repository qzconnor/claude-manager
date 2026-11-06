<script setup lang="ts">
import { computed, ref } from 'vue'
import { layoutPanes, type PaneDivider, type PaneRect } from '@shared/panes'
import { cn } from '@/lib/utils'
import { useTerminalsStore } from '@/stores/terminals'
import TerminalEmptyState from './TerminalEmptyState.vue'
import TerminalPane from './TerminalPane.vue'

/**
 * Hosts every terminal at once and only toggles visibility, so xterm instances keep
 * their state while the user switches tabs or visits other pages. The terminals of a split tab are
 * placed side by side; they are never moved to another parent, which would start xterm anew.
 */
const props = defineProps<{ visible: boolean }>()
const terminals = useTerminalsStore()
const root = ref<HTMLElement | null>(null)

/** A part may not get narrower or lower than this while dragging a divider (px). */
const MIN_PANE_PX = 80

const layout = computed(() => {
  const tab = terminals.activeTab
  return tab ? layoutPanes(tab.layout) : null
})
const split = computed(() => (terminals.activeTab?.panes.length ?? 0) > 1)

const percent = (value: number) => `${value * 100}%`
const FULL: PaneRect = { left: 0, top: 0, width: 1, height: 1 }

function paneStyle(id: string) {
  const rect = layout.value?.panes.get(id) ?? FULL
  return { left: percent(rect.left), top: percent(rect.top), width: percent(rect.width), height: percent(rect.height) }
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
  if (event.button !== 0 || !root.value || !terminals.activeTab) return
  event.preventDefault()
  const handle = event.currentTarget as HTMLElement
  handle.setPointerCapture(event.pointerId)
  const tabId = terminals.activeTab.id
  const bounds = root.value.getBoundingClientRect()
  const row = divider.direction === 'row'
  const size = (row ? bounds.width * divider.area.width : bounds.height * divider.area.height) || 1
  const start = row ? bounds.left + bounds.width * divider.area.left : bounds.top + bounds.height * divider.area.top
  const min = Math.min(0.5, MIN_PANE_PX / size)
  const ratioAt = (e: PointerEvent) => Math.min(1 - min, Math.max(min, ((row ? e.clientX : e.clientY) - start) / size))
  dragging.value = divider
  let last = divider.ratio

  const move = (e: PointerEvent) => {
    last = ratioAt(e)
    terminals.resize(tabId, divider.path, last, false)
  }
  const end = () => {
    handle.removeEventListener('pointermove', move)
    handle.removeEventListener('pointerup', end)
    handle.removeEventListener('pointercancel', end)
    dragging.value = null
    terminals.resize(tabId, divider.path, last, true)
  }
  handle.addEventListener('pointermove', move)
  handle.addEventListener('pointerup', end)
  handle.addEventListener('pointercancel', end)
}

/** A double click shares the space in half again. */
function onDividerReset(divider: PaneDivider) {
  if (terminals.activeTab) terminals.resize(terminals.activeTab.id, divider.path, 0.5, true)
}

const inActiveTab = (id: string) => terminals.activeTab?.panes.some((p) => p.id === id) ?? false
</script>

<template>
  <div
    ref="root"
    :class="cn('relative size-full', dragging && (dragging.direction === 'row' ? 'cursor-col-resize' : 'cursor-row-resize'), dragging && 'select-none')"
  >
    <TerminalPane
      v-for="terminal in terminals.terminals"
      v-show="inActiveTab(terminal.id)"
      :key="terminal.id"
      class="absolute"
      :style="inActiveTab(terminal.id) ? paneStyle(terminal.id) : undefined"
      :terminal="terminal"
      :active="props.visible && terminal.id === terminals.activeId"
      :focused="split && terminal.id === terminals.activeId"
      @focus="terminals.activate(terminal.id)"
    />
    <template v-if="split && layout">
      <div
        v-for="divider in layout.dividers"
        :key="divider.path.join('-') || 'root'"
        role="separator"
        :aria-orientation="divider.direction === 'row' ? 'vertical' : 'horizontal'"
        :aria-valuenow="Math.round(divider.ratio * 100)"
        aria-label="Größe der Bereiche ändern"
        :class="
          cn(
            'group/divider absolute z-30 flex items-center justify-center',
            divider.direction === 'row' ? 'w-2 -translate-x-1/2 cursor-col-resize' : 'h-2 -translate-y-1/2 cursor-row-resize',
          )
        "
        :style="dividerStyle(divider)"
        @pointerdown="onDividerDown($event, divider)"
        @dblclick="onDividerReset(divider)"
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
    <TerminalEmptyState v-if="terminals.terminals.length === 0" />
  </div>
</template>
