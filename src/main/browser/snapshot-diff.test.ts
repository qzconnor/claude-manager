import { describe, expect, it } from 'vitest'
import { CHANGES_HEAD, diffLines, NO_CHANGES, snapshotChanges } from './snapshot-diff'

const page = (...body: string[]) =>
  ['- Page URL: http://localhost:5173/', '- Page title: Todos', '- Scroll: 0 of 0 px down (viewport 800×600)', ...body].join('\n')

/** A long list, so a small change is a small share of the page. */
const items = (count: number) => Array.from({ length: count }, (_, i) => `    - listitem [ref=e${100 + i}]: Item ${i}`)

describe('diffLines', () => {
  it('keeps equal lines and marks the rest', () => {
    const ops = diffLines(['a', 'b', 'c'], ['a', 'x', 'c'])
    expect(ops).toEqual([
      { kind: 'keep', line: 'a' },
      { kind: 'remove', line: 'b' },
      { kind: 'add', line: 'x' },
      { kind: 'keep', line: 'c' },
    ])
  })

  it('handles lines that only came or only went', () => {
    expect(diffLines([], ['a'])).toEqual([{ kind: 'add', line: 'a' }])
    expect(diffLines(['a'], [])).toEqual([{ kind: 'remove', line: 'a' }])
  })

  it('gives up on middles too large to compare', () => {
    const a = Array.from({ length: 3000 }, (_, i) => `a${i}`)
    const b = Array.from({ length: 3000 }, (_, i) => `b${i}`)
    expect(diffLines(a, b)).toBeNull()
  })
})

describe('snapshotChanges', () => {
  it('says so when nothing changed', () => {
    const text = page('- button "Save" [ref=e1]')
    expect(snapshotChanges(text, text)).toBe(NO_CHANGES)
  })

  it('shows a new line with the outline lines it sits in', () => {
    const before = page('- main', '  - list "Todos" [ref=e10]', ...items(30), '- contentinfo')
    const after = page('- main', '  - list "Todos" [ref=e10]', ...items(30), '    - listitem [ref=e55]: Buy milk', '- contentinfo')
    expect(snapshotChanges(before, after)).toBe(`${CHANGES_HEAD}\n  - main\n    - list "Todos" [ref=e10]\n+     - listitem [ref=e55]: Buy milk`)
  })

  it('shows a changed state as the old line going and the new one coming', () => {
    const before = page('- form', '  - checkbox "Done" [ref=e3] [unchecked]', ...items(30))
    const after = page('- form', '  - checkbox "Done" [ref=e3] [checked]', ...items(30))
    expect(snapshotChanges(before, after)).toBe(
      `${CHANGES_HEAD}\n  - form\n-   - checkbox "Done" [ref=e3] [unchecked]\n+   - checkbox "Done" [ref=e3] [checked]`,
    )
  })

  it('names the scroll position when only that changed', () => {
    const before = page(...items(30))
    const after = before.replace('Scroll: 0 of 0', 'Scroll: 300 of 900')
    const changes = snapshotChanges(before, after)!
    expect(changes).toContain('+ - Scroll: 300 of 900')
    expect(changes).toContain('- - Scroll: 0 of 0')
    expect(changes).not.toContain('listitem')
  })

  it('gives the whole snapshot when most of the page changed', () => {
    const before = page('- main', ...items(10))
    const after = page('- main', ...items(10).map((line) => `${line} [selected]`))
    expect(snapshotChanges(before, after)).toBeNull()
  })
})
