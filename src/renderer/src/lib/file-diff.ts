import type { FileDiff, GitFileStatus } from '@shared/types'
import { changedRanges, type Range } from './word-diff'

/** A line of a diff as it is shown: unchanged, added, removed, or the head of a hunk. */
export interface DiffLine {
  kind: 'context' | 'add' | 'del' | 'hunk'
  text: string
  /** Its number in the old and in the new file; null where it has none (added, removed, hunk). */
  old: number | null
  new: number | null
  /**
   * How a removed or added line ends where only that changed (the text is the same as its counterpart's):
   * shown at its end, else the change can't be seen.
   */
  eol?: 'crlf' | 'lf'
}

export interface ParsedDiff {
  lines: DiffLine[]
  added: number
  removed: number
  /** That lines changed only their line ending, e.g. „Nur Zeilenenden geändert (CRLF → LF)“. */
  eol?: string
}

const HUNK_RE = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@ ?(.*)$/

/**
 * The lines of a text as git counts them: only `\n` ends one, a `\r` before it belongs to the line
 * break (CRLF), one anywhere else to the line (a progress bar's output, an old Mac file).
 */
function textLines(text: string): string[] {
  const rows = text.split('\n').map((row) => (row.endsWith('\r') ? row.slice(0, -1) : row))
  // A text ending with a line break would get an empty last line.
  if (text.endsWith('\n')) rows.pop()
  return text === '' ? [] : rows
}

/**
 * The lines of a unified diff of one file (`git diff`), hunk by hunk. The header before the first
 * hunk (`diff --git`, `index`, `---`, `+++`) and `\ No newline at end of file` are left out.
 */
export function parsePatch(patch: string): ParsedDiff {
  const lines: DiffLine[] = []
  /** Whether each line ended with CR LF, for the changes of line endings. */
  const crlf: boolean[] = []
  let added = 0
  let removed = 0
  let old = 0
  let cur = 0
  let inHunk = false
  const rows = patch.split('\n')
  if (patch.endsWith('\n')) rows.pop()
  for (const row of patch === '' ? [] : rows) {
    const cr = row.endsWith('\r')
    const line = cr ? row.slice(0, -1) : row
    crlf[lines.length] = cr
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
  const eol = markLineEndings(lines, crlf, added + removed)
  return eol ? { lines, added, removed, eol } : { lines, added, removed }
}

/** Each removed line and the added one at its place in the change, both ways (see `markLineEndings`). */
const partners = new WeakMap<DiffLine, DiffLine>()
/** The words that changed in a line, once worked out (see `wordMarks`). */
const marks = new WeakMap<DiffLine, readonly Range[]>()

/**
 * The parts of a removed or added line that changed against the line in its place on the other side,
 * word by word; empty when there is none to compare with or nothing to mark. Worked out when the line
 * is first drawn, for both lines at once.
 */
export function wordMarks(line: DiffLine): readonly Range[] {
  const known = marks.get(line)
  if (known) return known
  const partner = partners.get(line)
  const ranges = partner && line.kind === 'del' ? changedRanges(line.text, partner.text) : partner ? changedRanges(partner.text, line.text) : null
  const [mine, theirs] = !ranges ? [[], []] : line.kind === 'del' ? [ranges.a, ranges.b] : [ranges.b, ranges.a]
  marks.set(line, mine)
  if (partner) marks.set(partner, theirs)
  return mine
}

/**
 * Pairs each removed line with the added one at its place in the change, as git writes them, for the
 * words that changed (`wordMarks`). Marks the pairs that differ only in their line ending (`eol`):
 * without the marks, a file whose line endings changed (CRLF ↔ LF) shows lines removed and added
 * again as they were.
 *
 * @returns The note for the head of the diff; undefined when no line changed only its ending.
 */
function markLineEndings(lines: DiffLine[], crlf: boolean[], changed: number): string | undefined {
  let pairs = 0
  const directions = new Set<string>()
  for (let i = 0; i < lines.length; ) {
    if (lines[i]!.kind !== 'del' && lines[i]!.kind !== 'add') {
      i++
      continue
    }
    const dels: number[] = []
    const adds: number[] = []
    for (; i < lines.length && lines[i]!.kind === 'del'; i++) dels.push(i)
    for (; i < lines.length && lines[i]!.kind === 'add'; i++) adds.push(i)
    for (let k = 0; k < Math.min(dels.length, adds.length); k++) {
      const del = dels[k]!
      const add = adds[k]!
      partners.set(lines[del]!, lines[add]!)
      partners.set(lines[add]!, lines[del]!)
      if (lines[del]!.text !== lines[add]!.text || crlf[del] === crlf[add]) continue
      lines[del]!.eol = crlf[del] ? 'crlf' : 'lf'
      lines[add]!.eol = crlf[add] ? 'crlf' : 'lf'
      directions.add(crlf[del] ? 'CRLF → LF' : 'LF → CRLF')
      pairs++
    }
  }
  if (pairs === 0) return undefined
  const direction = directions.size === 1 ? [...directions][0]! : 'CRLF ↔ LF'
  if (pairs * 2 === changed) return `Nur Zeilenenden geändert (${direction})`
  return `Zeilenenden in ${pairs} ${pairs === 1 ? 'Zeile' : 'Zeilen'} geändert (${direction})`
}

/** A whole file as lines of a diff: unchanged (`context`), or all added for a file git doesn't know yet. */
export function fileLines(text: string, kind: 'context' | 'add'): ParsedDiff {
  const lines = textLines(text).map<DiffLine>((line, i) => ({ kind, text: line, old: kind === 'context' ? i + 1 : null, new: i + 1 }))
  return { lines, added: kind === 'add' ? lines.length : 0, removed: 0 }
}

/** Columns a line takes with tabs `tabSize` wide, for the width of the widest one. */
export function lineColumns(text: string, tabSize: number): number {
  let columns = 0
  for (const ch of text) columns = ch === '\t' ? columns + tabSize - (columns % tabSize) : columns + 1
  return columns
}

/** How wide a tab is in a diff (columns). */
export const DIFF_TAB_SIZE = 4
/** Longer lines are cut, so one minified line doesn't make the view thousands of screens wide. */
export const MAX_DIFF_COLUMNS = 2000

/**
 * What a file's diff shows: its changes; the whole file as added (git doesn't know it yet), as it is
 * (no changes, or outside a repository); or why there is nothing to show.
 */
export type DiffMode = 'diff' | 'new' | 'unchanged' | 'plain' | 'image' | 'binary' | 'tooLarge' | 'missing'

/** What a diff shows, with `status` the file's state in git. */
export function diffMode(diff: FileDiff, status: GitFileStatus | null | undefined): DiffMode {
  if (diff.tooLarge) return 'tooLarge'
  if (diff.image?.before || diff.image?.after) return 'image'
  if (diff.binary) return 'binary'
  // Without a hunk only the name or the mode changed: the file shows as it is.
  if (/^@@ /m.test(diff.patch)) return 'diff'
  if (diff.missing || diff.text === null) return 'missing'
  if (!diff.repo) return 'plain'
  return status === 'untracked' || status === 'added' ? 'new' : 'unchanged'
}

/**
 * Why a file whose content is the same as at the last commit still counts as changed: `git mv`
 * renamed it, or `chmod` made it executable or not (the head of its patch says so); null for neither.
 */
export function unchangedNote(patch: string | null | undefined): string | null {
  const parts: string[] = []
  if (patch && /^rename from /m.test(patch)) parts.push('umbenannt')
  const mode = patch ? /^new mode (\d+)/m.exec(patch) : null
  if (mode) parts.push(mode[1] === '100755' ? 'jetzt ausführbar' : 'nicht mehr ausführbar')
  if (parts.length === 0) return null
  const text = parts.join(' und ')
  return `${text[0]!.toUpperCase()}${text.slice(1)}, Inhalt unverändert`
}

const NO_LINES: ParsedDiff = { lines: [], added: 0, removed: 0 }

/** The lines a diff shows in its mode; none for a file that can't be shown. */
export function diffLines(diff: FileDiff, mode: DiffMode): ParsedDiff {
  if (mode === 'diff') return parsePatch(diff.patch)
  if (diff.text !== null && (mode === 'new' || mode === 'unchanged' || mode === 'plain')) {
    return fileLines(diff.text, mode === 'new' ? 'add' : 'context')
  }
  return NO_LINES
}

/** Wrapped, a long line (a paragraph of Markdown) shows whole; only one beyond this (minified code) is cut. */
export const MAX_WRAPPED_COLUMNS = 20000

/** A line's text as it is shown: cut after `max` characters. */
export function shownText(text: string, max = MAX_DIFF_COLUMNS): string {
  return text.length > max ? `${text.slice(0, max)} …` : text
}

/**
 * Rows a line takes wrapped at `width` columns, as the view wraps it: anywhere, spaces and tabs too
 * (`break-spaces`, `line-break: anywhere`), a tab up to its next stop in its row.
 */
export function wrappedRows(text: string, width: number, tabSize = DIFF_TAB_SIZE): number {
  if (width < 1 || (text.length <= width && !text.includes('\t'))) return 1
  let rows = 1
  let column = 0
  for (const ch of text) {
    let w = ch === '\t' ? tabSize - (column % tabSize) : 1
    if (column > 0 && column + w > width) {
      rows++
      column = 0
      if (ch === '\t') w = tabSize
    }
    column += w
  }
  return rows
}

/**
 * Where each line of a diff starts, in rows, wrapped at `width` columns; the last entry is the rows
 * of all of them.
 */
export function wrapOffsets(lines: readonly DiffLine[], width: number): Uint32Array {
  const offsets = new Uint32Array(lines.length + 1)
  for (let i = 0; i < lines.length; i++) offsets[i + 1] = offsets[i]! + wrappedRows(shownText(lines[i]!.text, MAX_WRAPPED_COLUMNS), width)
  return offsets
}

/** The line that row `row` belongs to, for offsets from `wrapOffsets` (the last line beyond the end). */
export function lineAtRow(offsets: Uint32Array, row: number): number {
  const last = offsets.length - 2
  if (last < 0) return 0
  let low = 0
  let high = last
  while (low < high) {
    const mid = (low + high + 1) >> 1
    if (offsets[mid]! <= row) low = mid
    else high = mid - 1
  }
  return low
}

/**
 * A row of the changes side by side: the line of the old file on the left and the one of the new file
 * on the right, by their index in the diff's lines; null where a side has none (more lines removed than
 * added there, or the other way round). An unchanged line and a section's head stand on both sides.
 */
export interface SplitRow {
  left: number | null
  right: number | null
}

/**
 * The lines of a diff side by side: each run of removed lines beside the added ones that follow it,
 * line by line as git wrote them (the pairs whose changed words `wordMarks` marks).
 */
export function sideBySide(lines: readonly DiffLine[]): SplitRow[] {
  const rows: SplitRow[] = []
  for (let i = 0; i < lines.length; ) {
    const kind = lines[i]!.kind
    if (kind === 'context' || kind === 'hunk') {
      rows.push({ left: i, right: i })
      i++
      continue
    }
    const dels: number[] = []
    const adds: number[] = []
    for (; i < lines.length && lines[i]!.kind === 'del'; i++) dels.push(i)
    for (; i < lines.length && lines[i]!.kind === 'add'; i++) adds.push(i)
    for (let k = 0; k < Math.max(dels.length, adds.length); k++) rows.push({ left: dels[k] ?? null, right: adds[k] ?? null })
  }
  return rows
}

/** Whether a row side by side is a section's head, drawn across both sides. */
export function isHeadRow(row: SplitRow, lines: readonly DiffLine[]): boolean {
  return row.left !== null && lines[row.left]!.kind === 'hunk'
}

/**
 * Where each row side by side starts, in rows, both sides wrapped at `width` columns: a row takes as
 * many as its longer side, a section's head one (it doesn't wrap). The last entry is the rows of all of them.
 */
export function splitOffsets(rows: readonly SplitRow[], lines: readonly DiffLine[], width: number): Uint32Array {
  const offsets = new Uint32Array(rows.length + 1)
  const rowsOf = (index: number | null) => (index === null ? 1 : wrappedRows(shownText(lines[index]!.text, MAX_WRAPPED_COLUMNS), width))
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!
    const taken = isHeadRow(row, lines) ? 1 : row.left === row.right ? rowsOf(row.left) : Math.max(rowsOf(row.left), rowsOf(row.right))
    offsets[i + 1] = offsets[i]! + taken
  }
  return offsets
}

/** The widest line of a diff (columns), at most `MAX_DIFF_COLUMNS`. */
export function diffColumns(lines: readonly DiffLine[]): number {
  let most = 0
  for (const line of lines) most = Math.max(most, lineColumns(line.text, DIFF_TAB_SIZE))
  return Math.min(most, MAX_DIFF_COLUMNS)
}

/** Digits of the highest line number of a diff, for the width of its numbers. */
export function numberDigits(lines: readonly DiffLine[]): number {
  let most = 1
  for (const line of lines) most = Math.max(most, line.old ?? 0, line.new ?? 0)
  return String(most).length
}

/** Whether a file was looked at while reviewing the changes: yes, not yet, or it changed since. */
export type SeenState = 'yes' | 'no' | 'changed'

/** Whether two answers for a file say the same: asked again, it hasn't changed. */
export function sameDiff(a: FileDiff, b: FileDiff): boolean {
  return (
    a.patch === b.patch &&
    a.text === b.text &&
    a.repo === b.repo &&
    a.binary === b.binary &&
    a.tooLarge === b.tooLarge &&
    a.missing === b.missing &&
    a.image?.before === b.image?.before &&
    a.image?.after === b.image?.after
  )
}

/**
 * An image's data URL for the fingerprint: its length and every so many of its characters. A binary
 * file's patch is the same whatever changed in it, and megabytes needn't be hashed whole.
 */
function sample(url: string | null | undefined): string {
  if (!url) return ''
  const step = Math.max(1, Math.floor(url.length / 4096))
  let picked = `${url.length}:`
  for (let i = 0; i < url.length; i += step) picked += url[i]
  return picked
}

/** A short fingerprint of a diff (FNV-1a), to tell whether a file changed since it was looked at. */
export function diffHash(diff: FileDiff): string {
  const source = `${diff.patch}\0${diff.text ?? ''}\0${diff.missing}\0${sample(diff.image?.before)}\0${sample(diff.image?.after)}`
  let hash = 0x811c9dc5
  for (let i = 0; i < source.length; i++) {
    hash ^= source.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return `${source.length}:${(hash >>> 0).toString(36)}`
}
