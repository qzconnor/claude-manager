import { useEventListener } from '@vueuse/core'
import { nextTick, ref, type Ref } from 'vue'
import { clampOffset, dropIndex, shiftsFor, type Slot } from '@/lib/tab-drag'

/** Pixels the pointer has to move before a press on a tab becomes a drag (a click stays a click). */
const THRESHOLD = 5
const SHIFT_TRANSITION = 'transform 150ms ease'

interface Options {
  vertical: boolean
  /** The tab with this id was dropped at `index`, its position in the new order. */
  onDrop: (id: string, index: number) => void
  /** Called every frame while tabs move, e.g. so the page follows the selected tab. */
  onMove?: () => void
  /** Somewhere besides the strip that takes the dragged tab, e.g. the page with the terminals. */
  outside?: OutsideTarget
  /** A lone tab can be dragged too, to the outside target: a group's only tab into another group. */
  lone?: boolean
}

interface OutsideTarget {
  /** Whether a tab dropped at this point (viewport px) is taken here; meanwhile the strip doesn't reorder. */
  over: (id: string, x: number, y: number) => boolean
  /** The tab was dropped where `over` last took it. */
  drop: (id: string) => void
  /** The drag ended, dropped or not. */
  end: () => void
}

interface Press {
  pointerId: number
  x: number
  y: number
  tab: HTMLElement
  id: string
}

interface Drag extends Press {
  tabs: HTMLElement[]
  slots: Slot[]
  gap: number
  from: number
  to: number
  frame: number
  /** Over the outside target instead of the strip. */
  outside: boolean
}

/**
 * Lets the tabs of a strip be reordered by dragging. The dragged tab follows the pointer along the
 * strip, the others slide aside to show where it lands; Escape cancels. The order only changes on
 * drop, through `onDrop`, and the drop doesn't select the tab. Tabs are the strip's `[role="tab"]`
 * children with a `data-terminal-id`. Over the `outside` target the tab goes back to its place
 * (marked `data-docking`) and is dropped there instead.
 */
export function useTabDrag(strip: Ref<HTMLElement | null>, options: Options) {
  /** Id of the tab being dragged, e.g. to keep hover cards closed. */
  const dragging = ref<string | null>(null)
  let press: Press | null = null
  let drag: Drag | null = null
  /** The click that ends a drag is swallowed. */
  let suppressClick = false

  const along = (x: number, y: number) => (options.vertical ? y : x)
  const translate = (offset: number) => (options.vertical ? `translateY(${offset}px)` : `translateX(${offset}px)`)

  useEventListener(strip, 'pointerdown', (event: PointerEvent) => {
    if (event.button !== 0 || drag) return
    const target = event.target as Element
    // The close button and the rename field keep their own behaviour.
    if (target.closest('button, input')) return
    const tab = target.closest<HTMLElement>('[role="tab"][data-terminal-id]')
    if (!tab || tab.parentElement !== strip.value) return
    press = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, tab, id: tab.dataset.terminalId ?? '' }
  })

  useEventListener(window, 'pointermove', (event: PointerEvent) => {
    if (drag) {
      if (event.pointerId === drag.pointerId) follow(event)
      return
    }
    if (!press || event.pointerId !== press.pointerId) return
    if (Math.max(Math.abs(event.clientX - press.x), Math.abs(event.clientY - press.y)) < THRESHOLD) return
    start(press)
    follow(event)
  })

  useEventListener(window, 'pointerup', (event: PointerEvent) => {
    if (drag && event.pointerId === drag.pointerId) finish(true)
    press = null
  })
  useEventListener(window, 'pointercancel', () => {
    if (drag) finish(false)
    press = null
  })
  useEventListener(
    window,
    'keydown',
    (event: KeyboardEvent) => {
      if (!drag || event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      finish(false)
    },
    { capture: true },
  )
  useEventListener(
    strip,
    'click',
    (event: MouseEvent) => {
      if (!suppressClick) return
      suppressClick = false
      event.stopPropagation()
      event.preventDefault()
    },
    { capture: true },
  )

  function start(from: Press) {
    press = null
    const el = strip.value
    if (!el) return
    const tabs = [...el.children].filter(
      (child): child is HTMLElement => child instanceof HTMLElement && child.matches('[role="tab"]'),
    )
    const index = tabs.indexOf(from.tab)
    if (index === -1 || (tabs.length < 2 && !(options.lone && options.outside))) return
    const slots = tabs.map((tab) => {
      const rect = tab.getBoundingClientRect()
      return options.vertical ? { start: rect.top, size: rect.height } : { start: rect.left, size: rect.width }
    })
    const gap = slots.length > 1 ? Math.max(0, slots[1].start - (slots[0].start + slots[0].size)) : 0
    drag = { ...from, tabs, slots, gap, from: index, to: index, frame: 0, outside: false }
    dragging.value = from.id
    try {
      from.tab.setPointerCapture(from.pointerId)
    } catch {
      // The pointer is already gone (released in between); the window listeners still end the drag.
    }
    for (const tab of tabs) {
      tab.style.transition = tab === from.tab ? 'none' : SHIFT_TRANSITION
      tab.style.willChange = 'transform'
    }
    from.tab.style.zIndex = '10'
    // Styled by the tab (`data-dragging:`), so it reads as lifted while carried.
    from.tab.dataset.dragging = ''
    const tick = () => {
      if (!drag) return
      options.onMove?.()
      drag.frame = requestAnimationFrame(tick)
    }
    tick()
  }

  function follow(event: PointerEvent) {
    if (!drag) return
    const current = drag
    const outside = options.outside?.over(current.id, event.clientX, event.clientY) ?? false
    if (outside !== current.outside) {
      current.outside = outside
      // It glides back to its place, and follows the pointer again without delay.
      current.tab.style.transition = outside ? SHIFT_TRANSITION : 'none'
      if (outside) current.tab.dataset.docking = ''
      else delete current.tab.dataset.docking
    }
    const offset = outside
      ? 0
      : clampOffset(current.slots, current.from, along(event.clientX, event.clientY) - along(current.x, current.y))
    current.tab.style.transform = translate(offset)
    const to = outside ? current.from : dropIndex(current.slots, current.from, offset)
    if (to === current.to) return
    current.to = to
    const shifts = shiftsFor(current.slots, current.from, to, current.gap)
    current.tabs.forEach((tab, i) => {
      if (i !== current.from) tab.style.transform = shifts[i] ? translate(shifts[i]) : ''
    })
  }

  function finish(drop: boolean) {
    const current = drag
    if (!current) return
    drag = null
    dragging.value = null
    cancelAnimationFrame(current.frame)
    // Without transitions, so the tabs don't slide back from their offsets once the list is reordered.
    for (const tab of current.tabs) {
      tab.style.transition = 'none'
      tab.style.transform = ''
      tab.style.willChange = ''
      tab.style.zIndex = ''
    }
    delete current.tab.dataset.dragging
    delete current.tab.dataset.docking
    if (current.tab.hasPointerCapture(current.pointerId)) current.tab.releasePointerCapture(current.pointerId)
    if (drop && current.outside) options.outside?.drop(current.id)
    else if (drop && current.to !== current.from) options.onDrop(current.id, current.to)
    options.outside?.end()
    void nextTick(() =>
      requestAnimationFrame(() => {
        for (const tab of current.tabs) tab.style.transition = ''
        options.onMove?.()
      }),
    )
    if (drop) {
      suppressClick = true
      // Released outside the strip, no click follows.
      setTimeout(() => (suppressClick = false), 0)
    }
  }

  return { dragging }
}
