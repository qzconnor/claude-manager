import type { DiffLine } from './file-diff'

/**
 * A line of a diff by its number, which stays while lines above it come and go less often than its
 * place in the list does: a removed line by its number in the old file, the others by theirs in the new.
 */
export interface LinePoint {
  side: 'old' | 'new'
  line: number
}

/** Where a comment points in the file as it is now; only removed lines: where they were before. */
export interface LineRef {
  start: number
  end: number
  removed: { start: number; end: number } | null
}

/** A comment on lines of a file's changes, kept until it goes to Claude. */
export interface ReviewComment {
  id: string
  /** The folder of the changes, and the file in it (`/`-separated). */
  root: string
  path: string
  /** The first and the last line it is on. */
  from: LinePoint
  to: LinePoint
  ref: LineRef
  text: string
}

export function pointOf(line: DiffLine | undefined): LinePoint | null {
  if (!line || line.kind === 'hunk') return null
  if (line.kind === 'del') return line.old === null ? null : { side: 'old', line: line.old }
  return line.new === null ? null : { side: 'new', line: line.new }
}

export const samePoint = (a: LinePoint, b: LinePoint) => a.side === b.side && a.line === b.line

/** The index of the line at `point`; -1 when it is gone. */
export function indexOfPoint(lines: readonly DiffLine[], point: LinePoint): number {
  return lines.findIndex((line) => {
    const at = pointOf(line)
    return !!at && samePoint(at, point)
  })
}

/**
 * The lines from `a` to `b` (indices, either order) without a section's head at either end; null
 * when none is left (only heads).
 */
export function spanOf(lines: readonly DiffLine[], a: number, b: number): { first: number; last: number } | null {
  let first = Math.max(0, Math.min(a, b))
  let last = Math.min(lines.length - 1, Math.max(a, b))
  while (first <= last && !pointOf(lines[first])) first++
  while (last >= first && !pointOf(lines[last])) last--
  return first <= last ? { first, last } : null
}

/** The span of a comment in the lines shown; null when its first or last line is gone. */
export function spanOfComment(lines: readonly DiffLine[], comment: Pick<ReviewComment, 'from' | 'to'>) {
  const first = indexOfPoint(lines, comment.from)
  const last = first < 0 ? -1 : indexOfPoint(lines, comment.to)
  return first < 0 || last < first ? null : { first, last }
}

const inNew = (line: DiffLine) => (line.kind === 'context' || line.kind === 'add') && line.new !== null

/**
 * Where the lines `first`..`last` are in the file as it is now. Only removed lines aren't there: the
 * line now in their place (the one after them, at the end the last one), and where they were.
 */
export function lineRefOf(lines: readonly DiffLine[], first: number, last: number): LineRef | null {
  const span = lines.slice(first, last + 1)
  const now = span.filter(inNew).map((line) => line.new!)
  if (now.length) return { start: Math.min(...now), end: Math.max(...now), removed: null }
  const old = span.flatMap((line) => (line.kind === 'del' && line.old !== null ? [line.old] : []))
  if (!old.length) return null
  const place = lines.slice(last + 1).find(inNew)?.new ?? lines.slice(0, first).findLast(inNew)?.new ?? 1
  return { start: place, end: place, removed: { start: Math.min(...old), end: Math.max(...old) } }
}

/** „Zeile 12“ or „Zeilen 12–18“. */
const linesLabel = ({ start, end }: { start: number; end: number }) => (start === end ? `Zeile ${start}` : `Zeilen ${start}–${end}`)

/** „Zeilen 12–18“, removed lines as „Entfernte Zeilen 5–7“ (where they were). */
export function refLabel(ref: LineRef): string {
  return ref.removed ? `Entfernte ${linesLabel(ref.removed)}` : linesLabel(ref)
}

/**
 * The lines as Claude Code reads them in a prompt: `@path#L12-18`, in quotes where the path has a
 * space (`@"a b.ts#L3"`), the place of removed lines with where they were.
 */
export function mentionOf(path: string, ref: LineRef): string {
  const target = `${path}#L${ref.start}${ref.end === ref.start ? '' : `-${ref.end}`}`
  const mention = /\s/.test(target) ? `@"${target}"` : `@${target}`
  return ref.removed ? `${mention} (entfernt, vorher ${linesLabel(ref.removed)})` : mention
}

/** The comments in the order of their files and lines. */
export function sortComments(comments: readonly ReviewComment[]): ReviewComment[] {
  return [...comments].sort((a, b) => a.path.localeCompare(b.path) || a.ref.start - b.ref.start || a.ref.end - b.ref.end)
}

/** The comments as a prompt for Claude: each one's lines, then what it says. */
export function reviewPrompt(comments: readonly ReviewComment[]): string {
  const parts = sortComments(comments).map((c) => `${mentionOf(c.path, c.ref)}\n${c.text.trim()}`)
  return `Kommentare zu den Änderungen:\n\n${parts.join('\n\n')}\n`
}
