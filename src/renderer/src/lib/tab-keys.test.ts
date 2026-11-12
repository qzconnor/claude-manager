import { describe, expect, it } from 'vitest'
import { isMenuKey, rovingIndex, tabKeyAction } from './tab-keys'

const tab = {}
const press = (key: string, mods: Partial<{ shiftKey: boolean; altKey: boolean; ctrlKey: boolean; metaKey: boolean }> = {}, target: object = tab) =>
  tabKeyAction({ key, shiftKey: false, altKey: false, ctrlKey: false, metaKey: false, ...mods, target, currentTarget: tab } as unknown as KeyboardEvent)

describe('tabKeyAction', () => {
  it('shows, closes and renames a tab, and goes back to its terminal', () => {
    expect(press('Enter')).toBe('select')
    expect(press(' ')).toBe('select')
    expect(press('Delete')).toBe('close')
    expect(press('F2')).toBe('rename')
    expect(press('Escape')).toBe('leave')
    expect(press('a')).toBeNull()
  })

  it('opens the context menu with the menu key and Shift+F10', () => {
    expect(press('ContextMenu')).toBe('menu')
    expect(press('F10', { shiftKey: true })).toBe('menu')
    expect(press('F10')).toBeNull()
  })

  it('leaves keys with modifiers and keys of what is inside the tab alone', () => {
    // Ctrl+Enter may be a shortcut, Shift+Delete is no closing.
    expect(press('Enter', { ctrlKey: true })).toBeNull()
    expect(press('Delete', { shiftKey: true })).toBeNull()
    expect(press('F10', { shiftKey: true, ctrlKey: true })).toBeNull()
    // The rename field inside the tab.
    expect(press('Enter', {}, {})).toBeNull()
  })
})

describe('isMenuKey', () => {
  const key = (k: string, mods: Partial<{ shiftKey: boolean; altKey: boolean; ctrlKey: boolean; metaKey: boolean }> = {}) =>
    isMenuKey({ key: k, shiftKey: false, altKey: false, ctrlKey: false, metaKey: false, ...mods })

  it('is the menu key or Shift+F10, without other modifiers', () => {
    expect(key('ContextMenu')).toBe(true)
    expect(key('F10', { shiftKey: true })).toBe(true)
    expect(key('F10')).toBe(false)
    expect(key('F10', { shiftKey: true, altKey: true })).toBe(false)
    expect(key('ContextMenu', { ctrlKey: true })).toBe(false)
  })
})

describe('rovingIndex', () => {
  it('moves along the strip and round at the ends', () => {
    expect(rovingIndex('ArrowRight', 0, 3, false)).toBe(1)
    expect(rovingIndex('ArrowRight', 2, 3, false)).toBe(0)
    expect(rovingIndex('ArrowLeft', 0, 3, false)).toBe(2)
    expect(rovingIndex('Home', 2, 3, false)).toBe(0)
    expect(rovingIndex('End', 0, 3, false)).toBe(2)
  })

  it('uses up and down in the sidebar, and nothing across', () => {
    expect(rovingIndex('ArrowDown', 0, 3, true)).toBe(1)
    expect(rovingIndex('ArrowUp', 0, 3, true)).toBe(2)
    expect(rovingIndex('ArrowRight', 0, 3, true)).toBeNull()
    expect(rovingIndex('ArrowDown', 0, 3, false)).toBeNull()
  })

  it('has nothing to move to without tabs, or from outside them', () => {
    expect(rovingIndex('ArrowRight', 0, 0, false)).toBeNull()
    expect(rovingIndex('ArrowRight', -1, 3, false)).toBeNull()
  })
})
