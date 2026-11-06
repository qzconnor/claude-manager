/**
 * Global keyboard shortcuts. They are checked inside xterm's key handler as well,
 * so the terminal never swallows them.
 */
export type ShortcutAction =
  | 'new-tab'
  | 'close-tab'
  | 'next-tab'
  | 'previous-tab'
  | 'select-tab'
  | 'open-settings'
  | 'command-palette'
  | 'tab-search'
  | 'zoom-in'
  | 'zoom-out'
  | 'zoom-reset'
  | 'find'

export interface Shortcut {
  action: ShortcutAction
  /** 'select-tab': index of the tab, -1 for the last one. */
  index?: number
}

export function matchShortcut(e: KeyboardEvent): Shortcut | null {
  const action = matchAction(e)
  if (action !== 'select-tab') return action ? { action } : null
  // Like in browsers: Ctrl+1–8 select that tab, Ctrl+9 the last one.
  const digit = Number(tabDigit(e))
  return { action, index: digit === 9 ? -1 : digit - 1 }
}

function matchAction(e: KeyboardEvent): ShortcutAction | null {
  if (e.type !== 'keydown') return null
  const ctrl = e.ctrlKey || e.metaKey
  if (!ctrl || e.altKey) return null
  const key = e.key.toLowerCase()
  if (e.shiftKey) {
    if (key === 't') return 'new-tab'
    if (key === 'w') return 'close-tab'
    if (key === 'p') return 'command-palette'
    if (key === 'a') return 'tab-search'
    if (key === 'f') return 'find'
    if (e.key === 'Tab') return 'previous-tab'
    return null
  }
  if (e.key === 'Tab') return 'next-tab'
  if (tabDigit(e)) return 'select-tab'
  // Note: plain Ctrl+<letter> combos stay with the terminal (Claude Code uses Ctrl+K, Ctrl+R, …).
  if (key === ',') return 'open-settings'
  if (key === '=' || key === '+') return 'zoom-in'
  if (key === '-') return 'zoom-out'
  if (key === '0') return 'zoom-reset'
  return null
}

/**
 * The digit 1–9 of the key, also from the number row of layouts that type something else there
 * without Shift (e.g. "&" on AZERTY). The number pad counts only with Num Lock, without it its keys
 * are End, arrows etc.
 */
function tabDigit(e: KeyboardEvent): string | null {
  return /^Digit([1-9])$/.exec(e.code)?.[1] ?? (/^[1-9]$/.test(e.key) ? e.key : null)
}
