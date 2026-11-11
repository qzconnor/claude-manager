/** A divider moved with the keyboard: what it stands for, as `aria-valuenow`, `aria-valuemin` and `aria-valuemax` say. */
export interface SeparatorRange {
  value: number
  min: number
  max: number
  /** How far one arrow key moves it; with Shift five times as far. */
  step: number
  /** Where Enter puts it back, as a double click does. */
  initial: number
  /**
   * The value shrinks as the line moves right (or down): the size of a pane on the line's right
   * (or lower) side, such as a tree on the right.
   */
  reversed?: boolean
}

/** The keys' events this reads. */
type Keys = Pick<KeyboardEvent, 'key' | 'shiftKey' | 'altKey' | 'ctrlKey' | 'metaKey'>

/**
 * The value a key moves a divider to, like the window splitter of WAI-ARIA: the arrows along its axis
 * (`vertical`: an upright line, moved sideways), Home and End to the least and most, Enter back to where
 * it started. Null for any other key, also with Ctrl, Alt or Meta (they stay shortcuts).
 */
export function separatorValue(event: Keys, vertical: boolean, range: SeparatorRange): number | null {
  if (event.altKey || event.ctrlKey || event.metaKey) return null
  const { value, min, max, step, initial } = range
  const forward = range.reversed ? -1 : 1
  const by = step * (event.shiftKey ? 5 : 1) * forward
  let next: number
  switch (event.key) {
    case vertical ? 'ArrowLeft' : 'ArrowUp':
      next = value - by
      break
    case vertical ? 'ArrowRight' : 'ArrowDown':
      next = value + by
      break
    case 'Home':
      next = min
      break
    case 'End':
      next = max
      break
    case 'Enter':
      next = initial
      break
    default:
      return null
  }
  return Math.min(max, Math.max(min, next))
}
