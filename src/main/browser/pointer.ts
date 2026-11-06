/** A spot of Claude's mouse pointer, in window pixels of the page. */
export interface PointerSpot {
  x: number
  y: number
}

const MIN_MOVE_MS = 150
const MAX_MOVE_MS = 450
const MS_PER_PIXEL = 0.35

/**
 * How long Claude's pointer takes from one spot to the next, so the user can follow it: quick for
 * short ways, never long. 0 when it has no spot yet (it appears at once) or is there already.
 */
export function pointerMoveMs(from: PointerSpot | null, to: PointerSpot): number {
  if (!from) return 0
  const distance = Math.hypot(to.x - from.x, to.y - from.y)
  if (distance < 2) return 0
  return Math.round(Math.min(MAX_MOVE_MS, MIN_MOVE_MS + distance * MS_PER_PIXEL))
}
