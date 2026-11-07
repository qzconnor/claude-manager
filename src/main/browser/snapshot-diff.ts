/**
 * What changed between two snapshots of the same page, as a diff Claude reads after an action instead
 * of the whole outline again. Lines that came are marked `+`, lines that went `-`; the outline lines
 * above them (by indentation) come along unmarked, so Claude knows where in the page they are.
 */

/** A middle part (after the common start and end) larger than this many line pairs gets no diff. */
const MAX_DIFF_CELLS = 4_000_000
/** A diff with more lines than this share of the new snapshot is no help: the whole one is shorter to read. */
const MAX_DIFF_SHARE = 0.6

type Op = { kind: 'keep' | 'add' | 'remove'; line: string }

export const NO_CHANGES = 'The page did not change since your last snapshot.'
export const CHANGES_HEAD =
  'What changed on the page since your last snapshot (+ came, - went; the lines without a mark show where; everything else and its refs stay as they were):'

/**
 * The changes from `before` to `after` for Claude, or null when the whole snapshot serves better: too
 * many changes, or too large to compare.
 */
export function snapshotChanges(before: string, after: string): string | null {
  if (before === after) return NO_CHANGES
  const ops = diffLines(before.split('\n'), after.split('\n'))
  if (!ops) return null
  const shown = changedWithContext(ops)
  if (shown.length === 0) return NO_CHANGES
  const afterLines = ops.filter((op) => op.kind !== 'remove').length
  if (shown.length > Math.max(12, afterLines * MAX_DIFF_SHARE)) return null
  const body = shown.map((op) => `${op.kind === 'add' ? '+' : op.kind === 'remove' ? '-' : ' '} ${op.line}`)
  return `${CHANGES_HEAD}\n${body.join('\n')}`
}

/** The edit script from `a` to `b` (longest common subsequence), or null when it would cost too much. */
export function diffLines(a: string[], b: string[]): Op[] | null {
  let start = 0
  while (start < a.length && start < b.length && a[start] === b[start]) start++
  let endA = a.length
  let endB = b.length
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--
    endB--
  }
  const n = endA - start
  const m = endB - start
  if (n * m > MAX_DIFF_CELLS) return null

  // lengths[i][j]: LCS of a[start+i..endA) and b[start+j..endB), flat.
  const width = m + 1
  const lengths = n + 1 < 65_536 && m + 1 < 65_536 ? new Uint16Array((n + 1) * width) : new Uint32Array((n + 1) * width)
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lengths[i * width + j] =
        a[start + i] === b[start + j] ? lengths[(i + 1) * width + j + 1] + 1 : Math.max(lengths[(i + 1) * width + j], lengths[i * width + j + 1])
    }
  }

  const ops: Op[] = []
  for (let k = 0; k < start; k++) ops.push({ kind: 'keep', line: a[k] })
  let i = 0
  let j = 0
  while (i < n || j < m) {
    if (i < n && j < m && a[start + i] === b[start + j]) {
      ops.push({ kind: 'keep', line: a[start + i] })
      i++
      j++
    } else if (i < n && (j === m || lengths[(i + 1) * width + j] >= lengths[i * width + j + 1])) {
      // What went comes before what came, as in a diff.
      ops.push({ kind: 'remove', line: a[start + i] })
      i++
    } else {
      ops.push({ kind: 'add', line: b[start + j] })
      j++
    }
  }
  for (let k = endA; k < a.length; k++) ops.push({ kind: 'keep', line: a[k] })
  return ops
}

/** Leading spaces of an outline line: its depth. */
function indent(line: string): number {
  let count = 0
  while (count < line.length && line[count] === ' ') count++
  return count
}

/**
 * The added and removed lines, each with the unchanged outline lines it sits in (the nearest line
 * above with less indentation, and that one's, up to the top), every line once and in order.
 */
function changedWithContext(ops: Op[]): Op[] {
  const include = new Set<number>()
  for (let index = 0; index < ops.length; index++) {
    if (ops[index].kind === 'keep') continue
    include.add(index)
    let depth = indent(ops[index].line)
    for (let up = index - 1; up >= 0 && depth > 0; up--) {
      const op = ops[up]
      // Lines that went are no place in the page any more.
      if (op.kind === 'remove') continue
      const level = indent(op.line)
      if (level >= depth) continue
      if (op.kind === 'keep') include.add(up)
      depth = level
    }
  }
  return [...include].sort((x, y) => x - y).map((index) => ops[index])
}
