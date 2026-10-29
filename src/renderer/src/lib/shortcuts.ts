/**
 * Global keyboard shortcuts. They are checked inside xterm's key handler as well,
 * so the terminal never swallows them.
 */
export type ShortcutAction =
  | 'new-tab'
  | 'close-tab'
  | 'next-tab'
  | 'previous-tab'
  | 'open-settings'
  | 'command-palette'
  | 'zoom-in'
  | 'zoom-out'
  | 'zoom-reset'
  | 'find'

export function matchShortcut(e: KeyboardEvent): ShortcutAction | null {
  if (e.type !== 'keydown') return null
  const ctrl = e.ctrlKey || e.metaKey
  if (!ctrl || e.altKey) return null
  const key = e.key.toLowerCase()
  if (e.shiftKey) {
    if (key === 't') return 'new-tab'
    if (key === 'w') return 'close-tab'
    if (key === 'p') return 'command-palette'
    if (key === 'f') return 'find'
    if (e.key === 'Tab') return 'previous-tab'
    return null
  }
  if (e.key === 'Tab') return 'next-tab'
  // Note: plain Ctrl+<letter> combos stay with the terminal (Claude Code uses Ctrl+K, Ctrl+R, …).
  if (key === ',') return 'open-settings'
  if (key === '=' || key === '+') return 'zoom-in'
  if (key === '-') return 'zoom-out'
  if (key === '0') return 'zoom-reset'
  return null
}
