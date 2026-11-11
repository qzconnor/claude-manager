/** What a key does on a tab that has the keyboard: shows it, closes it, renames it, opens its menu, or goes back to its terminal. */
export type TabKeyAction = 'select' | 'close' | 'rename' | 'menu' | 'leave'

/** The keys' events this reads. */
type Keys = Pick<KeyboardEvent, 'key' | 'shiftKey' | 'altKey' | 'ctrlKey' | 'metaKey' | 'target' | 'currentTarget'>

/**
 * What a key does on a focused tab, like in a browser's or VS Code's tab bar: Enter and Space show it,
 * Delete closes it, F2 renames it, the menu key and Shift+F10 open its context menu, Escape goes back to
 * the terminal. Null for other keys, with other modifiers, and for keys of something inside the tab,
 * such as its rename field.
 */
export function tabKeyAction(event: Keys): TabKeyAction | null {
  if (event.target !== event.currentTarget || event.altKey || event.ctrlKey || event.metaKey) return null
  if (event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey)) return 'menu'
  if (event.shiftKey) return null
  switch (event.key) {
    case 'Enter':
    case ' ':
      return 'select'
    case 'Delete':
      return 'close'
    case 'F2':
      return 'rename'
    case 'Escape':
      return 'leave'
    default:
      return null
  }
}

/**
 * Opens an element's context menu below it, as a right click there would. Opened from the keyboard,
 * Chromium puts it over the middle of the element, where it hides the tab it belongs to.
 */
export function openMenuBelow(el: HTMLElement): void {
  const rect = el.getBoundingClientRect()
  el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: rect.left + 4, clientY: rect.bottom }))
}

/**
 * The tab an arrow key moves the keyboard to among `count` tabs, from the one at `index`: the next or
 * the one before along the strip (round at the ends), Home and End the first and the last. Null for other keys.
 */
export function rovingIndex(key: string, index: number, count: number, vertical: boolean): number | null {
  if (count === 0 || index < 0) return null
  switch (key) {
    case vertical ? 'ArrowDown' : 'ArrowRight':
      return (index + 1) % count
    case vertical ? 'ArrowUp' : 'ArrowLeft':
      return (index - 1 + count) % count
    case 'Home':
      return 0
    case 'End':
      return count - 1
    default:
      return null
  }
}
