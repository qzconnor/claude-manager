import { describe, expect, it } from 'vitest'
import { colorFgBg, colorSchemeReport, ColorSchemeUpdates } from './color-scheme'

const ENABLE = '\x1b[?2031h'
const DISABLE = '\x1b[?2031l'

/** Feeds `chunks` one after another and returns the state after each. */
function states(chunks: string[]): boolean[] {
  const updates = new ColorSchemeUpdates()
  return chunks.map((chunk) => {
    updates.read(chunk)
    return updates.enabled
  })
}

describe('ColorSchemeUpdates', () => {
  it('starts disabled and follows enable and disable', () => {
    expect(states(['plain output', `text${ENABLE}more`, 'no escape here', `${DISABLE}`])).toEqual([false, true, true, false])
  })

  it('finds the mode among several in one switch', () => {
    expect(states(['\x1b[?1049;2031;25h'])).toEqual([true])
    expect(states([ENABLE, '\x1b[?25;2031l'])).toEqual([true, false])
  })

  it('ignores other private modes, including ones that only contain the digits', () => {
    expect(states(['\x1b[?25h\x1b[?1049h\x1b[?20310h\x1b[?12031h'])).toEqual([false])
    expect(states([ENABLE, '\x1b[?25l\x1b[2031l'])).toEqual([true, true])
  })

  it('takes the last switch within one chunk', () => {
    expect(states([`${ENABLE}x${DISABLE}`])).toEqual([false])
    expect(states([`${DISABLE}x${ENABLE}`])).toEqual([true])
  })

  it.each([1, 2, 3, 5, 7])('handles a switch split after %i characters', (at) => {
    expect(states([`out${ENABLE.slice(0, at)}`, `${ENABLE.slice(at)}rest`])).toEqual([false, true])
  })

  it('handles a switch split over three chunks', () => {
    expect(states(['\x1b', '[?20', '31h'])).toEqual([false, false, true])
  })

  it('drops an unfinished start when the next chunk does not continue it', () => {
    // `ESC [` followed by an ordinary SGR sequence is no mode switch.
    expect(states(['\x1b[', '31m2031h'])).toEqual([false, false])
  })
})

describe('colorSchemeReport', () => {
  it('reports dark as 1 and light as 2 (DSR 997)', () => {
    expect(colorSchemeReport(true)).toBe('\x1b[?997;1n')
    expect(colorSchemeReport(false)).toBe('\x1b[?997;2n')
  })
})

describe('colorFgBg', () => {
  it('puts the background last, as rxvt does', () => {
    expect(colorFgBg(true)).toBe('15;0')
    expect(colorFgBg(false)).toBe('0;15')
  })
})
