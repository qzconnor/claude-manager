/**
 * Claude Code's file history of a session, as `/rewind` uses it: at each prompt a snapshot of the files
 * Claude changed so far, each as a backup in `<configDir>/file-history/<session>/` (`<hash>@v<version>`,
 * none for a file that wasn't there). A file Claude first changes during a turn joins that turn's
 * snapshot with its state before the change (a `file-history-delta` line in newer versions).
 */
import { readFile, stat } from 'node:fs/promises'
import { join, posix, win32 } from 'node:path'
import type { FileChangeNote, SessionChanges, SessionChangeTexts, SessionFileChange, SessionTurnChanges } from '@shared/types'
import { diffCounts } from '@shared/line-diff'
import { cleanPrompt, textOf } from './transcript-parser'

export interface HistoryBackup {
  /** File in the session's history folder; null: the file wasn't there. */
  name: string | null
  version: number
  /** The folder the file is in, as newer versions note it. */
  dir: string | null
}

export interface Checkpoint {
  /** The prompt's message id. */
  id: string
  at: string | null
  /** The files as they were at the prompt, by the path Claude Code tracks them under. */
  files: Map<string, HistoryBackup>
}

export interface FileHistory {
  checkpoints: Checkpoint[]
  /** Every path the session tracked, in the order it first did. */
  tracked: string[]
  /** The prompt of each checkpoint. */
  prompts: Map<string, string>
}

/** A backup's file name: no way out of the history folder. */
const BACKUP_NAME_RE = /^[\w.@-]{1,200}$/
const HISTORY_PREFIX = Buffer.from('{"type":"file-history', 'latin1')
const NEWLINE = 0x0a
/** How far around a snapshot its prompt is looked for first (it is written right with it). */
const PROMPT_NEAR = 512 * 1024

function str(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function backupOf(value: unknown): HistoryBackup | null {
  if (!value || typeof value !== 'object') return null
  const b = value as Record<string, unknown>
  const name = b.backupFileName
  if (name !== null && (typeof name !== 'string' || !BACKUP_NAME_RE.test(name))) return null
  const version = typeof b.version === 'number' && Number.isFinite(b.version) ? b.version : 0
  return { name, version, dir: str(b.realParentDir) }
}

/** The line around `index`, as an entry. */
function entryAround(buf: Buffer, index: number): Record<string, unknown> | null {
  const start = buf.lastIndexOf(NEWLINE, index) + 1
  let end = buf.indexOf(NEWLINE, index)
  if (end === -1) end = buf.length
  try {
    const entry = JSON.parse(buf.toString('utf8', start, end)) as unknown
    return entry && typeof entry === 'object' ? (entry as Record<string, unknown>) : null
  } catch {
    return null
  }
}

/** The prompt with message id `id`, looked for near the snapshot at `near` first. */
function promptOf(buf: Buffer, id: string, near: number): string | null {
  const needle = Buffer.from(`"uuid":"${id}"`)
  const from = Math.max(0, near - PROMPT_NEAR)
  let index = buf.subarray(from, near + PROMPT_NEAR).indexOf(needle)
  index = index === -1 ? buf.indexOf(needle) : from + index
  if (index === -1) return null
  const entry = entryAround(buf, index)
  if (entry?.type !== 'user') return null
  const prompt = cleanPrompt(textOf((entry.message as { content?: unknown } | undefined)?.content))
  return prompt || null
}

/** Reads the file history of a transcript: its snapshots, the files added to them, and their prompts. */
export function readFileHistory(buf: Buffer): FileHistory {
  const checkpoints: Checkpoint[] = []
  const tracked = new Set<string>()
  const found: { id: string; at: number }[] = []
  let start = 0
  while (start < buf.length) {
    let end = buf.indexOf(NEWLINE, start)
    if (end === -1) end = buf.length
    if (end - start > HISTORY_PREFIX.length && buf.compare(HISTORY_PREFIX, 0, HISTORY_PREFIX.length, start, start + HISTORY_PREFIX.length) === 0) {
      let e: Record<string, unknown> | null = null
      try {
        e = JSON.parse(buf.toString('utf8', start, end)) as Record<string, unknown>
      } catch {
        // a line still being written
      }
      if (e?.type === 'file-history-snapshot') {
        const snapshot = e.snapshot as { trackedFileBackups?: unknown; timestamp?: unknown; messageId?: unknown } | undefined
        const id = str(e.messageId) ?? str(snapshot?.messageId)
        const backups = snapshot?.trackedFileBackups
        if (id && backups && typeof backups === 'object') {
          const files = new Map<string, HistoryBackup>()
          for (const [path, value] of Object.entries(backups as Record<string, unknown>)) {
            const backup = backupOf(value)
            if (!path || !backup) continue
            files.set(path, backup)
            tracked.add(path)
          }
          // An update replaces the snapshot of its prompt.
          const updated = e.isSnapshotUpdate ? checkpoints.findLast((c) => c.id === id) : undefined
          if (updated) {
            updated.files = files
          } else {
            checkpoints.push({ id, at: str(snapshot?.timestamp), files })
            found.push({ id, at: start })
          }
        }
      } else if (e?.type === 'file-history-delta') {
        const path = str(e.trackingPath)
        const backup = backupOf(e.backup)
        const target = checkpoints.findLast((c) => c.id === e.snapshotMessageId) ?? checkpoints.at(-1)
        if (path && backup && target && !target.files.has(path)) {
          target.files.set(path, backup)
          tracked.add(path)
        }
      }
    }
    start = end + 1
  }
  const prompts = new Map<string, string>()
  for (const { id, at } of found) {
    const prompt = promptOf(buf, id, at)
    if (prompt) prompts.set(id, prompt)
  }
  return { checkpoints, tracked: [...tracked], prompts }
}

/** The first backup of a file, from before Claude changed it: what `/rewind` restores where a snapshot doesn't know it. */
function firstVersion(history: FileHistory, path: string): HistoryBackup | undefined {
  for (const c of history.checkpoints) {
    const backup = c.files.get(path)
    if (backup?.version === 1) return backup
  }
  return undefined
}

/**
 * Where a tracked file is: newer versions note its real folder, else the path is absolute or relative to
 * the session's folder. Windows paths are joined as such also elsewhere (the tests).
 */
export function absolutePath(history: FileHistory, tracked: string, cwd: string | null): string | null {
  let dir: string | null = null
  for (const c of history.checkpoints) dir = c.files.get(tracked)?.dir ?? dir
  const p = /^[a-zA-Z]:[\\/]|^\\\\|\\/.test(dir ?? cwd ?? tracked) ? win32 : posix
  if (dir) return p.join(dir, p.basename(tracked))
  if (p.isAbsolute(tracked)) return p.normalize(tracked)
  return cwd ? p.join(cwd, tracked) : null
}

/** A version of a file: its bytes, not there, or not to be read. */
export type Version = { kind: 'text' | 'binary'; data: Buffer } | { kind: 'missing' | 'tooLarge' | 'unavailable' }

/** Versions bigger than this aren't compared. */
export const MAX_COMPARED_BYTES = 4 * 1024 * 1024

async function readVersion(path: string, gone: 'missing' | 'unavailable'): Promise<Version> {
  try {
    const info = await stat(path)
    if (!info.isFile()) return { kind: gone }
    if (info.size > MAX_COMPARED_BYTES) return { kind: 'tooLarge' }
    const data = await readFile(path)
    // As git decides: a NUL byte near the start makes it binary.
    return { kind: data.subarray(0, 8000).includes(0) ? 'binary' : 'text', data }
  } catch {
    return { kind: gone }
  }
}

/** Reads the versions of a session's files: its backups from `historyDir`, the files as they are now. */
export class VersionReader {
  private readonly backups = new Map<string, Promise<Version>>()

  constructor(private readonly historyDir: string) {}

  backup(backup: HistoryBackup): Promise<Version> {
    if (backup.name === null) return Promise.resolve({ kind: 'missing' })
    let version = this.backups.get(backup.name)
    if (!version) this.backups.set(backup.name, (version = readVersion(join(this.historyDir, backup.name), 'unavailable')))
    return version
  }

  current(path: string): Promise<Version> {
    return readVersion(path, 'missing')
  }
}

/** The change from `before` to `after`; null when there is none. */
export function changeOf(path: string, before: Version, after: Version): SessionFileChange | null {
  if (before.kind === 'missing' && after.kind === 'missing') return null
  const kind = before.kind === 'missing' ? 'added' : after.kind === 'missing' ? 'deleted' : 'modified'
  const bytes = (v: Version) => (v.kind === 'text' || v.kind === 'binary' ? v.data : v.kind === 'missing' ? Buffer.alloc(0) : null)
  const a = bytes(before)
  const b = bytes(after)
  if (kind === 'modified' && a && b && a.equals(b)) return null
  const note = [before, after].find((v) => v.kind !== 'text' && v.kind !== 'missing')?.kind as FileChangeNote | undefined
  if (note || !a || !b) return { path, kind, added: null, removed: null, note: note ?? 'unavailable' }
  const { added, removed } = diffCounts(a.toString('utf8'), b.toString('utf8'))
  return { path, kind, added, removed, note: null }
}

interface Pair {
  tracked: string
  before: HistoryBackup | 'current'
  after: HistoryBackup | 'current'
}

/**
 * The files of turn `index` to compare, as Claude Code does: each as it was at the prompt (or before
 * Claude first changed it) with it at the next prompt, for the latest one with it now. Backups that are
 * the same are left out right away.
 */
function turnPairs(history: FileHistory, index: number): Pair[] {
  const from = history.checkpoints[index]!
  const to = history.checkpoints[index + 1]
  const pairs: Pair[] = []
  for (const tracked of history.tracked) {
    const own = from.files.get(tracked)
    const next = to?.files.get(tracked)
    if (to && !own && !next) continue
    const before = own ?? firstVersion(history, tracked)
    if (!before) continue
    if (!to) {
      pairs.push({ tracked, before, after: 'current' })
      continue
    }
    const after = next ?? firstVersion(history, tracked)
    if (!after || after.name === before.name) continue
    pairs.push({ tracked, before, after })
  }
  return pairs
}

/** What `/rewind` to turn `index` would do: each file from now back to its state at that prompt. */
function rewindPairs(history: FileHistory, index: number): Pair[] {
  const at = history.checkpoints[index]!
  const pairs: Pair[] = []
  for (const tracked of history.tracked) {
    const target = at.files.get(tracked) ?? firstVersion(history, tracked)
    if (target) pairs.push({ tracked, before: 'current', after: target })
  }
  return pairs
}

async function compare(history: FileHistory, pairs: Pair[], reader: VersionReader, cwd: string | null): Promise<SessionFileChange[]> {
  const changes = await Promise.all(
    pairs.map(async (pair) => {
      const path = absolutePath(history, pair.tracked, cwd)
      if (!path) return null
      const version = (side: HistoryBackup | 'current') => (side === 'current' ? reader.current(path) : reader.backup(side))
      return changeOf(path, await version(pair.before), await version(pair.after))
    }),
  )
  return changes.filter((c): c is SessionFileChange => c !== null).sort((a, b) => a.path.localeCompare(b.path))
}

/** The changes of every turn of the session that changed files. */
export async function sessionChanges(history: FileHistory, reader: VersionReader, cwd: string | null): Promise<SessionChanges> {
  const turns: SessionTurnChanges[] = []
  const files = new Set<string>()
  for (const [index, checkpoint] of history.checkpoints.entries()) {
    const changes = await compare(history, turnPairs(history, index), reader, cwd)
    if (!changes.length) continue
    for (const change of changes) files.add(change.path)
    turns.push({
      id: checkpoint.id,
      at: checkpoint.at,
      prompt: history.prompts.get(checkpoint.id) ?? null,
      latest: index === history.checkpoints.length - 1,
      files: changes,
    })
  }
  return { turns, files: files.size }
}

function indexOf(history: FileHistory, turnId: string): number {
  const index = history.checkpoints.findLastIndex((c) => c.id === turnId)
  if (index === -1) throw new Error('Diesen Prompt gibt es in der Session nicht (mehr).')
  return index
}

/** What `/rewind` to the prompt `turnId` would change in the files. */
export async function rewindPreview(history: FileHistory, turnId: string, reader: VersionReader, cwd: string | null): Promise<SessionFileChange[]> {
  return compare(history, rewindPairs(history, indexOf(history, turnId)), reader, cwd)
}

/** Both versions of the file at `path` that a change of the turn (`turn`) or `/rewind` to it (`rewind`) compares. */
export async function changeTexts(
  history: FileHistory,
  turnId: string,
  path: string,
  kind: 'turn' | 'rewind',
  reader: VersionReader,
  cwd: string | null,
): Promise<SessionChangeTexts> {
  const index = indexOf(history, turnId)
  const pairs = kind === 'turn' ? turnPairs(history, index) : rewindPairs(history, index)
  // Only a file of the session's history: nothing else is read.
  const pair = pairs.find((p) => absolutePath(history, p.tracked, cwd) === path)
  if (!pair) throw new Error('Diese Datei hat sich hier nicht geändert.')
  const version = (side: HistoryBackup | 'current') => (side === 'current' ? reader.current(path) : reader.backup(side))
  const [before, after] = await Promise.all([version(pair.before), version(pair.after)])
  const note = [before, after].find((v) => v.kind !== 'text' && v.kind !== 'missing')?.kind as FileChangeNote | undefined
  const text = (v: Version) => (v.kind === 'text' ? v.data.toString('utf8') : null)
  return note ? { before: null, after: null, note } : { before: text(before), after: text(after), note: null }
}
