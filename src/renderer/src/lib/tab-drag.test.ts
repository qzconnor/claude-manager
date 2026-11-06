import { describe, expect, it } from 'vitest'
import type { PaneSplit } from '@shared/types'
import { clampOffset, dockRect, dockSpot, dropIndex, shiftsFor, type Slot } from './tab-drag'

/** Three tabs of 100 px with 2 px between them: 0–100, 102–202, 204–304. */
const even: Slot[] = [
  { start: 0, size: 100 },
  { start: 102, size: 100 },
  { start: 204, size: 100 },
]

describe('dropIndex', () => {
  it('stays in place until the leading edge crosses a neighbour centre', () => {
    expect(dropIndex(even, 0, 0)).toBe(0)
    // End 100 + offset against the centres 152 and 254.
    expect(dropIndex(even, 0, 52)).toBe(0)
    expect(dropIndex(even, 0, 53)).toBe(1)
    expect(dropIndex(even, 0, 155)).toBe(2)
  })

  it('moves forwards from the end', () => {
    // Start 204 + offset against the centres 152 and 50.
    expect(dropIndex(even, 2, -52)).toBe(2)
    expect(dropIndex(even, 2, -53)).toBe(1)
    expect(dropIndex(even, 2, -155)).toBe(0)
  })

  it('reaches the first and the last place at the edges of the strip', () => {
    expect(dropIndex(even, 1, clampOffset(even, 1, 999))).toBe(2)
    expect(dropIndex(even, 1, clampOffset(even, 1, -999))).toBe(0)
  })

  it('handles tabs of different widths', () => {
    const slots: Slot[] = [
      { start: 0, size: 200 },
      { start: 202, size: 60 },
    ]
    // The small tab's start (202 px) has to cross the big one's centre (100 px).
    expect(dropIndex(slots, 1, -102)).toBe(1)
    expect(dropIndex(slots, 1, -103)).toBe(0)
    // The big tab gets behind the narrow last one although it can't move past its end.
    expect(dropIndex(slots, 0, clampOffset(slots, 0, 999))).toBe(1)
  })

  it('returns the start index for an unknown tab', () => {
    expect(dropIndex(even, 5, 100)).toBe(5)
  })
})

describe('shiftsFor', () => {
  it('moves nothing while the tab stays in place', () => {
    expect(shiftsFor(even, 1, 1, 2)).toEqual([0, 0, 0])
  })

  it('moves the passed tabs back by the dragged tab and the gap', () => {
    expect(shiftsFor(even, 0, 2, 2)).toEqual([0, -102, -102])
    expect(shiftsFor(even, 2, 0, 2)).toEqual([102, 102, 0])
  })

  it('makes room exactly as wide as a dragged tab of another width', () => {
    const slots: Slot[] = [
      { start: 10, size: 50 },
      { start: 64, size: 120 },
      { start: 188, size: 80 },
    ]
    // The wide tab goes first: the first tab moves behind it by 120 + 4.
    expect(shiftsFor(slots, 1, 0, 4)).toEqual([124, 0, 0])
  })

  it('works along the vertical axis the same way', () => {
    const rows: Slot[] = [
      { start: 40, size: 32 },
      { start: 76, size: 32 },
      { start: 112, size: 32 },
    ]
    expect(shiftsFor(rows, 0, 1, 4)).toEqual([0, -36, 0])
  })
})

describe('clampOffset', () => {
  it('keeps the dragged tab inside the strip', () => {
    expect(clampOffset(even, 1, -500)).toBe(-102)
    expect(clampOffset(even, 1, 500)).toBe(102)
    expect(clampOffset(even, 1, 40)).toBe(40)
  })

  it('returns 0 without tabs', () => {
    expect(clampOffset([], 0, 50)).toBe(0)
  })
})

describe('dockSpot', () => {
  // a | b, b takes the right quarter
  const layout: PaneSplit = { direction: 'row', ratio: 0.75, first: 'a', second: 'b' }

  it('finds the side of the part nearest to the point', () => {
    expect(dockSpot('a', 0.1, 0.5)).toEqual({ id: 'a', side: 'left' })
    expect(dockSpot('a', 0.9, 0.5)).toEqual({ id: 'a', side: 'right' })
    expect(dockSpot('a', 0.5, 0.2)).toEqual({ id: 'a', side: 'up' })
    expect(dockSpot('a', 0.5, 0.8)).toEqual({ id: 'a', side: 'down' })
  })

  it('measures within the part under the point', () => {
    expect(dockSpot(layout, 0.7, 0.5)).toEqual({ id: 'a', side: 'right' })
    expect(dockSpot(layout, 0.8, 0.5)).toEqual({ id: 'b', side: 'left' })
    expect(dockSpot(layout, 0.875, 0.1)).toEqual({ id: 'b', side: 'up' })
  })

  it('finds nothing outside the page', () => {
    expect(dockSpot(layout, 1.2, 0.5)).toBeNull()
    expect(dockSpot(layout, 0.5, -0.1)).toBeNull()
  })
})

describe('dockRect', () => {
  const rect = { left: 0.5, top: 0, width: 0.5, height: 1 }

  it('is the half of the part on that side', () => {
    expect(dockRect(rect, 'left')).toEqual({ left: 0.5, top: 0, width: 0.25, height: 1 })
    expect(dockRect(rect, 'right')).toEqual({ left: 0.75, top: 0, width: 0.25, height: 1 })
    expect(dockRect(rect, 'up')).toEqual({ left: 0.5, top: 0, width: 0.5, height: 0.5 })
    expect(dockRect(rect, 'down')).toEqual({ left: 0.5, top: 0.5, width: 0.5, height: 0.5 })
  })
})
