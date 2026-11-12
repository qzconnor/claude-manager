import { moveItem } from '@shared/order'
import { canInsertPane, insertPane, isSplit, paneIds, parsePaneNode, removePanes, setRatio, type PaneDirection, type SplitPath } from '@shared/panes'
import type { PaneNode } from '@shared/types'

/**
 * The window as in VS Code: its space is shared by groups (a tree of splits like the parts of a tab
 * used to be), and every group has a tab bar of its own. A tab is a terminal (by its id), one of the
 * app's pages (`page:settings`), a file's changes from the file tree (`diff:[root, path]`) or the
 * browser of the sessions (`BROWSER_TAB`). Like `@shared/panes`, nothing is changed in place.
 */

/**
 * The one tab that shows the sessions' browsers: the pages of the session with the keyboard. The pages
 * of the other sessions go on in the background, without tabs of their own.
 */
export const BROWSER_TAB = 'view:browser'

export const PAGES = ['sessions', 'artifacts', 'dashboard', 'accounts', 'settings'] as const
export type PageName = (typeof PAGES)[number]

const PAGE_PREFIX = 'page:'

export const isPage = (name: unknown): name is PageName => (PAGES as readonly unknown[]).includes(name)
export const pageTab = (page: PageName) => `${PAGE_PREFIX}${page}`
export function pageOfTab(tab: string | null | undefined): PageName | null {
  if (!tab?.startsWith(PAGE_PREFIX)) return null
  const page = tab.slice(PAGE_PREFIX.length)
  return isPage(page) ? page : null
}

const DIFF_PREFIX = 'diff:'

/**
 * A file whose changes a tab shows: the folder of its tree and the file in it (`/`-separated); the
 * folder itself (`''`) for all its changes, one below the other.
 */
export interface DiffFile {
  root: string
  path: string
}

export const diffTab = (file: DiffFile) => `${DIFF_PREFIX}${JSON.stringify([file.root, file.path])}`
export function diffOfTab(tab: string | null | undefined): DiffFile | null {
  if (!tab?.startsWith(DIFF_PREFIX)) return null
  try {
    const value = JSON.parse(tab.slice(DIFF_PREFIX.length)) as unknown
    if (Array.isArray(value) && value.length === 2 && typeof value[0] === 'string' && typeof value[1] === 'string' && value[0]) {
      return { root: value[0], path: value[1] }
    }
  } catch {
    // Not one of ours.
  }
  return null
}

/** A tab without a terminal: a page, a file's changes or the browser tab. */
export const isViewTab = (tab: string) => tab === BROWSER_TAB || pageOfTab(tab) !== null || diffOfTab(tab) !== null

/** A part of the window with tabs of its own. */
export interface TabGroup {
  id: string
  /** Terminal ids and pages, in the order of the group's tab bar. */
  tabs: string[]
  /** The tab the group shows; null only while it has none. */
  active: string | null
}

export interface Workspace {
  /** How the groups share the window; its parts are group ids. */
  layout: PaneNode
  groups: TabGroup[]
  /** The group with the keyboard. */
  activeGroup: string
}

export type DropSide = PaneDirection | 'center'

export function createWorkspace(groupId: string, tabs: string[] = []): Workspace {
  return { layout: groupId, groups: [{ id: groupId, tabs, active: tabs[0] ?? null }], activeGroup: groupId }
}

export const findGroup = (ws: Workspace, id: string) => ws.groups.find((g) => g.id === id)
export const groupOfTab = (ws: Workspace, tab: string) => ws.groups.find((g) => g.tabs.includes(tab))

/** Every tab, group by group in the order of the layout. */
export function allTabs(ws: Workspace): string[] {
  return paneIds(ws.layout).flatMap((id) => findGroup(ws, id)?.tabs ?? [])
}

function updateGroup(ws: Workspace, id: string, change: (group: TabGroup) => TabGroup): Workspace {
  return { ...ws, groups: ws.groups.map((g) => (g.id === id ? change(g) : g)) }
}

/**
 * Adds a tab to a group: at `index`, else right after the tab the group shows. `activate` makes it the
 * shown tab; a group without one always shows the new tab.
 */
export function addTab(ws: Workspace, groupId: string, tab: string, options: { index?: number; activate?: boolean } = {}): Workspace {
  return updateGroup(ws, groupId, (group) => {
    const tabs = group.tabs.filter((t) => t !== tab)
    const after = group.active ? tabs.indexOf(group.active) + 1 : tabs.length
    const index = Math.max(0, Math.min(options.index ?? (after || tabs.length), tabs.length))
    tabs.splice(index, 0, tab)
    return { ...group, tabs, active: options.activate || !group.active ? tab : group.active }
  })
}

/** The group nearest to `id` in the layout, which gets its space when it goes. */
function nearestGroup(node: PaneNode, id: string): string | null {
  if (!isSplit(node)) return null
  if (node.first === id) return paneIds(node.second)[0]
  if (node.second === id) return paneIds(node.first).at(-1) ?? null
  return nearestGroup(node.first, id) ?? nearestGroup(node.second, id)
}

/** Takes a group out of the layout, with its tabs; the last group stays, emptied. */
export function removeGroup(ws: Workspace, groupId: string): Workspace {
  if (!findGroup(ws, groupId)) return ws
  const layout = removePanes(ws.layout, new Set([groupId]))
  if (layout === null) return updateGroup(ws, groupId, (g) => ({ ...g, tabs: [], active: null }))
  const activeGroup = ws.activeGroup === groupId ? (nearestGroup(ws.layout, groupId) ?? paneIds(layout)[0]) : ws.activeGroup
  return { layout, groups: ws.groups.filter((g) => g.id !== groupId), activeGroup }
}

/**
 * Takes a tab out of its group. If it was shown, its neighbour (right, else left) is shown instead;
 * a group left without tabs goes, unless it is the last one (or `keepGroup`).
 */
export function removeTab(ws: Workspace, tab: string, keepGroup = false): Workspace {
  const group = groupOfTab(ws, tab)
  if (!group) return ws
  const index = group.tabs.indexOf(tab)
  const tabs = group.tabs.filter((t) => t !== tab)
  if (tabs.length === 0 && !keepGroup && ws.groups.length > 1) return removeGroup(ws, group.id)
  const active = group.active === tab ? (tabs[index] ?? tabs[index - 1] ?? null) : group.active
  return updateGroup(ws, group.id, (g) => ({ ...g, tabs, active }))
}

/**
 * A new group on `side` of `groupId`; the two share its space in half. A group split as often as the
 * window can be takes the tabs in itself instead.
 */
export function splitGroup(ws: Workspace, groupId: string, side: PaneDirection, newId: string, tabs: string[] = []): Workspace {
  if (!findGroup(ws, groupId)) return ws
  if (!canInsertPane(ws.layout, groupId)) return tabs.reduce((next, tab) => addTab(next, groupId, tab, { activate: true }), ws)
  return {
    ...ws,
    layout: insertPane(ws.layout, groupId, newId, side),
    groups: [...ws.groups, { id: newId, tabs, active: tabs[0] ?? null }],
  }
}

/** Shows `tab` in its group (if given) and gives the group the keyboard. */
export function setActive(ws: Workspace, groupId: string, tab?: string): Workspace {
  if (!findGroup(ws, groupId)) return ws
  const next = tab !== undefined ? showTab(ws, groupId, tab) : ws
  return next.activeGroup === groupId ? next : { ...next, activeGroup: groupId }
}

/** Shows a tab of a group without giving the group the keyboard. */
export function showTab(ws: Workspace, groupId: string, tab: string): Workspace {
  const group = findGroup(ws, groupId)
  return group && group.tabs.includes(tab) && group.active !== tab ? updateGroup(ws, groupId, (g) => ({ ...g, active: tab })) : ws
}

/** Moves a tab to `index` of a group (its own one: reordered) and shows it there. */
export function moveTab(ws: Workspace, tab: string, groupId: string, index?: number): Workspace {
  const from = groupOfTab(ws, tab)
  if (!from || !findGroup(ws, groupId)) return ws
  if (from.id === groupId) {
    const to = Math.max(0, Math.min(index ?? from.tabs.length - 1, from.tabs.length - 1))
    return updateGroup(ws, groupId, (g) => ({ ...g, tabs: moveItem(g.tabs, g.tabs.indexOf(tab), to) }))
  }
  const rest = removeTab(ws, tab)
  return setActive(addTab(rest, groupId, tab, { index: index ?? Number.MAX_SAFE_INTEGER, activate: true }), groupId)
}

/** Moves a tab into a new group on `side` of `groupId` and gives that the keyboard. */
export function dockTab(ws: Workspace, tab: string, groupId: string, side: PaneDirection, newId: string): Workspace {
  const from = groupOfTab(ws, tab)
  if (!from || !findGroup(ws, groupId) || (from.id === groupId && from.tabs.length === 1)) return ws
  const rest = removeTab(ws, tab)
  // The window can't be split there any further: the tab stays where it was.
  if (!findGroup(rest, groupId) || !canInsertPane(rest.layout, groupId)) return ws
  return { ...splitGroup(rest, groupId, side, newId, [tab]), activeGroup: newId }
}

/** `newTab` takes the place of `oldTab` (also as the shown tab); it leaves where it was before. */
export function replaceTab(ws: Workspace, oldTab: string, newTab: string): Workspace {
  if (!groupOfTab(ws, oldTab)) return ws
  const rest = groupOfTab(ws, newTab) ? removeTab(ws, newTab) : ws
  const group = groupOfTab(rest, oldTab)!
  return updateGroup(rest, group.id, (g) => ({
    ...g,
    tabs: g.tabs.map((t) => (t === oldTab ? newTab : t)),
    active: g.active === oldTab ? newTab : g.active,
  }))
}

export function resizeGroups(ws: Workspace, path: SplitPath, ratio: number): Workspace {
  return { ...ws, layout: setRatio(ws.layout, path, ratio) }
}

/** Every tab passed through `map`; tabs it maps to null are left out (groups left empty go). */
export function mapTabs(ws: Workspace, map: (tab: string) => string | null): Workspace {
  let next: Workspace = { ...ws, groups: ws.groups.map((g) => ({ ...g, tabs: [...g.tabs] })) }
  for (const tab of allTabs(ws)) if (map(tab) === null) next = removeTab(next, tab)
  return {
    ...next,
    groups: next.groups.map((g) => ({
      ...g,
      tabs: g.tabs.map((t) => map(t)!),
      active: g.active === null ? null : map(g.active),
    })),
  }
}

/**
 * A workspace from outside (the last run): null unless its layout names exactly its groups, and no
 * tab is in two of them.
 */
export function parseWorkspace(value: unknown): Workspace | null {
  if (!value || typeof value !== 'object') return null
  const raw = value as Record<string, unknown>
  const layout = parsePaneNode(raw.layout)
  if (!layout || !Array.isArray(raw.groups)) return null
  const ids = paneIds(layout)
  const seen = new Set<string>()
  const groups: TabGroup[] = []
  for (const item of raw.groups as unknown[]) {
    const g = item as Record<string, unknown>
    if (!g || typeof g.id !== 'string' || !ids.includes(g.id) || !Array.isArray(g.tabs)) return null
    const tabs = (g.tabs as unknown[]).filter((t): t is string => typeof t === 'string' && !seen.has(t))
    for (const tab of tabs) seen.add(tab)
    const active = typeof g.active === 'string' && tabs.includes(g.active) ? g.active : (tabs[0] ?? null)
    groups.push({ id: g.id, tabs, active })
  }
  if (groups.length !== ids.length) return null
  const activeGroup = typeof raw.activeGroup === 'string' && ids.includes(raw.activeGroup) ? raw.activeGroup : ids[0]
  return { layout, groups, activeGroup }
}

/**
 * Where a tab dragged to (`x`, `y`, px in the workspace) lands: over a group's tab bar (`barHeight`
 * high) it joins the group, over its content it goes beside it on the nearest edge, or into the
 * group from the middle. `rects` are the groups' areas in px.
 */
export function groupDropSpot(
  rects: ReadonlyMap<string, { left: number; top: number; width: number; height: number }>,
  x: number,
  y: number,
  barHeight: number,
): { groupId: string; side: DropSide } | null {
  for (const [groupId, rect] of rects) {
    if (x < rect.left || x > rect.left + rect.width || y < rect.top || y > rect.top + rect.height) continue
    if (y < rect.top + barHeight) return { groupId, side: 'center' }
    const u = (x - rect.left) / rect.width
    const v = (y - rect.top - barHeight) / Math.max(1, rect.height - barHeight)
    const sides: [PaneDirection, number][] = [
      ['left', u],
      ['right', 1 - u],
      ['up', v],
      ['down', 1 - v],
    ]
    const [side, distance] = sides.reduce((best, next) => (next[1] < best[1] ? next : best))
    return { groupId, side: distance < 0.3 ? side : 'center' }
  }
  return null
}

/** Height of a group's tab bar (px); the group's content starts below it. */
export const TAB_BAR_HEIGHT = 36

/** Height of the browser tab's bar with the session and its pages (px); the pages start below it. */
export const BROWSER_BAR_HEIGHT = 34
