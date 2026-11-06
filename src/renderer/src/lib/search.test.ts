import { describe, expect, it } from 'vitest'
import { searchTerms } from '@shared/utils'
import { containsTerms, highlightParts, searchText, type TextPart } from './search'

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
