import { describe, expect, it } from 'vitest'
import { wordMarks } from './file-diff'
import { snippetDiff, snippetPatch } from './snippet-diff'

describe('snippetPatch', () => {
  it('keeps the lines both have and puts removed lines before added ones', () => {
    const before = 'const a = 1\nconst b = 2\nconst c = 3\nreturn a'
    const after = 'const a = 1\nconst b = 20\nconst d = 4\nconst c = 3\nreturn a'
    expect(snippetPatch(before, after)).toBe(
      ['@@ -1,4 +1,5 @@', ' const a = 1', '-const b = 2', '+const b = 20', '+const d = 4', ' const c = 3', ' return a'].join('\n'),
    )
  })

  it('finds lines that moved apart in the middle', () => {
    expect(snippetPatch('a\nb\nc\nd', 'a\nx\nc\ny\nd')).toBe(['@@ -1,4 +1,5 @@', ' a', '-b', '+x', ' c', '+y', ' d'].join('\n'))
  })

  it('takes an empty side as no lines, and Windows line ends as line ends', () => {
    expect(snippetPatch('', 'new\r\nline')).toBe(['@@ -1,0 +1,2 @@', '+new', '+line'].join('\n'))
    expect(snippetPatch('gone', '')).toBe(['@@ -1,1 +1,0 @@', '-gone'].join('\n'))
    expect(snippetPatch('same', 'same')).toBe(['@@ -1,1 +1,1 @@', ' same'].join('\n'))
  })

  it('replaces all lines at once when there are too many to compare', () => {
    const before = Array.from({ length: 600 }, (_, i) => `old ${i}`).join('\n')
    const after = Array.from({ length: 600 }, (_, i) => (i === 300 ? `old ${i}` : `new ${i}`)).join('\n')
    const lines = snippetPatch(before, after).split('\n')
    expect(lines.filter((l) => l.startsWith('-'))).toHaveLength(600)
    expect(lines.filter((l) => l.startsWith('+'))).toHaveLength(600)
  })
})

describe('snippetDiff', () => {
  it('gives the lines with their numbers in the snippet and marks the words that changed', () => {
    const diff = snippetDiff('a\nconst b = 2', 'a\nconst b = 20')
    expect(diff).toMatchObject({ added: 1, removed: 1 })
    expect(diff.lines.map((l) => [l.kind, l.text, l.old, l.new])).toEqual([
      ['context', 'a', 1, 1],
      ['del', 'const b = 2', 2, null],
      ['add', 'const b = 20', null, 2],
    ])
    expect(wordMarks(diff.lines[2]!)).toEqual([[10, 12]])
  })
})
