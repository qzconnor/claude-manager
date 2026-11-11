import type { PaneNode, PaneSplit, SplitDirection } from './types'

/**
 * The terminals of a tab in parts of its space (see `PaneNode`). The trees are never changed in
 * place: every function returns a new one, so the window can compare and the main process keep them.
 */

/** The smallest share a part can be resized to. */
export const MIN_RATIO = 0.05
/**
 * The most splits on the way from the root to a part. Deeper trees are refused, also from the file of
 * the last run, so nothing may split further; nobody splits a tab into that many tiny parts.
 */
export const MAX_SPLIT_DEPTH = 16

/** Steps from the root to a split: into its `first` or its `second` part. */
export type SplitPath = readonly ('first' | 'second')[]

/** A part of the tab, as shares of its width and height. */
export interface PaneRect {
  left: number
  top: number
  width: number
  height: number
}

/** The line between the two parts of a split, where it can be resized. */
export interface PaneDivider {
  path: SplitPath
  direction: SplitDirection
  /** The space the split shares out. */
  area: PaneRect
  ratio: number
}

export type PaneDirection = 'left' | 'right' | 'up' | 'down'

export const isSplit = (node: PaneNode | null | undefined): node is PaneSplit => typeof node === 'object' && node !== null

const clampRatio = (ratio: number) => Math.min(1 - MIN_RATIO, Math.max(MIN_RATIO, ratio))

/** The terminal ids, from left to right and top to bottom. */
export function paneIds(node: PaneNode): string[] {
  return isSplit(node) ? [...paneIds(node.first), ...paneIds(node.second)] : [node]
}

export function hasPane(node: PaneNode, id: string): boolean {
  return isSplit(node) ? hasPane(node.first, id) || hasPane(node.second, id) : node === id
}

/** How many splits lie on the longest way from the root to a part; 0 for a single part. */
export function splitDepth(node: PaneNode): number {
  return isSplit(node) ? 1 + Math.max(splitDepth(node.first), splitDepth(node.second)) : 0
}

/** How many splits lie above the part of `id`; -1 when it isn't in the tree. */
export function depthOf(node: PaneNode, id: string): number {
  if (!isSplit(node)) return node === id ? 0 : -1
  const below = Math.max(depthOf(node.first, id), depthOf(node.second, id))
  return below === -1 ? -1 : below + 1
}

/** Whether `added` (a part, or the parts of another tab) fits beside the part of `id` within `MAX_SPLIT_DEPTH`. */
export function canInsertPane(node: PaneNode, id: string, added: PaneNode = id): boolean {
  const depth = depthOf(node, id)
  return depth !== -1 && depth + 1 + splitDepth(added) <= MAX_SPLIT_DEPTH
}

/** Splits the part of `id` in half: `id` keeps the left (`row`) or upper (`column`) half, `added` gets the other. */
export function splitPane(node: PaneNode, id: string, added: string, direction: SplitDirection): PaneNode {
  if (isSplit(node)) {
    return { ...node, first: splitPane(node.first, id, added, direction), second: splitPane(node.second, id, added, direction) }
  }
  return node === id ? { direction, ratio: 0.5, first: id, second: added } : node
}

/**
 * Puts `added` (a terminal, or all parts of another tab) on `side` of the part of `id`; the two share
 * that part in half. The tree as it is when `id` isn't in it.
 */
export function insertPane(node: PaneNode, id: string, added: PaneNode, side: PaneDirection): PaneNode {
  if (isSplit(node)) {
    const first = insertPane(node.first, id, added, side)
    const second = first === node.first ? insertPane(node.second, id, added, side) : node.second
    return first === node.first && second === node.second ? node : { ...node, first, second }
  }
  if (node !== id) return node
  const direction = side === 'left' || side === 'right' ? 'row' : 'column'
  const before = side === 'left' || side === 'up'
  return { direction, ratio: 0.5, first: before ? added : id, second: before ? id : added }
}

/** Without the terminals in `ids`: a split that loses a part is replaced by the other one. Null when nothing is left. */
export function removePanes(node: PaneNode, ids: ReadonlySet<string>): PaneNode | null {
  if (!isSplit(node)) return ids.has(node) ? null : node
  const first = removePanes(node.first, ids)
  const second = removePanes(node.second, ids)
  if (first === null) return second
  if (second === null) return first
  return first === node.first && second === node.second ? node : { ...node, first, second }
}

/** The tabs with more than one terminal, without the terminals in `ids`. */
export function dropPanes(splits: readonly PaneSplit[], ids: ReadonlySet<string>): PaneSplit[] {
  return splits.flatMap((split) => {
    const rest = removePanes(split, ids)
    return isSplit(rest) ? [rest] : []
  })
}

/** Every terminal id passed through `map`. */
export function mapPanes(node: PaneNode, map: (id: string) => string): PaneNode {
  return isSplit(node) ? { ...node, first: mapPanes(node.first, map), second: mapPanes(node.second, map) } : map(node)
}

export function replacePane(node: PaneNode, oldId: string, newId: string): PaneNode {
  return mapPanes(node, (id) => (id === oldId ? newId : id))
}

/**
 * Whom the pane `id` belongs to, e.g. a browser to the session it was opened beside: going out from
 * the pane, the first part beside it with an owner in it (`isOwner`); there the first one, the pane
 * that was split. Null without one.
 */
export function ownerOf(node: PaneNode, id: string, isOwner: (id: string) => boolean): string | null {
  if (!isSplit(node)) return null
  const [inner, beside] = hasPane(node.first, id) ? [node.first, node.second] : hasPane(node.second, id) ? [node.second, node.first] : [null, null]
  if (inner === null || beside === null) return null
  return ownerOf(inner, id, isOwner) ?? paneIds(beside).find(isOwner) ?? null
}

/** Whether two trees split the same terminals the same way, whatever their shares. */
export function sameShape(a: PaneNode, b: PaneNode): boolean {
  if (!isSplit(a) || !isSplit(b)) return a === b
  return a.direction === b.direction && sameShape(a.first, b.first) && sameShape(a.second, b.second)
}

/**
 * `splits` with `held` in place of the split of the same shape: a divider being dragged keeps its share
 * while a list comes that doesn't know it yet. Null for `held` when no split has its shape any more.
 */
export function holdSplit(splits: readonly PaneSplit[], held: PaneSplit): { splits: PaneSplit[]; held: PaneSplit | null } {
  const index = splits.findIndex((split) => sameShape(split, held))
  if (index === -1) return { splits: [...splits], held: null }
  return { splits: splits.map((split, i) => (i === index ? held : split)), held }
}

/** The split at `path` with another share for its first part. The tree as it is when there is no split there. */
export function setRatio(node: PaneNode, path: SplitPath, ratio: number): PaneNode {
  if (!isSplit(node)) return node
  if (path.length === 0) return { ...node, ratio: clampRatio(ratio) }
  const [step, ...rest] = path
  return { ...node, [step]: setRatio(node[step], rest, ratio) }
}

/**
 * A tree from outside (the window, the file of the last run): null unless every part is valid and
 * no terminal comes twice. Shares out of range are clamped.
 */
export function parsePaneNode(value: unknown): PaneNode | null {
  const seen = new Set<string>()
  const parse = (node: unknown, depth: number): PaneNode | null => {
    if (typeof node === 'string') {
      if (!node || seen.has(node)) return null
      seen.add(node)
      return node
    }
    if (!node || typeof node !== 'object' || depth >= MAX_SPLIT_DEPTH) return null
    const split = node as Record<string, unknown>
    if (split.direction !== 'row' && split.direction !== 'column') return null
    if (typeof split.ratio !== 'number' || !Number.isFinite(split.ratio)) return null
    const first = parse(split.first, depth + 1)
    const second = first === null ? null : parse(split.second, depth + 1)
    return second === null ? null : { direction: split.direction, ratio: clampRatio(split.ratio), first: first!, second }
  }
  return parse(value, 0)
}

/** Where each terminal and each divider lies in the tab. */
export function layoutPanes(node: PaneNode): { panes: Map<string, PaneRect>; dividers: PaneDivider[] } {
  const panes = new Map<string, PaneRect>()
  const dividers: PaneDivider[] = []
  const place = (part: PaneNode, area: PaneRect, path: SplitPath) => {
    if (!isSplit(part)) {
      panes.set(part, area)
      return
    }
    dividers.push({ path, direction: part.direction, area, ratio: part.ratio })
    if (part.direction === 'row') {
      const width = area.width * part.ratio
      place(part.first, { ...area, width }, [...path, 'first'])
      place(part.second, { ...area, left: area.left + width, width: area.width - width }, [...path, 'second'])
    } else {
      const height = area.height * part.ratio
      place(part.first, { ...area, height }, [...path, 'first'])
      place(part.second, { ...area, top: area.top + height, height: area.height - height }, [...path, 'second'])
    }
  }
  place(node, { left: 0, top: 0, width: 1, height: 1 }, [])
  return { panes, dividers }
}

const EPSILON = 1e-9

/**
 * The terminal next to `id` in `direction`, null at the edge of the tab. Of several, the one beside
 * the middle of `id`'s edge.
 */
export function neighbourPane(node: PaneNode, id: string, direction: PaneDirection): string | null {
  const { panes } = layoutPanes(node)
  const from = panes.get(id)
  if (!from) return null
  const horizontal = direction === 'left' || direction === 'right'
  // The edge to cross, and the middle of `from` along it.
  const edge =
    direction === 'left' ? from.left : direction === 'right' ? from.left + from.width : direction === 'up' ? from.top : from.top + from.height
  const middle = horizontal ? from.top + from.height / 2 : from.left + from.width / 2
  let best: { id: string; overlap: number; beside: boolean } | null = null
  for (const [other, rect] of panes) {
    if (other === id) continue
    const near =
      direction === 'left'
        ? rect.left + rect.width
        : direction === 'right'
          ? rect.left
          : direction === 'up'
            ? rect.top + rect.height
            : rect.top
    if (Math.abs(near - edge) > EPSILON) continue
    const [start, size, fromStart, fromSize] = horizontal
      ? [rect.top, rect.height, from.top, from.height]
      : [rect.left, rect.width, from.left, from.width]
    const overlap = Math.min(start + size, fromStart + fromSize) - Math.max(start, fromStart)
    if (overlap <= EPSILON) continue
    // On the line between two of them: the upper or left one.
    const beside = middle > start + EPSILON && middle <= start + size + EPSILON
    if (!best || (beside && !best.beside) || (beside === best.beside && overlap > best.overlap)) {
      best = { id: other, overlap, beside }
    }
  }
  return best?.id ?? null
}
