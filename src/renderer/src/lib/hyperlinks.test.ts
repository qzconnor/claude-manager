import type { IBuffer, IBufferLine } from '@xterm/xterm'
import { describe, expect, it } from 'vitest'
import { linkText, showsTarget } from './hyperlinks'

function buffer(rows: string[]): IBuffer {
  return {
    getLine: (y: number) =>
      rows[y] === undefined
        ? undefined
        : ({ translateToString: (_trim: boolean, start = 0, end?: number) => rows[y]!.slice(start, end) } as IBufferLine),
  } as IBuffer
}

describe('showsTarget', () => {
  it('holds for a link that shows its URL, with or without https://', () => {
    expect(showsTarget('https://example.com/docs', 'https://example.com/docs')).toBe(true)
    expect(showsTarget('example.com/docs', 'https://example.com/docs/')).toBe(true)
    expect(showsTarget(' Example.com ', 'http://example.com')).toBe(true)
  })

  it('fails for a link whose text is something else, or only part of the URL', () => {
    expect(showsTarget('Dokumentation', 'https://example.com/docs')).toBe(false)
    expect(showsTarget('https://example.com', 'https://evil.test/?https://example.com')).toBe(false)
    expect(showsTarget('example.com', 'https://example.com.evil.test')).toBe(false)
    expect(showsTarget('', 'https://example.com')).toBe(false)
  })
})

describe('linkText', () => {
  it('reads the columns of the link, the end included', () => {
    // "Siehe [Doku] hier": the link covers columns 7 to 10 (1-based).
    expect(linkText(buffer(['Siehe Doku hier']), { start: { x: 7, y: 1 }, end: { x: 10, y: 1 } })).toBe('Doku')
  })

  it('reads across rows', () => {
    const rows = ['xx https://exa', 'mple.com yy']
    expect(linkText(buffer(rows), { start: { x: 4, y: 1 }, end: { x: 8, y: 2 } })).toBe('https://example.com')
  })
})
