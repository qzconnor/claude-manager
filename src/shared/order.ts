/**
 * `items` in the order of `ids`. Items whose id is missing keep their order after the others,
 * unknown and repeated ids are ignored, so a stale order from the window never loses a tab.
 */
export function applyOrder<T>(items: readonly T[], ids: readonly string[], idOf: (item: T) => string): T[] {
  const byId = new Map(items.map((item) => [idOf(item), item]))
  const ordered: T[] = []
  for (const id of ids) {
    const item = byId.get(id)
    if (item === undefined) continue
    ordered.push(item)
    byId.delete(id)
  }
  return [...ordered, ...byId.values()]
}

/** A copy of `items` with the item at `from` moved to `to`, its index in the result (clamped). */
export function moveItem<T>(items: readonly T[], from: number, to: number): T[] {
  const list = [...items]
  if (from < 0 || from >= list.length) return list
  const [item] = list.splice(from, 1)
  list.splice(Math.max(0, Math.min(to, list.length)), 0, item)
  return list
}
