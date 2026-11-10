import { useEventListener } from '@vueuse/core'
import { onScopeDispose, ref, type Ref } from 'vue'
import { suppressTooltips } from '@/lib/tooltip'

/** Pixels the pointer has to move before a press on a header becomes a drag (a click stays a click). */
const THRESHOLD = 5
/** Near the list's top or bottom edge (px) the list scrolls along, at most this many px per frame. */
const EDGE = 48
const MAX_SPEED = 18

interface Options {
  /** The section `id` was dropped before the section `before`; null: after the last one. */
  onDrop: (id: string, before: string | null) => void
}

interface Press {
  pointerId: number
  x: number
  y: number
  grip: HTMLElement
  section: HTMLElement
}

interface Drag {
  pointerId: number
  id: string
  section: HTMLElement
  grip: HTMLElement
  /** A copy of the header that follows the pointer. */
  ghost: HTMLElement
  /** Where the section would land. */
  line: HTMLElement
  /** Where the header was grabbed, from its top. */
  grabY: number
  height: number
  pointerY: number
  /** Where it would land: before this section, null after the last; undefined where it already is. */
  before: string | null | undefined
  frame: number
}

/**
 * Lets the sections of a scrolling list be reordered by dragging their header. The sections are the
 * list's `[data-drag-id]` elements, grabbed by their `[data-drag-grip]`; a copy of the header follows
 * the pointer, a line shows where the section lands, and near the list's edges it scrolls along.
 * Sections stay open while dragged: the line goes to the border between sections nearest the pointer.
 * Escape cancels; the click that ends a drag doesn't reach the header.
 */
export function useSectionDrag(list: Ref<HTMLElement | null>, options: Options) {
  /** Id of the section being dragged. */
  const dragging = ref<string | null>(null)
  let press: Press | null = null
  let drag: Drag | null = null
  let suppressClick = false

  useEventListener(list, 'pointerdown', (event: PointerEvent) => {
    if (event.button !== 0 || drag) return
    const grip = (event.target as Element).closest<HTMLElement>('[data-drag-grip]')
    const section = grip?.closest<HTMLElement>('[data-drag-id]')
    if (!grip || !section) return
    press = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, grip, section }
  })

  useEventListener(window, 'pointermove', (event: PointerEvent) => {
    if (drag) {
      if (event.pointerId === drag.pointerId) {
        drag.pointerY = event.clientY
        update(drag)
      }
      return
    }
    if (!press || event.pointerId !== press.pointerId) return
    if (Math.max(Math.abs(event.clientX - press.x), Math.abs(event.clientY - press.y)) < THRESHOLD) return
    start(press, event.clientY)
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
    list,
    'click',
    (event: MouseEvent) => {
      if (!suppressClick) return
      suppressClick = false
      event.stopPropagation()
      event.preventDefault()
    },
    { capture: true },
  )
  onScopeDispose(() => finish(false))

  function sections(): HTMLElement[] {
    return [...(list.value?.querySelectorAll<HTMLElement>('[data-drag-id]') ?? [])]
  }

  function start(from: Press, pointerY: number) {
    press = null
    const id = from.section.dataset.dragId
    if (!id || sections().length < 2) return
    const header = from.grip.closest<HTMLElement>('[data-drag-header]') ?? from.grip
    const rect = header.getBoundingClientRect()

    const ghost = header.cloneNode(true) as HTMLElement
    ghost.setAttribute('aria-hidden', 'true')
    ghost.inert = true
    ghost.classList.add('shadow-lg', 'ring-1', 'ring-foreground/15')
    Object.assign(ghost.style, {
      position: 'fixed',
      left: `${rect.left}px`,
      top: `${rect.top}px`,
      width: `${rect.width}px`,
      height: `${rect.height}px`,
      margin: '0',
      zIndex: '60',
      pointerEvents: 'none',
      cursor: 'grabbing',
    })
    const line = document.createElement('div')
    line.className = 'rounded-full bg-primary'
    Object.assign(line.style, { position: 'fixed', height: '2px', zIndex: '60', pointerEvents: 'none', display: 'none' })
    document.body.append(ghost, line)

    drag = {
      pointerId: from.pointerId,
      id,
      section: from.section,
      grip: from.grip,
      ghost,
      line,
      grabY: from.y - rect.top,
      height: rect.height,
      pointerY,
      before: undefined,
      frame: 0,
    }
    dragging.value = id
    suppressTooltips(true)
    // Styled by the section (`data-dragging:`), so it reads as the one being moved.
    from.section.dataset.dragging = ''
    document.documentElement.style.cursor = 'grabbing'
    try {
      from.grip.setPointerCapture(from.pointerId)
    } catch {
      // The pointer is already gone (released in between); the window listeners still end the drag.
    }
    const tick = () => {
      if (!drag) return
      scrollAlong(drag)
      drag.frame = requestAnimationFrame(tick)
    }
    update(drag)
    tick()
  }

  /** Near the top or bottom of the list it scrolls, faster the closer the pointer. */
  function scrollAlong(current: Drag) {
    const el = list.value
    if (!el) return
    const box = el.getBoundingClientRect()
    const above = box.top + EDGE - current.pointerY
    const below = current.pointerY - (box.bottom - EDGE)
    const speed = above > 0 ? -above : below > 0 ? below : 0
    if (!speed) return
    const before = el.scrollTop
    el.scrollTop += Math.max(-MAX_SPEED, Math.min(MAX_SPEED, Math.round((speed / EDGE) * MAX_SPEED)))
    if (el.scrollTop !== before) update(current)
  }

  function update(current: Drag) {
    const el = list.value
    if (!el) return
    const box = el.getBoundingClientRect()
    const top = Math.min(Math.max(current.pointerY - current.grabY, box.top), box.bottom - current.height)
    current.ghost.style.top = `${top}px`

    const all = sections()
    const from = all.indexOf(current.section)
    if (from === -1) return
    const rects = all.map((s) => s.getBoundingClientRect())
    const gap = rects.length > 1 ? Math.max(0, rects[1]!.top - rects[0]!.bottom) : 0
    // The borders between the sections, before the first and after the last; the nearest one wins.
    const borders = [...rects.map((r) => r.top - gap / 2), rects.at(-1)!.bottom + gap / 2]
    let at = 0
    borders.forEach((y, i) => {
      if (Math.abs(y - current.pointerY) < Math.abs(borders[at]! - current.pointerY)) at = i
    })
    current.before = at === from || at === from + 1 ? undefined : (all[at]?.dataset.dragId ?? null)

    const y = borders[at]!
    const visible = current.before !== undefined && y >= box.top && y <= box.bottom
    Object.assign(current.line.style, {
      display: visible ? 'block' : 'none',
      top: `${y - 1}px`,
      left: `${rects[0]!.left}px`,
      width: `${rects[0]!.width}px`,
    })
  }

  function finish(drop: boolean) {
    const current = drag
    if (!current) return
    drag = null
    dragging.value = null
    suppressTooltips(false)
    cancelAnimationFrame(current.frame)
    current.ghost.remove()
    current.line.remove()
    delete current.section.dataset.dragging
    document.documentElement.style.cursor = ''
    if (current.grip.hasPointerCapture(current.pointerId)) current.grip.releasePointerCapture(current.pointerId)
    if (drop && current.before !== undefined) options.onDrop(current.id, current.before)
    if (drop) {
      suppressClick = true
      // Released outside the header, no click follows.
      setTimeout(() => (suppressClick = false), 0)
    }
  }

  return { dragging }
}
