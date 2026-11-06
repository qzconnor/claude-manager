import type { PaneDirection } from './panes'

/**
 * Global keyboard shortcuts. They are checked inside xterm's key handler as well, so the terminal
 * never swallows them, and by the main process for the keys a browser page gets (see
 * `matchBrowserShortcut`), which the window doesn't see.
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
  | 'split-right'
  | 'split-down'
  | 'focus-pane'
  | 'browser-address'
  | 'browser-reload'
  | 'browser-find'
  | 'browser-find-next'
  | 'browser-find-previous'
  | 'browser-back'
  | 'browser-forward'

/** What the matchers read of a key event: a DOM `KeyboardEvent`, or the main process' copy of an input event. */
export interface ShortcutKey {
  type: string
  key: string
  code: string
  /** Missing for input events of the main process; plus and minus are then known by their character. */
  keyCode?: number
  ctrlKey: boolean
  altKey: boolean
  shiftKey: boolean
  metaKey: boolean
}

export interface Shortcut {
  action: ShortcutAction
  /** 'select-tab': index of the tab, -1 for the last one. */
  index?: number
  /** 'focus-pane': where the terminal to move to lies. */
  direction?: PaneDirection
}

const ARROWS: Record<string, PaneDirection> = { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down' }

export function matchShortcut(e: ShortcutKey): Shortcut | null {
  if (e.type === 'keydown' && e.altKey && !e.ctrlKey && !e.metaKey) return matchPaneShortcut(e)
  const action = matchAction(e)
  if (action !== 'select-tab') return action ? { action } : null
  // Like in browsers: Ctrl+1–8 select that tab, Ctrl+9 the last one.
  const digit = Number(tabDigit(e))
  return { action, index: digit === 9 ? -1 : digit - 1 }
}

/**
 * Like in Windows Terminal: Alt+Shift+Plus splits to the right, Alt+Shift+Minus down, Alt+arrow
 * moves to the terminal in that direction. Plus and minus by the key (`keyCode`), as Shift turns
 * them into other characters depending on the layout (`*` and `_` on a German keyboard).
 */
function matchPaneShortcut(e: ShortcutKey): Shortcut | null {
  if (e.shiftKey) {
    if (e.keyCode === 187 || e.code === 'NumpadAdd' || e.key === '+') return { action: 'split-right' }
    if (e.keyCode === 189 || e.code === 'NumpadSubtract' || e.key === '-') return { action: 'split-down' }
    return null
  }
  const direction = ARROWS[e.key]
  return direction ? { action: 'focus-pane', direction } : null
}

function matchAction(e: ShortcutKey): ShortcutAction | null {
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
function tabDigit(e: ShortcutKey): string | null {
  return /^Digit([1-9])$/.exec(e.code)?.[1] ?? (/^[1-9]$/.test(e.key) ? e.key : null)
}

/**
 * Keys of a browser page that belong to the browser around it, like in Chrome: Ctrl+L goes to the
 * address bar, F5 and Ctrl+R load the page again, Ctrl+F searches the page and F3 (Shift+F3) jumps
 * to the next (previous) match. Only for keys the page gets: in a terminal Ctrl+R is Claude Code's
 * and the shell's. The back and forward buttons of the mouse (`browser-back`, `browser-forward`)
 * come from the window as app commands.
 */
export function matchBrowserShortcut(e: ShortcutKey): Shortcut | null {
  if (e.type !== 'keydown' || e.altKey || e.metaKey) return null
  const ctrl = e.ctrlKey
  if (e.key === 'F5' && !e.shiftKey) return { action: 'browser-reload' }
  if (e.key === 'F3' && !ctrl) return { action: e.shiftKey ? 'browser-find-previous' : 'browser-find-next' }
  if (!ctrl || e.shiftKey) return null
  const key = e.key.toLowerCase()
  if (key === 'l') return { action: 'browser-address' }
  if (key === 'r') return { action: 'browser-reload' }
  if (key === 'f') return { action: 'browser-find' }
  return null
}
