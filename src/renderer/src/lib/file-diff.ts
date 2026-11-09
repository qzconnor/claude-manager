/** A line of a diff as it is shown: unchanged, added, removed, or the head of a hunk. */
export interface DiffLine {
  kind: 'context' | 'add' | 'del' | 'hunk'
  text: string
  /** Its number in the old and in the new file; null where it has none (added, removed, hunk). */
  old: number | null
  new: number | null
}

export interface ParsedDiff {
  lines: DiffLine[]
  added: number
  removed: number
}

const HUNK_RE = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@ ?(.*)$/

/**
 * The lines of a unified diff of one file (`git diff`), hunk by hunk. The header before the first
 * hunk (`diff --git`, `index`, `---`, `+++`) and `\ No newline at end of file` are left out.
 */
export function parsePatch(patch: string): ParsedDiff {
  const lines: DiffLine[] = []
  let added = 0
  let removed = 0
  let old = 0
  let cur = 0
  let inHunk = false
  const source = patch.replace(/\r\n?/g, '\n')
  // The patch ends with a newline, which would make an empty last line.
  const all = source.endsWith('\n') ? source.slice(0, -1).split('\n') : source.split('\n')
  for (const line of all) {
    const head = HUNK_RE.exec(line)
    if (head) {
      old = Number(head[1])
      cur = Number(head[2])
      inHunk = true
      lines.push({ kind: 'hunk', text: head[3] ?? '', old: null, new: null })
      continue
    }
    if (!inHunk || line.startsWith('\\')) continue
    const sign = line[0]
    const text = line.slice(1)
    if (sign === '+') {
      lines.push({ kind: 'add', text, old: null, new: cur++ })
      added++
    } else if (sign === '-') {
      lines.push({ kind: 'del', text, old: old++, new: null })
      removed++
    } else if (sign === ' ' || line === '') {
      lines.push({ kind: 'context', text, old: old++, new: cur++ })
    } else {
      // The next file's header (only one file is asked for, but to be safe).
      inHunk = false
    }
  }
  return { lines, added, removed }
}

/** A whole file as lines of a diff: unchanged (`context`), or all added for a file git doesn't know yet. */
export function fileLines(text: string, kind: 'context' | 'add'): ParsedDiff {
  const source = text.replace(/\r\n?/g, '\n')
  const rows = source.endsWith('\n') ? source.slice(0, -1).split('\n') : source.split('\n')
  if (source === '') rows.length = 0
  const lines = rows.map<DiffLine>((line, i) => ({ kind, text: line, old: kind === 'context' ? i + 1 : null, new: i + 1 }))
  return { lines, added: kind === 'add' ? lines.length : 0, removed: 0 }
}

/** Columns a line takes with tabs `tabSize` wide, for the width of the widest one. */
export function lineColumns(text: string, tabSize: number): number {
  let columns = 0
  for (const ch of text) columns = ch === '\t' ? columns + tabSize - (columns % tabSize) : columns + 1
  return columns
}
