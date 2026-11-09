import type { IBuffer, IBufferCell, IBufferLine, ILink, Terminal } from '@xterm/xterm'
import { describe, expect, it, vi } from 'vitest'
import { findUrls, urlLinks } from './url-links'

const COLS = 70
const URL = 'https://github.com/xConnorTV/claude-manager/compare/master...feature/nur-aenderungen-syntaxfarben?expand=1'

/** A row of `COLS` columns; `wrapped` when xterm wrapped the row before into it. */
function line(text: string, wrapped = false): IBufferLine {
  return {
    isWrapped: wrapped,
    length: COLS,
    translateToString: () => text,
    getCell: (x: number) =>
      x < COLS ? ({ getChars: () => text[x] ?? '', getWidth: () => 1 } as unknown as IBufferCell) : undefined,
  } as unknown as IBufferLine
}

/** Rows as Claude Code writes them; `↵` at the start marks a row xterm wrapped into. */
function buffer(...rows: string[]): IBuffer {
  const lines = rows.map((row) => (row.startsWith('↵') ? line(row.slice(1), true) : line(row)))
  return { type: 'normal', length: lines.length, getLine: (y: number) => lines[y] } as unknown as IBuffer
}

const urls = (rows: IBuffer, y: number) => findUrls(rows, COLS, y).map(({ url }) => url)

describe('findUrls', () => {
  it('joins a URL that Claude Code cut at the edge, from each of its rows', () => {
    const rows = buffer(
      '● Hier ist der Link: https://github.com/xConnorTV/claude-manager/compa',
      '  re/master...feature/nur-aenderungen-syntaxfarben?expand=1&title=Ein+',
      '  sehr+langer+Titel+fuer+den+Test',
    )
    const url = 'https://github.com/xConnorTV/claude-manager/compare/master...feature/nur-aenderungen-syntaxfarben?expand=1&title=Ein+sehr+langer+Titel+fuer+den+Test'
    for (const y of [0, 1, 2]) {
      expect(findUrls(rows, COLS, y)).toEqual([
        {
          url,
          parts: [
            { y: 0, start: 21, end: 69 },
            { y: 1, start: 2, end: 69 },
            { y: 2, start: 2, end: 32 },
          ],
        },
      ])
    }
  })

  it('joins the output of a tool, cut five columns before the edge', () => {
    const rows = buffer(
      '  ⎿  https://github.com/xConnorTV/claude-manager/compare/master..',
      '     .feature/nur-aenderungen-syntaxfarben?expand=1',
    )
    expect(urls(rows, 1)).toEqual([URL])
  })

  it('joins the prompt, cut one column before the edge', () => {
    const rows = buffer(
      '❯ Prompt mit Link https://github.com/xConnorTV/claude-manager/compare ',
      '  /master...feature/nur-aenderungen-syntaxfarben?expand=1             ',
    )
    expect(urls(rows, 0)).toEqual([URL])
  })

  it('looks past the gutter of a quote and ends the URL where text follows', () => {
    expect(
      urls(
        buffer(
          '  ▎ Zitat https://github.com/xConnorTV/claude-manager/compare/master..',
          '  ▎ .feature/nur-aenderungen-syntaxfarben?expand=1',
        ),
        1,
      ),
    ).toEqual([URL])
    expect(
      urls(
        buffer(
          '  Inline https://github.com/xConnorTV/claude-manager/compare/master...',
          '  feature/nur-aenderungen-syntaxfarben?expand=1 Code. https://a.de/b',
        ),
        1,
      ),
    ).toEqual([URL, 'https://a.de/b'])
  })

  it('keeps apart a URL and the word Claude Code wrapped after it', () => {
    // At the edge, but the URL and `und` would have fit into the row: Claude Code didn't cut there.
    const atEdge = buffer('● Siehe https://example.com/' + 'a'.repeat(42), '  und weiter geht es hier.')
    expect(urls(atEdge, 0)).toEqual(['https://example.com/' + 'a'.repeat(42)])
    expect(urls(atEdge, 1)).toEqual([])
    // Tools wrap a word with a space in front.
    const tool = buffer('  ⎿  Siehe https://example.com/' + 'c'.repeat(34), '      und weiter geht es mit Text.')
    expect(urls(tool, 0)).toEqual(['https://example.com/' + 'c'.repeat(34)])
    // Not at an edge Claude Code cuts at.
    const before = buffer('  Siehe https://example.com/' + 'b'.repeat(38), '  kaputtgegangen ist das nicht.')
    expect(urls(before, 0)).toEqual(['https://example.com/' + 'b'.repeat(38)])
  })

  it('joins only where the URL runs to the end of the row', () => {
    const rows = buffer('  Siehe (https://example.com/x) und noch viel mehr Text bis zum Rand a', '  cd')
    expect(urls(rows, 0)).toEqual(['https://example.com/x'])
  })

  it('follows rows xterm wrapped, like the web links addon', () => {
    const rows = buffer('Visit https://example.com/' + 'a'.repeat(44), '↵' + 'a'.repeat(56) + ' end')
    expect(findUrls(rows, COLS, 1)).toEqual([
      {
        url: 'https://example.com/' + 'a'.repeat(100),
        parts: [
          { y: 0, start: 6, end: 69 },
          { y: 1, start: 0, end: 55 },
        ],
      },
    ])
  })

  it('leaves out punctuation at the end and what isn\'t a URL', () => {
    expect(urls(buffer('Siehe (https://example.com/a), https://example.com/b. und http://'), 0)).toEqual([
      'https://example.com/a',
      'https://example.com/b',
    ])
  })
})

describe('urlLinks', () => {
  function terminal(rows: IBuffer) {
    const decorations: { x: number; width: number; line: number }[] = []
    const term = {
      cols: COLS,
      options: { theme: { foreground: '#fff' } },
      buffer: { active: Object.assign(rows, { baseY: 0, cursorY: 2 }) },
      registerMarker: (offset: number) => ({ line: 2 + offset, dispose: vi.fn() }),
      registerDecoration: (options: { marker: { line: number }; x: number; width: number }) => {
        const decoration = { x: options.x, width: options.width, line: options.marker.line }
        decorations.push(decoration)
        return { onRender: vi.fn(), dispose: () => decorations.splice(decorations.indexOf(decoration), 1) }
      },
    } as unknown as Terminal
    return { term, decorations }
  }

  const rows = () =>
    buffer(
      '  ⎿  https://github.com/xConnorTV/claude-manager/compare/master..',
      '     .feature/nur-aenderungen-syntaxfarben?expand=1',
    )

  function links(term: Terminal, y: number): ILink[] | undefined {
    let found: ILink[] | undefined
    urlLinks(term, { open: vi.fn() }).provideLinks(y, (links) => (found = links))
    return found
  }

  it('links the part in the row with the whole URL', () => {
    const open = vi.fn()
    const { term } = terminal(rows())
    let found: ILink[] | undefined
    urlLinks(term, { open }).provideLinks(2, (links) => (found = links))
    expect(found?.map((link) => [link.text, link.range])).toEqual([[URL, { start: { x: 6, y: 2 }, end: { x: 51, y: 2 } }]])
    const event = { preventDefault: vi.fn() } as unknown as MouseEvent
    found![0]!.activate(event, URL)
    expect(open).toHaveBeenCalledWith(URL)
    expect(event.preventDefault).toHaveBeenCalled()
  })

  it('underlines every row of the URL while the mouse is on it', () => {
    const { term, decorations } = terminal(rows())
    const [link] = links(term, 1)!
    link!.hover!({} as MouseEvent, URL)
    expect(decorations).toEqual([
      { line: 0, x: 5, width: 60 },
      { line: 1, x: 5, width: 46 },
    ])
    link!.leave!({} as MouseEvent, URL)
    expect(decorations).toEqual([])
  })

  it('answers nothing for a row without a URL', () => {
    expect(links(terminal(buffer('nur Text')).term, 1)).toBeUndefined()
  })
})
