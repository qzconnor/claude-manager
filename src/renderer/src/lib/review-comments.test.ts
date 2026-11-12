import { describe, expect, it } from 'vitest'
import type { DiffLine } from './file-diff'
import {
  indexOfPoint,
  lineRefOf,
  mentionOf,
  pointOf,
  refLabel,
  reviewPrompt,
  sortComments,
  spanOf,
  spanOfComment,
  type ReviewComment,
} from './review-comments'

const hunk = (text = '@@ -10,5 +10,6 @@'): DiffLine => ({ kind: 'hunk', text, old: null, new: null })
const ctx = (old: number, now: number, text = 'x'): DiffLine => ({ kind: 'context', text, old, new: now })
const del = (old: number, text = 'old'): DiffLine => ({ kind: 'del', text, old, new: null })
const add = (now: number, text = 'new'): DiffLine => ({ kind: 'add', text, old: null, new: now })

// 0 head, 1 ctx 10, 2 del 11, 3 del 12, 4 add 11, 5 add 12, 6 add 13, 7 ctx 13/14, 8 head, 9 ctx 40/41, 10 del 41
const LINES: DiffLine[] = [hunk(), ctx(10, 10), del(11), del(12), add(11), add(12), add(13), ctx(13, 14), hunk('@@ -40,2 +41,1 @@'), ctx(40, 41), del(41)]

const comment = (over: Partial<ReviewComment>): ReviewComment => ({
  id: 'c',
  root: 'C:\\repo',
  path: 'src/a.ts',
  from: { side: 'new', line: 1 },
  to: { side: 'new', line: 1 },
  ref: { start: 1, end: 1, removed: null },
  text: 'Text',
  ...over,
})

describe('pointOf', () => {
  it('names a removed line by its old number, the others by their new one, a head not at all', () => {
    expect(pointOf(LINES[2])).toEqual({ side: 'old', line: 11 })
    expect(pointOf(LINES[4])).toEqual({ side: 'new', line: 11 })
    expect(pointOf(LINES[7])).toEqual({ side: 'new', line: 14 })
    expect(pointOf(LINES[0])).toBeNull()
    expect(pointOf(undefined)).toBeNull()
  })

  it('finds a line again by its number, also after lines above it moved', () => {
    expect(indexOfPoint(LINES, { side: 'old', line: 12 })).toBe(3)
    expect(indexOfPoint(LINES, { side: 'new', line: 12 })).toBe(5)
    expect(indexOfPoint([hunk(), ...LINES], { side: 'new', line: 12 })).toBe(6)
    expect(indexOfPoint(LINES, { side: 'new', line: 99 })).toBe(-1)
  })
})

describe('spanOf', () => {
  it('orders the ends and leaves out heads at them', () => {
    expect(spanOf(LINES, 5, 2)).toEqual({ first: 2, last: 5 })
    expect(spanOf(LINES, 0, 1)).toEqual({ first: 1, last: 1 })
    expect(spanOf(LINES, 7, 9)).toEqual({ first: 7, last: 9 })
    expect(spanOf(LINES, 7, 8)).toEqual({ first: 7, last: 7 })
    expect(spanOf(LINES, 8, 8)).toBeNull()
    expect(spanOf(LINES, -3, 99)).toEqual({ first: 1, last: 10 })
  })

  it('finds a comment again, or not when one of its ends is gone', () => {
    expect(spanOfComment(LINES, { from: { side: 'old', line: 11 }, to: { side: 'new', line: 12 } })).toEqual({ first: 2, last: 5 })
    expect(spanOfComment(LINES, { from: { side: 'new', line: 12 }, to: { side: 'old', line: 11 } })).toBeNull()
    expect(spanOfComment(LINES, { from: { side: 'new', line: 99 }, to: { side: 'new', line: 12 } })).toBeNull()
    expect(spanOfComment(LINES, { from: { side: 'new', line: 11 }, to: { side: 'new', line: 99 } })).toBeNull()
  })
})

describe('lineRefOf', () => {
  it('points to the lines of the file as it is now, removed ones between them included', () => {
    expect(lineRefOf(LINES, 1, 5)).toEqual({ start: 10, end: 12, removed: null })
    expect(lineRefOf(LINES, 4, 4)).toEqual({ start: 11, end: 11, removed: null })
    expect(lineRefOf(LINES, 6, 9)).toEqual({ start: 13, end: 41, removed: null })
  })

  it('points removed lines to the line now in their place and tells where they were', () => {
    expect(lineRefOf(LINES, 2, 3)).toEqual({ start: 11, end: 11, removed: { start: 11, end: 12 } })
    // At the end nothing follows: the last line before them.
    expect(lineRefOf(LINES, 10, 10)).toEqual({ start: 41, end: 41, removed: { start: 41, end: 41 } })
    expect(lineRefOf([hunk(), del(1), del(2)], 1, 2)).toEqual({ start: 1, end: 1, removed: { start: 1, end: 2 } })
  })

  it('has nothing to point to on heads alone', () => {
    expect(lineRefOf(LINES, 0, 0)).toBeNull()
    expect(lineRefOf(LINES, 8, 8)).toBeNull()
  })
})

describe('mentionOf', () => {
  it('writes the lines as Claude Code reads them', () => {
    expect(mentionOf('src/a.ts', { start: 12, end: 18, removed: null })).toBe('@src/a.ts#L12-18')
    expect(mentionOf('src/a.ts', { start: 3, end: 3, removed: null })).toBe('@src/a.ts#L3')
  })

  it('quotes a path with a space', () => {
    expect(mentionOf('docs/my notes.md', { start: 3, end: 4, removed: null })).toBe('@"docs/my notes.md#L3-4"')
  })

  it('tells where removed lines were', () => {
    expect(mentionOf('a.ts', { start: 11, end: 11, removed: { start: 11, end: 12 } })).toBe('@a.ts#L11 (entfernt, vorher Zeilen 11–12)')
    expect(mentionOf('a.ts', { start: 5, end: 5, removed: { start: 7, end: 7 } })).toBe('@a.ts#L5 (entfernt, vorher Zeile 7)')
  })
})

describe('refLabel', () => {
  it('names one line, several, and removed ones', () => {
    expect(refLabel({ start: 4, end: 4, removed: null })).toBe('Zeile 4')
    expect(refLabel({ start: 4, end: 9, removed: null })).toBe('Zeilen 4–9')
    expect(refLabel({ start: 4, end: 4, removed: { start: 2, end: 2 } })).toBe('Entfernte Zeile 2')
    expect(refLabel({ start: 4, end: 4, removed: { start: 2, end: 3 } })).toBe('Entfernte Zeilen 2–3')
  })
})

describe('reviewPrompt', () => {
  it('lists the comments by file and line, each with its lines', () => {
    const comments = [
      comment({ id: '1', path: 'src/b.ts', ref: { start: 3, end: 3, removed: null }, text: 'Warum?' }),
      comment({ id: '2', path: 'src/a.ts', ref: { start: 20, end: 22, removed: null }, text: '  Später.\nUnd so.  ' }),
      comment({ id: '3', path: 'src/a.ts', ref: { start: 4, end: 9, removed: null }, text: 'Zuerst.' }),
    ]
    expect(sortComments(comments).map((c) => c.id)).toEqual(['3', '2', '1'])
    expect(reviewPrompt(comments)).toBe(
      ['Kommentare zu den Änderungen:', '', '@src/a.ts#L4-9', 'Zuerst.', '', '@src/a.ts#L20-22', 'Später.\nUnd so.', '', '@src/b.ts#L3', 'Warum?', ''].join('\n'),
    )
  })

  it('orders comments on the same first line by their last', () => {
    const comments = [comment({ id: 'long', ref: { start: 4, end: 9, removed: null } }), comment({ id: 'short', ref: { start: 4, end: 5, removed: null } })]
    expect(sortComments(comments).map((c) => c.id)).toEqual(['short', 'long'])
  })
})
