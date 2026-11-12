/**
 * Line diffs of two versions of a file, as `git diff` shows them: Myers' algorithm on the lines, sections
 * (hunks) with three lines of context, in a change removed lines before the added ones.
 */

/** Edits beyond this many are not worked out line by line: the changed part is all removed and all added. */
const MAX_EDITS = 2000
/** Unchanged lines around each change. */
const CONTEXT = 3

/**
 * The lines of a text as git counts them: only `\n` ends one (a `\r` before it stays with the line, so a
 * change of line ending is a change), a text ending with a line break has no empty last line.
 */
export function textLines(text: string): string[] {
  if (text === '') return []
  const rows = text.split('\n')
  if (text.endsWith('\n')) rows.pop()
  return rows
}

/** What happens to a line: kept, removed from the old version, added in the new one. */
type Op = 0 | 1 | 2
const KEEP = 0
const DEL = 1
const ADD = 2

/**
 * The shortest edit script of `a` to `b` (Myers), or null beyond `MAX_EDITS`. Where it can choose it
 * removes before it adds, so a change shows its removed lines first, as git writes them.
 */
function myers(a: Int32Array, b: Int32Array): Op[] | null {
  const n = a.length
  const m = b.length
  const max = Math.min(n + m, MAX_EDITS)
  const offset = max + 1
  const v = new Int32Array(2 * max + 3)
  const trace: Int32Array[] = []
  for (let d = 0; d <= max; d++) {
    trace.push(v.slice(offset - d - 1, offset + d + 2))
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[offset + k - 1]! < v[offset + k + 1]!) ? v[offset + k + 1]! : v[offset + k - 1]! + 1
      let y = x - k
      while (x < n && y < m && a[x] === b[y]) {
        x++
        y++
      }
      v[offset + k] = x
      if (x >= n && y >= m) return backtrack(trace, n, m)
    }
  }
  return null
}

/** Walks the saved fronts back from the end to the start, keeping, removing and adding lines. */
function backtrack(trace: Int32Array[], n: number, m: number): Op[] {
  const ops: Op[] = []
  let x = n
  let y = m
  for (let d = trace.length - 1; d >= 0; d--) {
    const front = trace[d]!
    // `front` holds the diagonals -d-1 … d+1 of the step before this one.
    const at = (k: number) => front[k + d + 1]!
    const k = x - y
    const fromBelow = k === -d || (k !== d && at(k - 1) < at(k + 1))
    const prevK = fromBelow ? k + 1 : k - 1
    const prevX = d === 0 ? 0 : at(prevK)
    const prevY = prevX - prevK
    while (x > prevX && y > prevY) {
      ops.push(KEEP)
      x--
      y--
    }
    if (d > 0) ops.push(fromBelow ? ADD : DEL)
    x = prevX
    y = prevY
  }
  return ops.reverse()
}

interface Script {
  a: string[]
  b: string[]
  ops: Op[]
}

/** The edit script from `before` to `after`, common start and end trimmed off first. */
function script(before: string, after: string): Script {
  const a = textLines(before)
  const b = textLines(after)
  let head = 0
  while (head < a.length && head < b.length && a[head] === b[head]) head++
  let tail = 0
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++

  // Lines as numbers, compared faster than strings.
  const ids = new Map<string, number>()
  const id = (line: string) => {
    let n = ids.get(line)
    if (n === undefined) ids.set(line, (n = ids.size))
    return n
  }
  const midA = Int32Array.from(a.slice(head, a.length - tail), id)
  const midB = Int32Array.from(b.slice(head, b.length - tail), id)
  const mid = myers(midA, midB) ?? [...Array<Op>(midA.length).fill(DEL), ...Array<Op>(midB.length).fill(ADD)]
  const ops: Op[] = [...Array<Op>(head).fill(KEEP), ...mid, ...Array<Op>(tail).fill(KEEP)]
  return { a, b, ops }
}

/** How many lines `after` adds to and removes from `before`. */
export function diffCounts(before: string, after: string): { added: number; removed: number } {
  if (before === after) return { added: 0, removed: 0 }
  let added = 0
  let removed = 0
  for (const op of script(before, after).ops) {
    if (op === ADD) added++
    else if (op === DEL) removed++
  }
  return { added, removed }
}

/** A line of the script with its number on both sides (counted from 0). */
interface Step {
  op: Op
  a: number
  b: number
}

/**
 * The change from `before` to `after` as a unified diff without file header, one section per group of
 * changes with `CONTEXT` lines around it. Empty when the lines are the same.
 */
export function unifiedPatch(before: string, after: string): string {
  if (before === after) return ''
  const { a, b, ops } = script(before, after)
  const steps: Step[] = []
  let ia = 0
  let ib = 0
  for (const op of ops) {
    steps.push({ op, a: ia, b: ib })
    if (op !== ADD) ia++
    if (op !== DEL) ib++
  }

  const out: string[] = []
  let i = 0
  while (i < steps.length) {
    while (i < steps.length && steps[i]!.op === KEEP) i++
    if (i >= steps.length) break
    const start = Math.max(0, i - CONTEXT)
    // The section goes on while the next change is at most two contexts away.
    let end = i
    for (;;) {
      while (end < steps.length && steps[end]!.op !== KEEP) end++
      let next = end
      while (next < steps.length && steps[next]!.op === KEEP) next++
      if (next < steps.length && next - end <= 2 * CONTEXT) end = next
      else break
    }
    const stop = Math.min(steps.length, end + CONTEXT)
    const part = steps.slice(start, stop)
    const oldCount = part.filter((s) => s.op !== ADD).length
    const newCount = part.filter((s) => s.op !== DEL).length
    // As git counts: a side without lines starts at the line before.
    const oldStart = oldCount ? part.find((s) => s.op !== ADD)!.a + 1 : part[0]!.a
    const newStart = newCount ? part.find((s) => s.op !== DEL)!.b + 1 : part[0]!.b
    out.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`)
    for (const s of part) {
      if (s.op === KEEP) out.push(` ${a[s.a]}`)
      else if (s.op === DEL) out.push(`-${a[s.a]}`)
      else out.push(`+${b[s.b]}`)
    }
    i = stop
  }
  return out.join('\n')
}
