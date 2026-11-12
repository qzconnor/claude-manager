/** The checked sessions of the list in selection mode, by `sessionKey`, and the last one clicked. */
export interface Checked {
  keys: Set<string>
  /** Where a Shift+click checks from; null after „Alle“ or a folder's checkbox. */
  anchor: string | null
}

/**
 * A click on a session in selection mode, as in the Explorer: checks or unchecks it. With Shift (`range`)
 * it checks everything from the last click to it in `order` (the sessions one can see, top to bottom) and
 * keeps what was checked already. Without a last click, or when that is out of view (its folder closed),
 * Shift+click checks or unchecks only the one. The clicked session is the next start either way.
 */
export function toggleChecked(checked: Checked, key: string, range: boolean, order: string[]): Checked {
  const keys = new Set(checked.keys)
  const from = range && checked.anchor !== null ? order.indexOf(checked.anchor) : -1
  const to = range ? order.indexOf(key) : -1
  if (from !== -1 && to !== -1) {
    for (const k of order.slice(Math.min(from, to), Math.max(from, to) + 1)) keys.add(k)
  } else if (keys.has(key)) keys.delete(key)
  else keys.add(key)
  return { keys, anchor: key }
}

/** Checks or unchecks a group of sessions (a folder's checkbox), the others stay as they are. */
export function setChecked(keys: Set<string>, group: string[], value: boolean): Set<string> {
  const next = new Set(keys)
  for (const key of group) {
    if (value) next.add(key)
    else next.delete(key)
  }
  return next
}
