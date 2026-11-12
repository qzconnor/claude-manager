import { describe, expect, it } from 'vitest'
import { searchTerms } from '@shared/utils'
import { containsTerms, highlightParts, matchSpans, searchText, type TextPart } from './search'

describe('searchText', () => {
  it('joins the present fields in lower case', () => {
    expect(searchText('My Session', null, undefined, '', 'C:\\Projects\\App')).toBe('my session\nc:\\projects\\app')
  })

  it('is empty without fields', () => {
    expect(searchText()).toBe('')
    expect(searchText(null, undefined)).toBe('')
  })
})

describe('containsTerms', () => {
  const text = searchText('Fix the Login Bug', 'claude-manager')

  it('needs every term', () => {
    expect(containsTerms(text, searchTerms('login BUG'))).toBe(true)
    expect(containsTerms(text, searchTerms('login crash'))).toBe(false)
  })

  it('matches parts of words', () => {
    expect(containsTerms(text, ['log', 'manag'])).toBe(true)
  })

  it('does not match across two fields', () => {
    expect(containsTerms(text, ['bug\nclaude'])).toBe(true)
    expect(containsTerms(text, searchTerms('bugclaude'))).toBe(false)
  })

  it('matches anything without terms', () => {
    expect(containsTerms(text, [])).toBe(true)
  })

  it('ignores accents in the text and in the terms, like the command palette', () => {
    expect(containsTerms(searchText('Ordner öffnen'), searchTerms('offnen'))).toBe(true)
    expect(containsTerms(searchText('Datei offnen'), searchTerms('ÖFFNEN'))).toBe(true)
    expect(containsTerms(searchText('Café Crème'), searchTerms('cafe creme'))).toBe(true)
    // An umlaut written as o and a combining diaeresis, as macOS names files.
    expect(containsTerms(searchText('Öffnen'), searchTerms('öffnen'))).toBe(true)
    // ß is a letter of its own, not an ss with an accent.
    expect(containsTerms(searchText('Browser schliessen'), searchTerms('schließen'))).toBe(false)
  })
})

describe('highlightParts', () => {
  const joined = (parts: TextPart[]) => parts.map((p) => p.text).join('')

  it('returns the whole text unmarked without terms', () => {
    expect(highlightParts('Hello World', [])).toEqual([{ text: 'Hello World', match: false }])
  })

  it('marks matches case-insensitively and keeps the original case', () => {
    const parts = highlightParts('Hello World', searchTerms('WORLD'))
    expect(parts).toEqual([
      { text: 'Hello ', match: false },
      { text: 'World', match: true },
    ])
  })

  it('marks every occurrence of a term', () => {
    expect(highlightParts('a-b-a', ['a'])).toEqual([
      { text: 'a', match: true },
      { text: '-b-', match: false },
      { text: 'a', match: true },
    ])
  })

  it('merges overlapping and adjacent matches of different terms', () => {
    expect(highlightParts('abcdefg', ['abc', 'cde', 'f'])).toEqual([
      { text: 'abcdef', match: true },
      { text: 'g', match: false },
    ])
  })

  it('returns one unmarked part when nothing matches', () => {
    expect(highlightParts('Hello', ['xyz'])).toEqual([{ text: 'Hello', match: false }])
  })

  it('marks matches whatever their accents, in the original spelling', () => {
    expect(highlightParts('Ordner öffnen', searchTerms('offnen'))).toEqual([
      { text: 'Ordner ', match: false },
      { text: 'öffnen', match: true },
    ])
  })

  it('keeps positions right after a dotted capital I', () => {
    expect(highlightParts('İstanbul Reise', ['ist', 'reise'])).toEqual([
      { text: 'İst', match: true },
      { text: 'anbul ', match: false },
      { text: 'Reise', match: true },
    ])
  })

  it('always adds up to the original text', () => {
    const text = 'Ärger mit ÄRGER und ärger'
    const parts = highlightParts(text, searchTerms('ärger und'))
    expect(joined(parts)).toBe(text)
    expect(parts.filter((p) => p.match).map((p) => p.text)).toEqual(['Ärger', 'ÄRGER', 'und', 'ärger'])
  })
})

describe('matchSpans', () => {
  it('finds a term case-insensitively', () => {
    expect(matchSpans('Developer: Reload Window', searchTerms('reloa'))).toEqual([[11, 16]])
  })

  it('finds every term and every occurrence, merging what touches', () => {
    expect(matchSpans('a-b-a', ['a'])).toEqual([
      [0, 1],
      [4, 5],
    ])
    expect(matchSpans('abcdefg', ['abc', 'cde', 'f'])).toEqual([[0, 6]])
  })

  it('ignores accents, in the text and in the terms', () => {
    expect(matchSpans('Ordner öffnen', ['offnen'])).toEqual([[7, 13]])
    expect(matchSpans('Browser schliessen', ['schließen'])).toEqual([])
    expect(matchSpans('Datei offnen', ['öffnen'])).toEqual([[6, 12]])
  })

  it('finds nothing without terms or matches', () => {
    expect(matchSpans('Neue Session', [])).toEqual([])
    expect(matchSpans('Neue Session', ['xyz'])).toEqual([])
    expect(matchSpans('', ['a'])).toEqual([])
  })
})
