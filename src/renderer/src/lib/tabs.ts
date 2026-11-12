import { isSplit, paneIds, removePanes } from '@shared/panes'
import type { PaneNode, PaneSplit, TerminalInfo } from '@shared/types'

/** A tab of the window: one terminal, or several that share its space. */
export interface TerminalTabGroup {
  /** Id of the tab's first terminal (left, top); stays while that one is open. */
  id: string
  layout: PaneNode
  /** From left to right and top to bottom. */
  panes: TerminalInfo[]
}

/**
 * The tabs of the window: a tab with several terminals sits where the first of them is in the order,
 * every other terminal has a tab of its own. Parts of a layout that name no open terminal (yet) are
 * left out, and a terminal belongs to the first layout that names it.
 */
export function groupTabs(terminals: readonly TerminalInfo[], splits: readonly PaneSplit[]): TerminalTabGroup[] {
  const byId = new Map(terminals.map((t) => [t.id, t]))
  const claimed = new Set<string>()
  /** Terminal id → its tab's layout, for the tabs with several. */
  const layoutOf = new Map<string, PaneNode>()
  for (const split of splits) {
    const layout = removePanes(split, new Set(paneIds(split).filter((id) => !byId.has(id) || claimed.has(id))))
    if (!isSplit(layout)) continue
    for (const id of paneIds(layout)) {
      claimed.add(id)
      layoutOf.set(id, layout)
    }
  }
  const tabs: TerminalTabGroup[] = []
  const placed = new Set<PaneNode>()
  for (const terminal of terminals) {
    const layout = layoutOf.get(terminal.id) ?? terminal.id
    if (placed.has(layout)) continue
    placed.add(layout)
    const panes = paneIds(layout).map((id) => byId.get(id)!)
    tabs.push({ id: panes[0].id, layout, panes })
  }
  return tabs
}

/**
 * The terminals in the order they were opened, for the views of their panes. These lie where the
 * layout puts them, so the order of their elements doesn't show; but moving the element of a browser
 * loads its page again, and in the order of the tabs every reordering of tabs would move some.
 */
export function inOpeningOrder<T extends { id: string; createdAt: string }>(list: readonly T[]): T[] {
  return [...list].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
}
