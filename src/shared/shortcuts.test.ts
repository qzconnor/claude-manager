import { describe, expect, it } from 'vitest'
import { matchBrowserShortcut, matchShortcut, type ShortcutKey } from './shortcuts'

interface Keys {
  key: string
  code?: string
  ctrl?: boolean
  shift?: boolean
  alt?: boolean
  meta?: boolean
  type?: string
  keyCode?: number
}

/** Just the fields matchShortcut reads; there is no KeyboardEvent in node. */
function press({ key, code = '', ctrl = true, shift = false, alt = false, meta = false, type = 'keydown', keyCode = 0 }: Keys) {
  return { key, code, ctrlKey: ctrl, shiftKey: shift, altKey: alt, metaKey: meta, type, keyCode } as ShortcutKey
}

describe('matchShortcut', () => {
  it('matches the shortcuts with Shift', () => {
    expect(matchShortcut(press({ key: 'T', shift: true }))).toEqual({ action: 'new-tab' })
    expect(matchShortcut(press({ key: 'W', shift: true }))).toEqual({ action: 'close-tab' })
    expect(matchShortcut(press({ key: 'P', shift: true }))).toEqual({ action: 'command-palette' })
    expect(matchShortcut(press({ key: 'A', shift: true }))).toEqual({ action: 'tab-search' })
    expect(matchShortcut(press({ key: 'F', shift: true }))).toEqual({ action: 'find' })
    expect(matchShortcut(press({ key: 'Tab', shift: true }))).toEqual({ action: 'previous-tab' })
  })

  it('matches the shortcuts without Shift', () => {
    expect(matchShortcut(press({ key: 'Tab' }))).toEqual({ action: 'next-tab' })
    expect(matchShortcut(press({ key: ',' }))).toEqual({ action: 'open-settings' })
    expect(matchShortcut(press({ key: '+' }))).toEqual({ action: 'zoom-in' })
    expect(matchShortcut(press({ key: '=' }))).toEqual({ action: 'zoom-in' })
    expect(matchShortcut(press({ key: '-' }))).toEqual({ action: 'zoom-out' })
    expect(matchShortcut(press({ key: '0', code: 'Digit0' }))).toEqual({ action: 'zoom-reset' })
  })

  it('accepts Cmd instead of Ctrl', () => {
    expect(matchShortcut(press({ key: ',', ctrl: false, meta: true }))).toEqual({ action: 'open-settings' })
  })

  it('leaves plain Ctrl+letter, Alt combinations, other events and keys without Ctrl to the terminal', () => {
    expect(matchShortcut(press({ key: 'k' }))).toBeNull()
    expect(matchShortcut(press({ key: 'r' }))).toBeNull()
    expect(matchShortcut(press({ key: 'c' }))).toBeNull()
    expect(matchShortcut(press({ key: 't', alt: true, shift: true }))).toBeNull()
    expect(matchShortcut(press({ key: '1', code: 'Digit1', alt: true }))).toBeNull()
    expect(matchShortcut(press({ key: 'T', shift: true, type: 'keyup' }))).toBeNull()
    expect(matchShortcut(press({ key: '1', code: 'Digit1', ctrl: false }))).toBeNull()
    expect(matchShortcut(press({ key: 'X', shift: true }))).toBeNull()
  })

  describe('split panes', () => {
    const alt = (key: string, extra: Partial<Keys> = {}) => press({ key, ctrl: false, alt: true, ...extra })

    it('splits with Alt+Shift+Plus and Alt+Shift+Minus, also where Shift types other characters', () => {
      expect(matchShortcut(alt('+', { shift: true, keyCode: 187 }))).toEqual({ action: 'split-right' })
      // German layout: Shift makes + a * and - an _.
      expect(matchShortcut(alt('*', { shift: true, keyCode: 187, code: 'BracketRight' }))).toEqual({ action: 'split-right' })
      expect(matchShortcut(alt('_', { shift: true, keyCode: 189, code: 'Slash' }))).toEqual({ action: 'split-down' })
      expect(matchShortcut(alt('+', { shift: true, code: 'NumpadAdd', keyCode: 107 }))).toEqual({ action: 'split-right' })
      expect(matchShortcut(alt('-', { shift: true, code: 'NumpadSubtract', keyCode: 109 }))).toEqual({ action: 'split-down' })
    })

    it('moves between the terminals of a tab with Alt+arrow', () => {
      expect(matchShortcut(alt('ArrowLeft'))).toEqual({ action: 'focus-pane', direction: 'left' })
      expect(matchShortcut(alt('ArrowDown'))).toEqual({ action: 'focus-pane', direction: 'down' })
    })

    it('leaves AltGr (Ctrl+Alt), Alt+Shift+arrow and other Alt keys to the terminal', () => {
      expect(matchShortcut(alt('*', { shift: true, keyCode: 187, ctrl: true }))).toBeNull()
      expect(matchShortcut(alt('ArrowLeft', { shift: true }))).toBeNull()
      expect(matchShortcut(alt('b'))).toBeNull()
      expect(matchShortcut(alt('ArrowLeft', { type: 'keyup' }))).toBeNull()
    })
  })

  describe('select-tab', () => {
    it('selects tabs 1–8 by index and the last one with 9', () => {
      expect(matchShortcut(press({ key: '1', code: 'Digit1' }))).toEqual({ action: 'select-tab', index: 0 })
      expect(matchShortcut(press({ key: '8', code: 'Digit8' }))).toEqual({ action: 'select-tab', index: 7 })
      expect(matchShortcut(press({ key: '9', code: 'Digit9' }))).toEqual({ action: 'select-tab', index: -1 })
    })

    it('uses the key position on layouts with other characters on the number row', () => {
      // AZERTY: the "1" key types "&" without Shift.
      expect(matchShortcut(press({ key: '&', code: 'Digit1' }))).toEqual({ action: 'select-tab', index: 0 })
    })

    it('takes the number pad with Num Lock, but not its End/arrow keys without it', () => {
      expect(matchShortcut(press({ key: '3', code: 'Numpad3' }))).toEqual({ action: 'select-tab', index: 2 })
      expect(matchShortcut(press({ key: 'End', code: 'Numpad1' }))).toBeNull()
    })

    it('is not triggered with Shift', () => {
      expect(matchShortcut(press({ key: '!', code: 'Digit1', shift: true }))).toBeNull()
    })
  })
})

describe('matchBrowserShortcut', () => {
  it('knows the keys of the browser around a page', () => {
    expect(matchBrowserShortcut(press({ key: 'l' }))).toEqual({ action: 'browser-address' })
    expect(matchBrowserShortcut(press({ key: 'R' }))).toEqual({ action: 'browser-reload' })
    expect(matchBrowserShortcut(press({ key: 'F5', ctrl: false }))).toEqual({ action: 'browser-reload' })
  })

  it('leaves other combinations and released keys to the page', () => {
    expect(matchBrowserShortcut(press({ key: 'l', shift: true }))).toBeNull()
    expect(matchBrowserShortcut(press({ key: 'l', ctrl: true, alt: true }))).toBeNull()
    expect(matchBrowserShortcut(press({ key: 'l', ctrl: false }))).toBeNull()
    expect(matchBrowserShortcut(press({ key: 'l', type: 'keyup' }))).toBeNull()
  })

  it('finds the split keys by their character when the key code is unknown (main process)', () => {
    const { keyCode: _, ...plus } = press({ key: '+', code: 'NumpadAdd', ctrl: false, alt: true, shift: true })
    expect(matchShortcut(plus)).toEqual({ action: 'split-right' })
  })
})
