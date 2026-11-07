<script setup lang="ts">
import { ChevronLeftIcon, ChevronRightIcon } from '@lucide/vue'
import { useEventListener, useMutationObserver } from '@vueuse/core'
import { computed, onBeforeUnmount, onMounted, ref, type HTMLAttributes } from 'vue'
import { TabsList } from '@/components/ui/tabs'
import { cn } from '@/lib/utils'

/**
 * A row of tabs (line variant) that scrolls sideways once it no longer fits. An edge behind which
 * more tabs are hidden fades out and carries an arrow that scrolls on by a page. The mouse wheel
 * scrolls the row as well, and the selected tab always comes fully into view.
 */
const props = defineProps<{ class?: HTMLAttributes['class'] }>()

const strip = ref<HTMLElement | null>(null)

/** Width of the fade at an edge with hidden tabs; the arrow sits in its outer part, where the tabs are gone completely. */
const FADE = 72
const CLEAR = 32

const overflow = ref({ start: false, end: false })

const mask = computed(() => {
  const { start, end } = overflow.value
  if (!start && !end) return undefined
  const from = start ? `transparent ${CLEAR}px, black ${FADE}px` : 'black'
  const to = end ? `black calc(100% - ${FADE}px), transparent calc(100% - ${CLEAR}px)` : 'black'
  return { maskImage: `linear-gradient(to right, ${from}, ${to})` }
})

function measure() {
  const el = strip.value
  overflow.value = el
    ? { start: el.scrollLeft > 1, end: el.scrollLeft + el.clientWidth < el.scrollWidth - 1 }
    : { start: false, end: false }
}

/** Scrolls the selected tab clear of the fades, as far as the row is wide enough. */
function reveal(behavior: ScrollBehavior) {
  const el = strip.value
  const tab = el?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')
  if (!el || !tab) return
  const bounds = el.getBoundingClientRect()
  const rect = tab.getBoundingClientRect()
  const margin = Math.max(0, Math.min(FADE, (bounds.width - rect.width) / 2))
  let delta = 0
  if (rect.left < bounds.left + margin) delta = rect.left - bounds.left - margin
  else if (rect.right > bounds.right - margin) delta = rect.right - bounds.right + margin
  if (delta) el.scrollBy({ left: delta, behavior })
}

/** An arrow: scrolls by the visible part of the row, less the fades, so the tab cut at the edge comes in whole. */
function page(direction: -1 | 1) {
  const el = strip.value
  if (!el) return
  el.scrollBy({ left: direction * Math.max(el.clientWidth - 2 * FADE, el.clientWidth / 2), behavior: 'smooth' })
}

// A narrower window keeps the selected tab in view; tabs changing width (a badge) only measure again.
const resizeObserver = new ResizeObserver((entries) => {
  if (entries.some((entry) => entry.target === strip.value)) reveal('auto')
  measure()
})
onMounted(() => {
  const el = strip.value
  if (!el) return
  resizeObserver.observe(el)
  if (el.firstElementChild) resizeObserver.observe(el.firstElementChild)
  measure()
  reveal('auto')
})
onBeforeUnmount(() => resizeObserver.disconnect())

useEventListener(strip, 'scroll', measure, { passive: true })

// Another tab got selected (a click, the arrow keys, from outside): it slides into view.
useMutationObserver(
  strip,
  (records) => {
    if (records.some((record) => (record.target as Element).getAttribute('aria-selected') === 'true')) reveal('smooth')
  },
  { subtree: true, attributes: true, attributeFilter: ['aria-selected'] },
)

// A vertical mouse wheel scrolls the row sideways; at its end the page scrolls on instead.
useEventListener(
  strip,
  'wheel',
  (event: WheelEvent) => {
    const el = strip.value
    if (!el || Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return
    const max = el.scrollWidth - el.clientWidth
    if (max <= 1 || (event.deltaY < 0 && el.scrollLeft <= 0) || (event.deltaY > 0 && el.scrollLeft >= max - 1)) return
    el.scrollLeft += event.deltaY
    event.preventDefault()
  },
  { passive: false },
)

/**
 * 32px around a 16px icon, in px rather than rem (the UI font size is a setting, rem sizes come out
 * fractional), the outline a ring that takes no room: the 8px gaps are whole device pixels at
 * 100–200 % scaling, so the chevron sits exactly in the middle. Centred by margins, not a transform.
 */
const ARROW =
  'absolute inset-y-0 z-10 my-auto flex size-[32px] cursor-pointer items-center justify-center rounded-full bg-popover text-muted-foreground shadow-md ring-1 ring-border transition-[opacity,color,background-color] duration-200 hover:bg-accent hover:text-accent-foreground active:scale-95 [&_svg]:size-[16px]'
</script>

<template>
  <!-- The line below the tabs belongs to the frame, so it runs through under the fades. -->
  <div :class="cn('relative shadow-[inset_0_-1px_0_var(--color-border)]', props.class)">
    <div ref="strip" class="no-scrollbar overflow-x-auto" :style="mask">
      <TabsList variant="line" class="w-max min-w-full justify-start gap-0 rounded-none p-0 group-data-horizontal/tabs:h-auto">
        <slot />
      </TabsList>
    </div>
    <!-- Only for the mouse: the keyboard moves through the tabs with the arrow keys. -->
    <button
      type="button"
      tabindex="-1"
      aria-label="Weiter nach links"
      :aria-hidden="!overflow.start"
      :class="cn(ARROW, 'left-0', !overflow.start && 'pointer-events-none opacity-0')"
      @click="page(-1)"
    >
      <ChevronLeftIcon />
    </button>
    <button
      type="button"
      tabindex="-1"
      aria-label="Weiter nach rechts"
      :aria-hidden="!overflow.end"
      :class="cn(ARROW, 'right-0', !overflow.end && 'pointer-events-none opacity-0')"
      @click="page(1)"
    >
      <ChevronRightIcon />
    </button>
  </div>
</template>
