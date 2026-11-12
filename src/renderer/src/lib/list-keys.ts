/** Where an arrow key takes the keyboard in a tree of rows: to another row, or open or close the row's group. */
export type ListMove = { to: number } | { toggle: true }

/** The row with the keyboard among the rows one can see, top to bottom. */
export interface ListRow {
  index: number
  count: number
  /** The row opens a group (a folder): whether it is open; null for a row without one (a session). */
  expanded: boolean | null
  /** The row of the group the row lies in, -1 at the top. */
  parent: number
}

/**
 * What a key does in a tree of rows, as in the tree view of WAI-ARIA and the Explorer: Up and Down to the
 * row above and below (they stop at the ends), Home and End to the first and the last. Right opens a closed
 * group and goes into an open one, Left closes an open group or goes up to the group around. Null for other keys.
 */
export function listMove(key: string, row: ListRow): ListMove | null {
  const { index, count, expanded, parent } = row
  if (count === 0 || index < 0) return null
  switch (key) {
    case 'ArrowDown':
      return { to: Math.min(index + 1, count - 1) }
    case 'ArrowUp':
      return { to: Math.max(index - 1, 0) }
    case 'Home':
      return { to: 0 }
    case 'End':
      return { to: count - 1 }
    case 'ArrowRight':
      if (expanded === false) return { toggle: true }
      return expanded && index + 1 < count ? { to: index + 1 } : null
    case 'ArrowLeft':
      if (expanded) return { toggle: true }
      return parent >= 0 ? { to: parent } : null
    default:
      return null
  }
}
