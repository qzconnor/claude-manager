import { describe, expect, it } from 'vitest'
import { parsePatch } from './file-diff'
import { highlightDiff, languageOf, loadLanguage, splitHighlighted } from './syntax'

describe('languageOf', () => {
  it('knows files by extension and by name', () => {
    expect(languageOf('src/App.vue')).toBe('xml')
    expect(languageOf('src/a.test.TS')).toBe('typescript')
    expect(languageOf('Dockerfile')).toBe('dockerfile')
    expect(languageOf('deploy/api.dockerfile')).toBe('dockerfile')
    expect(languageOf('.env.local')).toBe('ini')
    expect(languageOf('LICENSE')).toBeNull()
    expect(languageOf('notes.unknown')).toBeNull()
  })
})

describe('splitHighlighted', () => {
  it('closes spans at a line end and opens them again on the next line', () => {
    const html = 'a<span class="c">/* one\ntwo */</span> b\n<span class="k">x</span>'
    expect(splitHighlighted(html)).toEqual([
      'a<span class="c">/* one</span>',
      '<span class="c">two */</span> b',
      '<span class="k">x</span>',
    ])
  })

  it('keeps nested spans and empty lines', () => {
    expect(splitHighlighted('<span class="a"><span class="b">x\n\ny</span></span>')).toEqual([
      '<span class="a"><span class="b">x</span></span>',
      '<span class="a"><span class="b"></span></span>',
      '<span class="a"><span class="b">y</span></span>',
    ])
  })
})

describe('highlightDiff', () => {
  it('highlights the old and the new side, each line on its own', async () => {
    expect(await loadLanguage('typescript')).toBe(true)
    const { lines } = parsePatch(['@@ -1,2 +1,2 @@', ' const a = 1', "-const b = '<old>'", "+const b = '<new>'"].join('\n'))
    const html = highlightDiff(lines, 'typescript')!
    expect(html[0]).toBeNull()
    expect(html[1]).toContain('hljs-keyword')
    // Escaped by highlight.js, so it can go into the page as HTML.
    expect(html[2]).toContain('&lt;old&gt;')
    expect(html[3]).toContain('&lt;new&gt;')
    expect(html[2]).toContain('hljs-string')
  })

  it('leaves out languages that are not loaded', () => {
    expect(highlightDiff(parsePatch('@@ -1 +1 @@\n-a\n+b').lines, 'cobol')).toBeNull()
  })
})
