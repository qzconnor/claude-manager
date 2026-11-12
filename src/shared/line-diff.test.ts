import { describe, expect, it } from 'vitest'
import { diffCounts, textLines, unifiedPatch } from './line-diff'

const text = (...lines: string[]) => lines.map((l) => `${l}\n`).join('')
const numbered = (n: number, from = 1) => Array.from({ length: n }, (_, i) => `line ${i + from}`)

/** Applies a patch of `unifiedPatch` to `before`, checking each kept and removed line on the way. */
function apply(before: string, patch: string): string[] {
  const a = textLines(before)
  const out: string[] = []
  let at = 0
  const rows = patch === '' ? [] : patch.split('\n')
  for (let i = 0; i < rows.length; ) {
    const head = /^@@ -(\d+),(\d+) \+(\d+),(\d+) @@$/.exec(rows[i]!)
    if (!head) throw new Error(`no head: ${rows[i]}`)
    const oldStart = Number(head[1])
    const oldCount = Number(head[2])
    const start = oldCount === 0 ? oldStart : oldStart - 1
    while (at < start) out.push(a[at++]!)
    i++
    while (i < rows.length && !rows[i]!.startsWith('@@')) {
      const row = rows[i++]!
      const line = row.slice(1)
      if (row[0] === '+') out.push(line)
      else {
        expect(a[at]).toBe(line)
        at++
        if (row[0] === ' ') out.push(line)
      }
    }
  }
  while (at < a.length) out.push(a[at++]!)
  return out
}

describe('textLines', () => {
  it('splits at line feeds, keeps a carriage return with its line and has no empty last line', () => {
    expect(textLines('')).toEqual([])
    expect(textLines('a')).toEqual(['a'])
    expect(textLines('a\n')).toEqual(['a'])
    expect(textLines('a\r\nb\n\n')).toEqual(['a\r', 'b', ''])
  })
})

describe('diffCounts', () => {
  it('counts added and removed lines, a changed one as both', () => {
    expect(diffCounts('', '')).toEqual({ added: 0, removed: 0 })
    expect(diffCounts(text('a', 'b'), text('a', 'b'))).toEqual({ added: 0, removed: 0 })
    expect(diffCounts('', text('a', 'b'))).toEqual({ added: 2, removed: 0 })
    expect(diffCounts(text('a', 'b', 'c'), text('a', 'B', 'c', 'd'))).toEqual({ added: 2, removed: 1 })
    // Only the line ending: changed, as git sees it.
    expect(diffCounts('a\r\nb\r\n', 'a\nb\r\n')).toEqual({ added: 1, removed: 1 })
  })

  it('finds the shortest way', () => {
    // Myers' own example: five edits.
    const { added, removed } = diffCounts(text(...'abcabba'), text(...'cbabac'))
    expect(added + removed).toBe(5)
    expect(diffCounts(text(...numbered(500)), text('new', ...numbered(250), 'mid', ...numbered(250, 251)))).toEqual({ added: 2, removed: 0 })
  })

  it('takes a part changed beyond measure as removed and added as a whole, quickly', () => {
    const lines = numbered(3000)
    const started = performance.now()
    // Reversed, the shortest way keeps one line; worked out it would take too long.
    expect(diffCounts(text(...lines), text(...[...lines].reverse()))).toEqual({ added: 3000, removed: 3000 })
    expect(performance.now() - started).toBeLessThan(3000)
    // The same start and end stay kept.
    expect(diffCounts(text('top', ...lines, 'end'), text('top', ...[...lines].reverse(), 'end'))).toEqual({ added: 3000, removed: 3000 })
  })
})

describe('unifiedPatch', () => {
  it('is empty without a change', () => {
    expect(unifiedPatch(text('a'), text('a'))).toBe('')
  })

  it('shows a change with three lines around it, the removed line before the added one', () => {
    const before = text(...numbered(20))
    const after = before.replace('line 10\n', 'line ten\nline 10b\n')
    expect(unifiedPatch(before, after)).toBe(
      ['@@ -7,7 +7,8 @@', ' line 7', ' line 8', ' line 9', '-line 10', '+line ten', '+line 10b', ' line 11', ' line 12', ' line 13'].join('\n'),
    )
  })

  it('puts the removed lines of a replacement before the added ones', () => {
    expect(unifiedPatch(text('a', 'b'), text('x', 'y'))).toBe('@@ -1,2 +1,2 @@\n-a\n-b\n+x\n+y')
  })

  it('makes one section of changes close together and two of those far apart', () => {
    const lines = numbered(40)
    const heads = (after: string[]) => unifiedPatch(text(...lines), text(...after)).split('\n').filter((l) => l.startsWith('@@'))
    // Six unchanged lines between them: their contexts meet.
    const close = [...lines]
    close[9] = 'x'
    close[16] = 'y'
    expect(heads(close)).toEqual(['@@ -7,14 +7,14 @@'])
    const far = [...lines]
    far[9] = 'x'
    far[17] = 'y'
    expect(heads(far)).toEqual(['@@ -7,7 +7,7 @@', '@@ -15,7 +15,7 @@'])
  })

  it('counts a side without lines from the line before, as git does', () => {
    expect(unifiedPatch('', text('a', 'b'))).toBe('@@ -0,0 +1,2 @@\n+a\n+b')
    expect(unifiedPatch(text('a', 'b'), '')).toBe('@@ -1,2 +0,0 @@\n-a\n-b')
    expect(unifiedPatch(text('a', 'b', 'c', 'd', 'e'), text('a', 'b', 'c', 'd', 'e', 'f'))).toBe('@@ -3,3 +3,4 @@\n c\n d\n e\n+f')
    expect(unifiedPatch(text(...numbered(8)), text('new', ...numbered(8)))).toBe('@@ -1,3 +1,4 @@\n+new\n line 1\n line 2\n line 3')
  })

  it('turns the old text into the new one, whatever was changed', () => {
    let seed = 7
    const random = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2147483648
      return seed % n
    }
    for (let round = 0; round < 200; round++) {
      const before = Array.from({ length: random(60) }, () => `l${random(8)}`)
      const after = [...before]
      for (let edits = random(12); edits > 0; edits--) {
        const at = random(after.length + 1)
        const kind = random(3)
        if (kind === 0) after.splice(at, 0, `n${random(8)}`)
        else if (kind === 1) after.splice(at, 1)
        else after.splice(at, 1, `c${random(8)}`)
      }
      const a = text(...before)
      const b = text(...after)
      expect(apply(a, unifiedPatch(a, b))).toEqual(after)
      const { added, removed } = diffCounts(a, b)
      const patch = unifiedPatch(a, b).split('\n')
      expect(patch.filter((l) => l.startsWith('+')).length).toBe(added)
      expect(patch.filter((l) => l.startsWith('-')).length).toBe(removed)
    }
  })
})
