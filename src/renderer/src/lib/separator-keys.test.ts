import { describe, expect, it } from 'vitest'
import { separatorValue, type SeparatorRange } from './separator-keys'

const key = (k: string, mods: Partial<{ shiftKey: boolean; altKey: boolean; ctrlKey: boolean; metaKey: boolean }> = {}) => ({
  key: k,
  shiftKey: false,
  altKey: false,
  ctrlKey: false,
  metaKey: false,
  ...mods,
})
const range: SeparatorRange = { value: 300, min: 180, max: 640, step: 16, initial: 260 }

describe('separatorValue', () => {
  it('moves an upright line sideways with the arrows, five steps with Shift', () => {
    expect(separatorValue(key('ArrowRight'), true, range)).toBe(316)
    expect(separatorValue(key('ArrowLeft'), true, range)).toBe(284)
    expect(separatorValue(key('ArrowRight', { shiftKey: true }), true, range)).toBe(380)
    // Up and down don't move it.
    expect(separatorValue(key('ArrowUp'), true, range)).toBeNull()
  })

  it('moves a lying line up and down', () => {
    expect(separatorValue(key('ArrowDown'), false, range)).toBe(316)
    expect(separatorValue(key('ArrowUp'), false, range)).toBe(284)
    expect(separatorValue(key('ArrowLeft'), false, range)).toBeNull()
  })

  it('turns round for a pane on the far side of the line', () => {
    expect(separatorValue(key('ArrowRight'), true, { ...range, reversed: true })).toBe(284)
    expect(separatorValue(key('ArrowLeft'), true, { ...range, reversed: true })).toBe(316)
  })

  it('goes to either end with Home and End, back with Enter, and stays within its range', () => {
    expect(separatorValue(key('Home'), true, range)).toBe(180)
    expect(separatorValue(key('End'), true, range)).toBe(640)
    expect(separatorValue(key('Enter'), true, range)).toBe(260)
    expect(separatorValue(key('ArrowRight', { shiftKey: true }), true, { ...range, value: 630 })).toBe(640)
    expect(separatorValue(key('ArrowLeft'), true, { ...range, value: 185 })).toBe(180)
  })

  it('leaves other keys and shortcuts alone', () => {
    expect(separatorValue(key('a'), true, range)).toBeNull()
    expect(separatorValue(key('ArrowRight', { ctrlKey: true }), true, range)).toBeNull()
    expect(separatorValue(key('ArrowRight', { altKey: true }), true, range)).toBeNull()
  })
})
