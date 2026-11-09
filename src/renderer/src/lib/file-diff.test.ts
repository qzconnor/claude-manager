import { describe, expect, it } from 'vitest'
import { fileLines, lineColumns, parsePatch } from './file-diff'

const PATCH = [
  'diff --git a/src/a.ts b/src/a.ts',
  'index 1111111..2222222 100644',
  '--- a/src/a.ts',
  '+++ b/src/a.ts',
  '@@ -1,4 +1,5 @@ export function a() {',
  ' one',
  '-two',
  '+TWO',
  '+three',
  ' four',
  '',
  '@@ -20,2 +21,2 @@',
  ' twenty',
  '-last',
  '\\ No newline at end of file',
  '+last',
  '',
].join('\n')

describe('parsePatch', () => {
  it('reads hunks with the numbers of both sides', () => {
    const { lines, added, removed } = parsePatch(PATCH)
    expect(added).toBe(3)
    expect(removed).toBe(2)
    expect(lines[0]).toEqual({ kind: 'hunk', text: 'export function a() {', old: null, new: null })
    expect(lines.slice(1, 7)).toEqual([
      { kind: 'context', text: 'one', old: 1, new: 1 },
      { kind: 'del', text: 'two', old: 2, new: null },
      { kind: 'add', text: 'TWO', old: null, new: 2 },
      { kind: 'add', text: 'three', old: null, new: 3 },
      { kind: 'context', text: 'four', old: 3, new: 4 },
      // An empty context line, as some tools write it without the leading space.
      { kind: 'context', text: '', old: 4, new: 5 },
    ])
    expect(lines.slice(7)).toEqual([
      { kind: 'hunk', text: '', old: null, new: null },
      { kind: 'context', text: 'twenty', old: 20, new: 21 },
      { kind: 'del', text: 'last', old: 21, new: null },
      { kind: 'add', text: 'last', old: null, new: 22 },
    ])
  })

  it('takes Windows line ends and an empty patch', () => {
    expect(parsePatch('@@ -1 +1 @@\r\n-a\r\n+b\r\n').lines.map((l) => l.text)).toEqual(['', 'a', 'b'])
    expect(parsePatch('')).toEqual({ lines: [], added: 0, removed: 0 })
  })
})

describe('fileLines', () => {
  it('numbers an unchanged file on both sides, a new one only on the new side', () => {
    expect(fileLines('a\nb\n', 'context').lines).toEqual([
      { kind: 'context', text: 'a', old: 1, new: 1 },
      { kind: 'context', text: 'b', old: 2, new: 2 },
    ])
    const fresh = fileLines('x\r\ny', 'add')
    expect(fresh.added).toBe(2)
    expect(fresh.lines[1]).toEqual({ kind: 'add', text: 'y', old: null, new: 2 })
    expect(fileLines('', 'context').lines).toEqual([])
  })
})

describe('lineColumns', () => {
  it('counts tabs up to the next stop', () => {
    expect(lineColumns('ab', 4)).toBe(2)
    expect(lineColumns('\tx', 4)).toBe(5)
    expect(lineColumns('ab\tx', 4)).toBe(5)
  })
})
