import { describe, expect, it } from 'vitest'
import { setChecked, toggleChecked, type Checked } from './session-selection'

const order = ['a', 'b', 'c', 'd', 'e']
const none: Checked = { keys: new Set(), anchor: null }
const keysOf = (checked: Checked) => [...checked.keys].sort()

describe('toggleChecked', () => {
  it('checks a session with a click and unchecks it with the next', () => {
    const once = toggleChecked(none, 'b', false, order)
    expect(keysOf(once)).toEqual(['b'])
    expect(once.anchor).toBe('b')
    expect(keysOf(toggleChecked(once, 'b', false, order))).toEqual([])
  })

  it('checks everything from the last click to a Shift+click, down and up', () => {
    const start = toggleChecked(none, 'b', false, order)
    expect(keysOf(toggleChecked(start, 'd', true, order))).toEqual(['b', 'c', 'd'])
    const fromBelow = toggleChecked(none, 'd', false, order)
    expect(keysOf(toggleChecked(fromBelow, 'a', true, order))).toEqual(['a', 'b', 'c', 'd'])
  })

  it('keeps what was checked before when it adds a range, and starts the next range at the Shift+click', () => {
    let checked = toggleChecked(none, 'e', false, order)
    checked = toggleChecked(checked, 'a', false, order)
    checked = toggleChecked(checked, 'b', true, order)
    expect(keysOf(checked)).toEqual(['a', 'b', 'e'])
    expect(checked.anchor).toBe('b')
    expect(keysOf(toggleChecked(checked, 'd', true, order))).toEqual(['a', 'b', 'c', 'd', 'e'])
  })

  it('checks only the one with Shift when there is no last click, or it is out of view', () => {
    expect(keysOf(toggleChecked(none, 'c', true, order))).toEqual(['c'])
    // The last click was in a folder closed since.
    const hidden: Checked = { keys: new Set(['x']), anchor: 'x' }
    expect(keysOf(toggleChecked(hidden, 'c', true, order))).toEqual(['c', 'x'])
  })

  it('does not change the set it is given', () => {
    const checked: Checked = { keys: new Set(['a']), anchor: 'a' }
    toggleChecked(checked, 'c', true, order)
    expect(keysOf(checked)).toEqual(['a'])
  })
})

describe('setChecked', () => {
  it('checks and unchecks a folder’s sessions and leaves the others', () => {
    const keys = new Set(['a', 'x'])
    expect([...setChecked(keys, ['b', 'c'], true)].sort()).toEqual(['a', 'b', 'c', 'x'])
    expect([...setChecked(keys, ['a', 'b'], false)].sort()).toEqual(['x'])
    expect([...keys].sort()).toEqual(['a', 'x'])
  })
})
