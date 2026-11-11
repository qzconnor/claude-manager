import { useEventListener, useMutationObserver } from '@vueuse/core'
import { computed, onBeforeUnmount, ref, watch, type Ref } from 'vue'

/** Width of the fade at an edge of a strip behind which more tabs are scrolled away. */
export const OVERFLOW_FADE_PX = 24

/** Whether a horizontal strip has more scrolled away to its left (`start`) and right (`end`). */
export function stripOverflow(el: Pick<HTMLElement, 'scrollLeft' | 'clientWidth' | 'scrollWidth'> | null) {
  if (!el) return { start: false, end: false }
  return { start: el.scrollLeft > 1, end: el.scrollLeft + el.clientWidth < el.scrollWidth - 1 }
}

/**
 * The mask that fades out what the edges of a strip cut off, where more is scrolled away; undefined
 * when nothing is. `keepBottom`: pixels at the bottom the fade leaves alone, such as a line under the tabs.
 */
export function overflowMask(overflow: { start: boolean; end: boolean }, keepBottom = 0): Record<string, string> | undefined {
  const { start, end } = overflow
  if (!start && !end) return undefined
  const fade = `linear-gradient(to right, ${start ? 'transparent' : 'black'}, black ${OVERFLOW_FADE_PX}px, black calc(100% - ${OVERFLOW_FADE_PX}px), ${end ? 'transparent' : 'black'})`
  if (keepBottom <= 0) return { maskImage: fade }
  return {
    maskImage: `${fade}, linear-gradient(black, black)`,
    maskSize: `100% calc(100% - ${keepBottom}px), 100% ${keepBottom}px`,
    maskPosition: 'top, bottom',
    maskRepeat: 'no-repeat',
  }
}

/**
 * Fades out the tabs a horizontally scrolling strip cuts at its edges instead of cutting them off
 * hard, so it shows that there are more. Follows scrolling and the widths of the strip and its tabs.
 */
export function useOverflowFade(strip: Ref<HTMLElement | null>, keepBottom = 0) {
  const overflow = ref({ start: false, end: false })

  function update() {
    const next = stripOverflow(strip.value)
    if (next.start !== overflow.value.start || next.end !== overflow.value.end) overflow.value = next
  }

  // The window gets narrower, tabs come, go or get another title.
  const resizeObserver = new ResizeObserver(update)
  const observe = () => {
    resizeObserver.disconnect()
    if (!strip.value) return update()
    resizeObserver.observe(strip.value)
    for (const tab of strip.value.children) resizeObserver.observe(tab)
  }
  watch(strip, observe, { flush: 'post', immediate: true })
  useMutationObserver(strip, observe, { childList: true })
  useEventListener(strip, 'scroll', update, { passive: true })
  onBeforeUnmount(() => resizeObserver.disconnect())

  return { overflow, style: computed(() => overflowMask(overflow.value, keepBottom)), update }
}
