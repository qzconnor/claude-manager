import { describe, expect, it } from 'vitest'
import { ligatureRanges } from './ligatures'

/** The joined sequences of `text`. */
const joined = (text: string) => ligatureRanges(text).map(([start, end]) => text.slice(start, end))

describe('ligatureRanges', () => {
  it('finds the sequences with their offsets', () => {
    expect(ligatureRanges('(a) => b')).toEqual([[4, 6]])
    expect(joined('a != b && c >= d || e -> f')).toEqual(['!=', '>=', '->'])
  })

  it('prefers the longest sequence at a place', () => {
    expect(joined('a === b')).toEqual(['==='])
    expect(joined('a !== b')).toEqual(['!=='])
    expect(joined('<!-- x -->')).toEqual(['<!--', '-->'])
    expect(joined('std::vector')).toEqual(['::'])
  })

  it('finds sequences right next to each other', () => {
    expect(joined('<></>')).toEqual(['<>', '</>'])
  })

  it('leaves out sequences that go on with the same character', () => {
    expect(joined('=============== tests ===============')).toEqual([])
    expect(joined('------>')).toEqual([])
    expect(joined('a ==== b')).toEqual([])
    expect(joined('/** doc */')).toEqual(['*/'])
    expect(joined('ls src/**/*.ts')).toEqual(['/*'])
  })

  it('finds nothing in plain text', () => {
    expect(ligatureRanges('')).toEqual([])
    expect(ligatureRanges('=')).toEqual([])
    expect(ligatureRanges('Hello, world!')).toEqual([])
  })
})
