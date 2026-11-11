import { describe, expect, it } from 'vitest'
import type { FileDiff } from '@shared/types'
import {
  diffColumns,
  diffHash,
  diffLines,
  diffMode,
  fileLines,
  lineAtRow,
  lineColumns,
  MAX_DIFF_COLUMNS,
  numberDigits,
  parsePatch,
  shownText,
  unchangedNote,
  wrapOffsets,
  wrappedRows,
  type DiffLine,
} from './file-diff'

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

  it('keeps a lone carriage return in its line, as git does', () => {
    const { lines } = parsePatch('@@ -1,2 +1,2 @@\n-50%\r100%\n+done\n same\n')
    expect(lines.slice(1)).toEqual([
      { kind: 'del', text: '50%\r100%', old: 1, new: null },
      { kind: 'add', text: 'done', old: null, new: 1 },
      { kind: 'context', text: 'same', old: 2, new: 2 },
    ])
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
    expect(fileLines('a\rb\n', 'context').lines.map((l) => l.text)).toEqual(['a\rb'])
  })
})

describe('lineColumns', () => {
  it('counts tabs up to the next stop', () => {
    expect(lineColumns('ab', 4)).toBe(2)
    expect(lineColumns('\tx', 4)).toBe(5)
    expect(lineColumns('ab\tx', 4)).toBe(5)
  })
})

const diff = (over: Partial<FileDiff>): FileDiff => ({ patch: '', text: null, repo: true, binary: false, tooLarge: false, missing: false, ...over })

describe('diffMode', () => {
  it('tells what a file shows', () => {
    expect(diffMode(diff({ patch: PATCH }), 'modified')).toBe('diff')
    expect(diffMode(diff({ text: 'x' }), 'untracked')).toBe('new')
    expect(diffMode(diff({ text: 'x' }), 'added')).toBe('new')
    expect(diffMode(diff({ text: 'x' }), null)).toBe('unchanged')
    expect(diffMode(diff({ text: 'x', repo: false }), null)).toBe('plain')
    expect(diffMode(diff({ missing: true }), 'deleted')).toBe('missing')
    expect(diffMode(diff({ binary: true, patch: PATCH }), 'modified')).toBe('binary')
    expect(diffMode(diff({ tooLarge: true, binary: true }), 'modified')).toBe('tooLarge')
  })

  it('shows a file only renamed or made executable as it is, and says why', () => {
    const renamed = 'diff --git a/a.ts b/b.ts\nsimilarity index 100%\nrename from a.ts\nrename to b.ts\n'
    const chmod = 'diff --git a/run.sh b/run.sh\nold mode 100644\nnew mode 100755\n'
    expect(diffMode(diff({ patch: renamed, text: 'x' }), 'renamed')).toBe('unchanged')
    expect(diffMode(diff({ patch: chmod, text: 'x' }), 'modified')).toBe('unchanged')
    expect(unchangedNote(renamed)).toBe('Umbenannt, Inhalt unverändert')
    expect(unchangedNote(chmod)).toBe('Jetzt ausführbar, Inhalt unverändert')
    expect(unchangedNote(`${renamed.replace('100%', '100%\nold mode 100755\nnew mode 100644')}`)).toBe(
      'Umbenannt und nicht mehr ausführbar, Inhalt unverändert',
    )
    expect(unchangedNote('')).toBeNull()
    expect(unchangedNote(PATCH)).toBeNull()
  })

  it('gives the lines of each mode', () => {
    expect(diffLines(diff({ patch: PATCH }), 'diff')).toMatchObject({ added: 3, removed: 2 })
    expect(diffLines(diff({ text: 'a\nb\n' }), 'new')).toMatchObject({ added: 2, removed: 0 })
    expect(diffLines(diff({ text: 'a\nb\n' }), 'unchanged').lines.map((l) => l.kind)).toEqual(['context', 'context'])
    expect(diffLines(diff({ binary: true }), 'binary').lines).toEqual([])
  })

  it('measures the widest line and the highest number', () => {
    const { lines } = diffLines(diff({ patch: PATCH }), 'diff')
    expect(numberDigits(lines)).toBe(2)
    expect(diffColumns(lines)).toBe(Math.max(...lines.map((l) => l.text.length)))
    expect(diffColumns([{ kind: 'add', text: 'x'.repeat(MAX_DIFF_COLUMNS * 2), old: null, new: 1 }])).toBe(MAX_DIFF_COLUMNS)
    expect(numberDigits([])).toBe(1)
  })
})

describe('diffHash', () => {
  it('is the same for the same changes and differs once they change', () => {
    expect(diffHash(diff({ patch: PATCH }))).toBe(diffHash(diff({ patch: PATCH })))
    expect(diffHash(diff({ patch: PATCH }))).not.toBe(diffHash(diff({ patch: PATCH.replace('TWO', 'Two') })))
    expect(diffHash(diff({ text: 'a' }))).not.toBe(diffHash(diff({ patch: 'a' })))
    expect(diffHash(diff({ missing: true }))).not.toBe(diffHash(diff({})))
  })
})

describe('wrapping', () => {
  it('counts the rows a line takes', () => {
    expect(wrappedRows('', 10)).toBe(1)
    expect(wrappedRows('abcdefghij', 10)).toBe(1)
    expect(wrappedRows('abcdefghijk', 10)).toBe(2)
    expect(wrappedRows('a'.repeat(25), 10)).toBe(3)
    expect(wrappedRows('a'.repeat(25), 0)).toBe(1)
  })

  it('takes tabs up to their stop, a whole one at the start of a row', () => {
    // Tab to 4, then 6 letters: 10 columns.
    expect(wrappedRows('\tabcdef', 10)).toBe(1)
    expect(wrappedRows('\tabcdefg', 10)).toBe(2)
    // 9 letters, then a tab that doesn't fit: it starts the next row.
    expect(wrappedRows('abcdefghi\tx', 10)).toBe(2)
  })

  it('cuts very long lines as they are shown', () => {
    expect(shownText('x')).toBe('x')
    expect(shownText('x'.repeat(MAX_DIFF_COLUMNS + 5))).toHaveLength(MAX_DIFF_COLUMNS + 2)
  })

  it('finds the line of a row', () => {
    const line = (text: string): DiffLine => ({ kind: 'context', text, old: 1, new: 1 })
    const offsets = wrapOffsets([line('short'), line('a'.repeat(25)), line('')], 10)
    expect([...offsets]).toEqual([0, 1, 4, 5])
    expect([0, 1, 2, 3, 4, 9].map((row) => lineAtRow(offsets, row))).toEqual([0, 1, 1, 1, 2, 2])
    expect(lineAtRow(new Uint32Array([0]), 3)).toBe(0)
  })
})
