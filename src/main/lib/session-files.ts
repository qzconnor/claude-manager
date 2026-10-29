import { cp, mkdir, open, readdir, stat } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import type { SessionLimit } from '@shared/types'
import type { ClaudePaths } from './claude-paths'
import { readJson } from './json-file'

export const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Only the end of a transcript is read to find the latest answer. */
const TAIL_BYTES = 256 * 1024
/** Without a reset time from Claude Code, a limit is assumed to be over after this long. */
const LIMIT_FALLBACK_MS = 5 * 60 * 60 * 1000

/** Claude Code's project folder name for a working directory. */
export function projectKey(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-')
}

async function isFile(path: string): Promise<boolean> {
  return stat(path).then(
    (s) => s.isFile(),
    () => false,
  )
}

async function isDirectory(path: string): Promise<boolean> {
  return stat(path).then(
    (s) => s.isDirectory(),
    () => false,
  )
}

/** The session's transcript, or null when nothing has been written yet. */
export async function findTranscript(projectsDir: string, sessionId: string, cwd?: string | null): Promise<string | null> {
  const name = `${sessionId}.jsonl`
  if (cwd) {
    const folder = join(projectsDir, projectKey(cwd))
    if (await isDirectory(folder)) return (await isFile(join(folder, name))) ? join(folder, name) : null
  }
  // Very long paths get a shortened folder name: search all projects.
  const folders = await readdir(projectsDir, { withFileTypes: true }).catch(() => [])
  for (const folder of folders) {
    if (folder.isDirectory() && (await isFile(join(projectsDir, folder.name, name)))) {
      return join(projectsDir, folder.name, name)
    }
  }
  return null
}

/**
 * The session Claude Code currently has open in process `pid`. Claude Code keeps
 * `<config>/sessions/<pid>.json` up to date, also after `/clear` or `/resume`.
 * `since` (ms) skips a file left behind by an earlier process with the same pid.
 */
export async function readLiveSessionId(sessionsDir: string, pid: number, since: number): Promise<string | null> {
  const data = await readJson<{ pid?: unknown; sessionId?: unknown; startedAt?: unknown }>(join(sessionsDir, `${pid}.json`))
  if (!data || data.pid !== pid || typeof data.sessionId !== 'string' || !SESSION_ID_RE.test(data.sessionId)) return null
  if (typeof data.startedAt === 'number' && data.startedAt < since - 60_000) return null
  return data.sessionId
}

/**
 * Reports a usage limit when that was the latest answer in the transcript.
 * Limits written before `since` (ms) are ignored: they were hit by an earlier process,
 * possibly with other credentials.
 */
export async function readSessionLimit(file: string, since: number, now = Date.now()): Promise<SessionLimit | null> {
  const handle = await open(file, 'r')
  let text: string
  try {
    const { size } = await handle.stat()
    const length = Math.min(size, TAIL_BYTES)
    const buffer = Buffer.alloc(length)
    await handle.read(buffer, 0, length, size - length)
    text = buffer.toString('utf8')
    // The first line is cut off unless the whole file fit.
    if (length < size) text = text.slice(text.indexOf('\n') + 1)
  } finally {
    await handle.close()
  }

  const lines = text.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]
    if (!line.includes('"assistant"')) continue
    let entry: TranscriptEntry
    try {
      entry = JSON.parse(line) as TranscriptEntry
    } catch {
      continue
    }
    if (entry.type !== 'assistant' || entry.isSidechain) continue
    return entry.error === 'rate_limit' ? toLimit(entry, since, now) : null
  }
  return null
}

interface TranscriptEntry {
  type?: unknown
  isSidechain?: unknown
  error?: unknown
  timestamp?: unknown
  quotaLimits?: { resetsAt?: unknown; rateLimitType?: unknown }
  message?: { content?: unknown }
}

function toLimit(entry: TranscriptEntry, since: number, now: number): SessionLimit | null {
  const quota = entry.quotaLimits
  const resetsAt = typeof quota?.resetsAt === 'number' ? quota.resetsAt * 1000 : null
  const writtenAt = typeof entry.timestamp === 'string' ? Date.parse(entry.timestamp) : NaN
  if (!(writtenAt >= since)) return null
  if (resetsAt !== null ? resetsAt <= now : !(writtenAt > now - LIMIT_FALLBACK_MS)) return null
  const content = Array.isArray(entry.message?.content) ? entry.message.content : []
  const message = content
    .map((block: { text?: unknown }) => (typeof block?.text === 'string' ? block.text : ''))
    .join(' ')
    .trim()
  return {
    type: typeof quota?.rateLimitType === 'string' ? quota.rateLimitType : null,
    resetsAt: resetsAt !== null ? new Date(resetsAt).toISOString() : null,
    message: message || 'Nutzungslimit erreicht',
  }
}

/** Where a transcript goes in another config dir (same project folder name). */
function copyTarget(to: ClaudePaths, sessionId: string, transcript: string): string {
  return join(to.projectsDir, basename(dirname(transcript)), `${sessionId}.jsonl`)
}

/** Refuses to replace a copy of the session that is newer than the source. */
export async function assertNoNewerCopy(
  to: ClaudePaths,
  sessionId: string,
  transcript: string,
  targetName: string,
): Promise<void> {
  const [source, existing] = await Promise.all([stat(transcript), stat(copyTarget(to, sessionId, transcript)).catch(() => null)])
  if (existing && existing.mtimeMs > source.mtimeMs + 1000) {
    throw new Error(`Bei „${targetName}“ liegt schon ein neuerer Stand dieser Session. Setze sie dort fort.`)
  }
}

/**
 * Copies a session into another config dir: the transcript, the folder next to it
 * (subagents, saved tool output) and the snapshots `/rewind` uses.
 */
export async function copySession(
  from: ClaudePaths,
  to: ClaudePaths,
  sessionId: string,
  transcript: string,
  targetName: string,
): Promise<void> {
  await assertNoNewerCopy(to, sessionId, transcript, targetName)
  const target = copyTarget(to, sessionId, transcript)
  const options = { recursive: true, force: true, preserveTimestamps: true }
  const extras: [string, string][] = [
    [join(dirname(transcript), sessionId), join(dirname(target), sessionId)],
    [join(from.configDir, 'file-history', sessionId), join(to.configDir, 'file-history', sessionId)],
  ]
  for (const [src, dst] of extras) {
    if (await isDirectory(src)) await cp(src, dst, options)
  }
  // The transcript last: Claude Code only finds the session once everything else is in place.
  await mkdir(dirname(target), { recursive: true })
  await cp(transcript, target, options)
}
