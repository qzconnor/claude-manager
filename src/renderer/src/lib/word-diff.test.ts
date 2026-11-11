import { describe, expect, it } from 'vitest'
import { changedRanges, MAX_WORD_DIFF_CHARS, splitByRanges, type Range } from './word-diff'

/** The marked parts of a line, as text. */
const marked = (text: string, ranges: readonly Range[]) => ranges.map(([start, end]) => text.slice(start, end))

describe('changedRanges', () => {
  it('marks the words that changed on both sides', () => {
    const a = 'const total = price * count'
    const b = 'const total = price * amount + tax'
    const ranges = changedRanges(a, b)!
    expect(marked(a, ranges.a)).toEqual(['count'])
    expect(marked(b, ranges.b)).toEqual(['amount + tax'])
  })

  it('marks only what was added, and nothing on the side that lost nothing', () => {
    const ranges = changedRanges('call(a)', 'call(a, b)')!
    expect(ranges.a).toEqual([])
    expect(marked('call(a, b)', ranges.b)).toEqual([', b'])
  })

  it('keeps changes apart that a kept word parts', () => {
    const a = 'if (open && ready) start()'
    const b = 'if (closed && ready) stop()'
    expect(marked(a, changedRanges(a, b)!.a)).toEqual(['open', 'start'])
  })

  it('reads umlauts as part of a word', () => {
    const ranges = changedRanges('Größe der Datei', 'Größen der Datei')!
    expect(marked('Größen der Datei', ranges.b)).toEqual(['Größen'])
  })

  it('marks nothing where lines are the same, too long, or changed whole', () => {
    expect(changedRanges('same', 'same')).toBeNull()
    expect(changedRanges('x'.repeat(MAX_WORD_DIFF_CHARS + 1), 'y')).toBeNull()
    expect(changedRanges('import { a } from "b"', 'export default 42')).toBeNull()
  })
})

describe('splitByRanges', () => {
  it('parts the text into marked and unmarked pieces, cut where the text ends', () => {
    expect(splitByRanges('abcdef', [[1, 3]])).toEqual([
      { text: 'a', changed: false },
      { text: 'bc', changed: true },
      { text: 'def', changed: false },
    ])
    // The shown text was cut: a range beyond it ends with it.
    expect(splitByRanges('abc', [[2, 10]])).toEqual([
      { text: 'ab', changed: false },
      { text: 'c', changed: true },
    ])
  })
})
