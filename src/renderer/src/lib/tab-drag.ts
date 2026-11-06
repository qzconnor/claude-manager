import { moveItem } from '@shared/order'
import { layoutPanes, type PaneDirection, type PaneRect } from '@shared/panes'
import type { PaneNode } from '@shared/types'

/** Where a tab sits along the strip's axis (px), as measured when the drag started. */
export interface Slot {
  start: number
  size: number
}

/**
 * The index the dragged tab takes when dropped now. Like browser tabs, it passes a neighbour as soon
 * as its leading edge crosses the neighbour's centre, so the first and last place stay reachable
 * while the tab is held inside the strip, whatever the widths.
 */
export function dropIndex(slots: readonly Slot[], from: number, offset: number): number {
  const dragged = slots[from]
  if (!dragged) return from
  const start = dragged.start + offset
  const end = start + dragged.size
  let index = 0
  slots.forEach((slot, i) => {
    if (i === from) return
    const centre = slot.start + slot.size / 2
    // Tabs before it stay before until its start crosses their centre, tabs after it come before once its end does.
    if (i < from ? start >= centre : end > centre) index++
  })
  return index
}

/**
 * How far every tab moves (px) to make room for the dragged one at `to`, laid out one after the other
 * with `gap` between them like the strip does. The dragged tab itself gets 0, it follows the pointer.
 */
export function shiftsFor(slots: readonly Slot[], from: number, to: number, gap: number): number[] {
  const shifts = slots.map(() => 0)
  let position = slots[0]?.start ?? 0
  for (const i of moveItem(
    slots.map((_, i) => i),
    from,
    to,
  )) {
    shifts[i] = position - slots[i].start
    position += slots[i].size + gap
  }
  shifts[from] = 0
  return shifts
}

/** Keeps the dragged tab between the first tab's start and the last tab's end. */
export function clampOffset(slots: readonly Slot[], from: number, offset: number): number {
  const dragged = slots[from]
  const first = slots[0]
  const last = slots.at(-1)
  if (!dragged || !first || !last) return 0
  const min = first.start - dragged.start
  const max = last.start + last.size - (dragged.start + dragged.size)
  return Math.max(min, Math.min(max, offset))
}

/** Where a tab dropped on the page goes: beside the part of terminal `id`, on `side` of it. */
export interface DockSpot {
  id: string
  side: PaneDirection
}

/**
 * The part of the shown tab under a point (`x`, `y` as shares of the page, 0–1), and the side of it
 * the point is nearest to: the part is cut along its diagonals, like the drop zones of editors.
 */
export function dockSpot(layout: PaneNode, x: number, y: number): DockSpot | null {
  for (const [id, rect] of layoutPanes(layout).panes) {
    const u = (x - rect.left) / rect.width
    const v = (y - rect.top) / rect.height
    if (!(u >= 0 && u <= 1 && v >= 0 && v <= 1)) continue
    const sides: [PaneDirection, number][] = [
      ['left', u],
      ['right', 1 - u],
      ['up', v],
      ['down', 1 - v],
    ]
    return { id, side: sides.reduce((best, next) => (next[1] < best[1] ? next : best))[0] }
  }
  return null
}

/** The half of a part on `side`: where the dropped tab will be. */
export function dockRect(rect: PaneRect, side: PaneDirection): PaneRect {
  const width = rect.width / 2
  const height = rect.height / 2
  if (side === 'left') return { ...rect, width }
  if (side === 'right') return { ...rect, left: rect.left + width, width }
  if (side === 'up') return { ...rect, height }
  return { ...rect, top: rect.top + height, height }
}
