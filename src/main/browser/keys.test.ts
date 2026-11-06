import { describe, expect, it } from 'vitest'
import { keyEvents } from './keys'

describe('keyEvents', () => {
  it('types a character with keyDown and text', () => {
    expect(keyEvents('a')).toEqual([
      { type: 'keyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 0, text: 'a' },
      { type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 0 },
    ])
  })

  it('presses Enter with its carriage return', () => {
    const [down] = keyEvents('Enter')
    expect(down).toMatchObject({ type: 'keyDown', key: 'Enter', windowsVirtualKeyCode: 13, text: '\r' })
  })

  it('presses keys that type nothing as rawKeyDown', () => {
    expect(keyEvents('ArrowDown').map((e) => e.type)).toEqual(['rawKeyDown', 'keyUp'])
    expect(keyEvents('F5')[0]).toMatchObject({ key: 'F5', windowsVirtualKeyCode: 116 })
  })

  it('holds modifiers around the key and releases them in reverse', () => {
    const events = keyEvents('Control+Shift+K')
    expect(events.map((e) => [e.type, e.key, e.modifiers])).toEqual([
      ['rawKeyDown', 'Control', 2],
      ['rawKeyDown', 'Shift', 10],
      ['rawKeyDown', 'K', 10],
      ['keyUp', 'K', 10],
      ['keyUp', 'Shift', 2],
      ['keyUp', 'Control', 0],
    ])
    // A shortcut types nothing.
    expect(events.some((e) => e.text !== undefined)).toBe(false)
  })

  it('types the shifted character with Shift alone', () => {
    expect(keyEvents('Shift+a')[1]).toMatchObject({ type: 'keyDown', key: 'A', text: 'A', modifiers: 8 })
  })

  it('knows the usual aliases, in any case', () => {
    expect(keyEvents('ctrl+a')[0]).toMatchObject({ key: 'Control' })
    expect(keyEvents('esc')[0]).toMatchObject({ key: 'Escape' })
    expect(keyEvents('pagedown')[0]).toMatchObject({ key: 'PageDown' })
    expect(keyEvents('Space')[0]).toMatchObject({ key: ' ', text: ' ' })
  })

  it('takes "+" itself as a key', () => {
    expect(keyEvents('+')[0]).toMatchObject({ key: '+', text: '+' })
    expect(keyEvents('Control++').map((e) => e.key)).toEqual(['Control', '+', '+', 'Control'])
  })

  it('rejects names it does not know', () => {
    expect(() => keyEvents('Hyper+a')).toThrow(/modifier/)
    expect(() => keyEvents('Launch')).toThrow(/Unknown key/)
    expect(() => keyEvents('')).toThrow()
  })
})
