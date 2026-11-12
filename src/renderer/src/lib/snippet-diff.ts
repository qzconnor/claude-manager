import { parsePatch, type ParsedDiff } from './file-diff'

/** Longest comparison (lines × lines) worked out line by line; beyond it, all old lines go and all new ones come. */
const MAX_CELLS = 250_000

const linesOf = (text: string) => (text === '' ? [] : text.split(/\r?\n/))

/**
 * The change from `before` to `after`, two parts of a file such as `old_string` and `new_string` of an
 * Edit, as a unified patch with one section. Where lines were replaced, the removed ones come before the
 * added ones, as git writes them: the diff marks the words that changed between them.
 */
export function snippetPatch(before: string, after: string): string {
  const a = linesOf(before)
  const b = linesOf(after)
  const out = [`@@ -1,${a.length} +1,${b.length} @@`]
  let head = 0
  while (head < a.length && head < b.length && a[head] === b[head]) head++
  let tail = 0
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++
  for (const line of a.slice(0, head)) out.push(` ${line}`)

  const oldMid = a.slice(head, a.length - tail)
  const newMid = b.slice(head, b.length - tail)
  let removed: string[] = []
  let added: string[] = []
  const flush = () => {
    for (const line of removed) out.push(`-${line}`)
    for (const line of added) out.push(`+${line}`)
    removed = []
    added = []
  }
  if (oldMid.length * newMid.length > MAX_CELLS) {
    removed = oldMid
    added = newMid
  } else {
    // The longest run of lines both have (LCS), counted from the end, then walked from the start.
    const n = oldMid.length
    const m = newMid.length
    const width = m + 1
    const common = new Uint32Array((n + 1) * width)
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        common[i * width + j] =
          oldMid[i] === newMid[j] ? common[(i + 1) * width + j + 1]! + 1 : Math.max(common[(i + 1) * width + j]!, common[i * width + j + 1]!)
      }
    }
    let i = 0
    let j = 0
    while (i < n || j < m) {
      if (i < n && j < m && oldMid[i] === newMid[j]) {
        flush()
        out.push(` ${oldMid[i]}`)
        i++
        j++
      } else if (j >= m || (i < n && common[(i + 1) * width + j]! >= common[i * width + j + 1]!)) {
        removed.push(oldMid[i++]!)
      } else {
        added.push(newMid[j++]!)
      }
    }
  }
  flush()
  for (const line of a.slice(a.length - tail)) out.push(` ${line}`)
  return out.join('\n')
}

/** The change from `before` to `after` as lines of a diff, without the head of its section. */
export function snippetDiff(before: string, after: string): ParsedDiff {
  const parsed = parsePatch(snippetPatch(before, after))
  return { ...parsed, lines: parsed.lines.filter((line) => line.kind !== 'hunk') }
}
