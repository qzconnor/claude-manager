import { describe, expect, it } from 'vitest'
import { screenReaderOn } from './useScreenReader'

describe('screenReaderOn', () => {
  it('follows the system on auto, else the setting', () => {
    expect(screenReaderOn('auto', true)).toBe(true)
    expect(screenReaderOn('auto', false)).toBe(false)
    expect(screenReaderOn('on', false)).toBe(true)
    expect(screenReaderOn('off', true)).toBe(false)
  })
})
