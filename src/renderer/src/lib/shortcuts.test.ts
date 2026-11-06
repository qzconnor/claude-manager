import { describe, expect, it } from 'vitest'
import { matchShortcut } from './shortcuts'

interface Keys {
  key: string
  code?: string
  ctrl?: boolean
  shift?: boolean
  alt?: boolean
  meta?: boolean
  type?: string
}

/** Just the fields matchShortcut reads; there is no KeyboardEvent in node. */
function press({ key, code = '', ctrl = true, shift = false, alt = false, meta = false, type = 'keydown' }: Keys) {
  return { key, code, ctrlKey: ctrl, shiftKey: shift, altKey: alt, metaKey: meta, type } as KeyboardEvent
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
