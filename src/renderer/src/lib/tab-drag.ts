import { moveItem } from '@shared/order'

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
