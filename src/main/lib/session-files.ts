import { cp, mkdir, open, readdir, stat } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import type { SessionLimit, SessionWorktree } from '@shared/types'
import type { ClaudePaths } from './claude-paths'
import { toolSummary, toWorktree } from '../workers/transcript-parser'
import { readJson } from './json-file'

export const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Only the end of a transcript is read to find the latest answer. */
const TAIL_BYTES = 256 * 1024
/** Transcripts are searched for titles in pieces of this size. */
const TITLE_CHUNK_BYTES = 1024 * 1024
/** Without a reset time from Claude Code, a limit is assumed to be over after this long. */
const LIMIT_FALLBACK_MS = 5 * 60 * 60 * 1000

/** Claude Code's project folder name for a working directory. */
export function projectKey(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-')
}

/** What follows a folder's project key in the key of its worktrees: `\.claude\worktrees\`. */
const WORKTREE_KEY = projectKey('/.claude/worktrees/')

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

/**
 * The session's transcript, or null when nothing has been written yet. A session started with
 * `claude --worktree` writes it to the project folder of its worktree (`<cwd>\.claude\worktrees\<name>`).
 */
export async function findTranscript(projectsDir: string, sessionId: string, cwd?: string | null): Promise<string | null> {
  const name = `${sessionId}.jsonl`
  if (cwd) {
    const key = projectKey(cwd)
    const folder = join(projectsDir, key)
    if (await isDirectory(folder)) {
      if (await isFile(join(folder, name))) return join(folder, name)
      const worktrees = (await readdir(projectsDir, { withFileTypes: true }).catch(() => [])).filter(
        (entry) => entry.isDirectory() && entry.name.startsWith(`${key}${WORKTREE_KEY}`),
      )
      for (const worktree of worktrees) {
        if (await isFile(join(projectsDir, worktree.name, name))) return join(projectsDir, worktree.name, name)
      }
      return null
    }
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
 * The session Claude Code currently has open in process `pid`, with the folder it works in (e.g. its
 * worktree) when the file names it. Claude Code keeps `<config>/sessions/<pid>.json` up to date, also
 * after `/clear` or `/resume`, and writes it at once, before the transcript.
 * `since` (ms) skips a file left behind by an earlier process with the same pid.
 */
export async function readLiveSession(
  sessionsDir: string,
  pid: number,
  since: number,
): Promise<{ sessionId: string; cwd: string | null } | null> {
  const data = await readJson<{ pid?: unknown; sessionId?: unknown; startedAt?: unknown; cwd?: unknown }>(
    join(sessionsDir, `${pid}.json`),
  )
  if (!data || data.pid !== pid || typeof data.sessionId !== 'string' || !SESSION_ID_RE.test(data.sessionId)) return null
  if (typeof data.startedAt === 'number' && data.startedAt < since - 60_000) return null
  return { sessionId: data.sessionId, cwd: typeof data.cwd === 'string' && data.cwd ? data.cwd : null }
}

/**
 * The worktree Claude Code made for a session (`claude --worktree`), told by the folder it works in:
 * `<startCwd>\.claude\worktrees\<name>`. The branch is only known from the transcript.
 */
export function worktreeAt(cwd: string, startCwd: string): SessionWorktree | null {
  const match = /^(.*)[\\/]\.claude[\\/]worktrees[\\/]([^\\/]+)[\\/]?$/.exec(cwd)
  if (!match || !match[1]) return null
  return { name: match[2]!, branch: null, path: cwd, originalCwd: startCwd }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM: it exists, it's just not ours.
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** Sessions a running Claude Code has open, from `<config>/sessions/<pid>.json`. */
export async function liveSessionIds(sessionsDir: string): Promise<Set<string>> {
  const files = await readdir(sessionsDir).catch(() => [])
  const ids = new Set<string>()
  for (const file of files) {
    const pid = Number(/^(\d+)\.json$/.exec(file)?.[1])
    if (!pid || !isAlive(pid)) continue
    const data = await readJson<{ pid?: unknown; sessionId?: unknown }>(join(sessionsDir, file))
    if (data?.pid === pid && typeof data.sessionId === 'string') ids.add(data.sessionId)
  }
  return ids
}

/**
 * What Claude Code keeps of a session besides the transcript: the folder next to it
 * (subagents, saved tool output), the snapshots `/rewind` uses, environment and task list.
 */
export async function sessionFiles(paths: ClaudePaths, sessionId: string, transcript: string): Promise<string[]> {
  if (!SESSION_ID_RE.test(sessionId)) return []
  const candidates = [
    join(dirname(transcript), sessionId),
    join(paths.configDir, 'file-history', sessionId),
    join(paths.configDir, 'session-env', sessionId),
    join(paths.configDir, 'tasks', sessionId),
  ]
  const found = await Promise.all(candidates.map(async (path) => ((await isDirectory(path)) ? path : null)))
  return found.filter((path): path is string => path !== null)
}

/**
 * Reports a usage limit when that was the latest answer in the transcript.
 * Limits written before `since` (ms) are ignored: they were hit by an earlier process,
 * possibly with other credentials.
 */
export async function readSessionLimit(file: string, since: number, now = Date.now()): Promise<SessionLimit | null> {
  const lines = (await readTail(file)).split('\n')
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

/** The end of a transcript, from the first complete line on. */
async function readTail(file: string): Promise<string> {
  const handle = await open(file, 'r')
  try {
    const { size } = await handle.stat()
    const length = Math.min(size, TAIL_BYTES)
    const buffer = Buffer.alloc(length)
    await handle.read(buffer, 0, length, size - length)
    const text = buffer.toString('utf8')
    // The first line is cut off unless the whole file fit.
    return length < size ? text.slice(text.indexOf('\n') + 1) : text
  } finally {
    await handle.close()
  }
}

/** How Claude Code ended its turn, from the end of the transcript. */
export interface TurnOutcome {
  /** Claude Code wrote the end of the turn (`turn_duration`): the answer is complete. */
  ended: boolean
  /** The user stopped the turn (Esc, or declined a permission). */
  interrupted: boolean
  /** A tool call without result: Claude Code asks for permission, asks a question or wants a plan approved. */
  waiting: { tool: string; detail: string } | null
  /** Text of the latest answer; null when the turn has none (yet). */
  answer: string | null
}

/** Marks the user message Claude Code writes when the user stops a turn. */
const INTERRUPTED_PREFIX = '[Request interrupted by user'

/** Reads how the turn that started at `since` (ms) ended, as far as Claude Code has written it. */
export async function readTurnOutcome(file: string, since: number): Promise<TurnOutcome> {
  return turnOutcome(await readTail(file), since)
}

/**
 * Walks back from the end of the transcript to the turn's prompt: the latest tool call without a
 * result means Claude Code waits for the user, otherwise the latest text is the answer. Entries from
 * before `since` (ms) belong to an earlier turn, the current one isn't written yet then.
 */
export function turnOutcome(text: string, since: number): TurnOutcome {
  const outcome: TurnOutcome = { ended: false, interrupted: false, waiting: null, answer: null }
  const answered = new Set<string>()
  const lines = text.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]
    if (!line.includes('"user"') && !line.includes('"assistant"') && !line.includes('"turn_duration"')) continue
    let entry: TranscriptEntry
    try {
      entry = JSON.parse(line) as TranscriptEntry
    } catch {
      continue
    }
    if (entry.isSidechain || entry.isMeta) continue
    const fresh = typeof entry.timestamp === 'string' && Date.parse(entry.timestamp) >= since
    if (entry.type === 'system') {
      if (entry.subtype === 'turn_duration' && fresh) outcome.ended = true
      continue
    }
    const content = entry.message?.content
    if (entry.type === 'user') {
      const blocks = typeof content === 'string' ? [{ type: 'text', text: content }] : Array.isArray(content) ? content : []
      let prompt = false
      for (const block of blocks as (ContentBlock | null)[]) {
        if (block?.type === 'tool_result' && typeof block.tool_use_id === 'string') {
          answered.add(block.tool_use_id)
        } else if (block?.type === 'text') {
          prompt = true
          if (fresh && typeof block.text === 'string' && block.text.startsWith(INTERRUPTED_PREFIX)) outcome.interrupted = true
        }
      }
      // The prompt opens the turn: nothing before it belongs to the answer.
      if (prompt) return outcome
      continue
    }
    if (entry.type !== 'assistant' || !Array.isArray(content)) continue
    // An answer of an earlier turn: the current one isn't written yet.
    if (!fresh) return outcome
    const blocks = content as (ContentBlock | null)[]
    for (let j = blocks.length - 1; j >= 0; j--) {
      const block = blocks[j]
      if (block?.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
        outcome.answer = block.text.trim()
        return outcome
      }
      if (block?.type === 'tool_use' && typeof block.id === 'string' && !answered.has(block.id)) {
        const tool = typeof block.name === 'string' && block.name ? block.name : 'Tool'
        outcome.waiting = { tool, detail: waitingDetail(tool, block.input) }
        return outcome
      }
    }
  }
  return outcome
}

/** What a tool call waiting for the user is about: the question, the plan's heading, the command or file. */
function waitingDetail(tool: string, input: unknown): string {
  const i = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>
  if (tool === 'AskUserQuestion' && Array.isArray(i.questions)) {
    const question = (i.questions[0] as { question?: unknown } | undefined)?.question
    if (typeof question === 'string') return question.trim()
  }
  if (tool === 'ExitPlanMode' && typeof i.plan === 'string') {
    const heading = i.plan.split('\n').find((line) => line.trim())
    return heading ? heading.replace(/^#+\s*/, '').trim() : ''
  }
  return toolSummary(tool, input)
}

/** The titles found in a transcript so far; pass the same object again to read what was appended. */
export interface TitleScan {
  /** Bytes read so far, always up to the end of a complete line. */
  offset: number
  /** Set with `/rename`. */
  custom: string | null
  /** Generated by Claude Code after the first prompt. */
  ai: string | null
  /** Written by older Claude Code versions. */
  summary: string | null
  /** The worktree the session works in (`claude --worktree`); null when it has none or left it. */
  worktree: SessionWorktree | null
}

export function newTitleScan(): TitleScan {
  return { offset: 0, custom: null, ai: null, summary: null, worktree: null }
}

/** The title Claude Code shows for the session, e.g. in `/resume`. */
export function scannedTitle(scan: TitleScan): string | null {
  return scan.custom ?? scan.ai ?? scan.summary
}

const TITLE_ENTRIES = [
  { marker: Buffer.from('"type":"custom-title"'), type: 'custom-title', field: 'customTitle', key: 'custom' },
  { marker: Buffer.from('"type":"ai-title"'), type: 'ai-title', field: 'aiTitle', key: 'ai' },
  { marker: Buffer.from('"type":"summary"'), type: 'summary', field: 'summary', key: 'summary' },
] as const

/**
 * Reads the session's titles from the part of the transcript that `scan` has not seen yet.
 * Claude Code repeats them after every turn; the latest one of each kind counts.
 */
export async function readSessionTitles(file: string, scan: TitleScan): Promise<void> {
  const handle = await open(file, 'r')
  try {
    const { size } = await handle.stat()
    // Shorter than before: the file was replaced, start over.
    if (size < scan.offset) Object.assign(scan, newTitleScan())
    const buffer = Buffer.alloc(Math.min(TITLE_CHUNK_BYTES, size - scan.offset))
    let position = scan.offset
    // Inside a line longer than a chunk (e.g. an image): it holds no title.
    let skipping = false
    while (position < size) {
      const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, size - position), position)
      if (bytesRead === 0) break
      const data = buffer.subarray(0, bytesRead)
      if (skipping) {
        const end = data.indexOf(0x0a)
        if (end === -1) {
          position += bytesRead
          continue
        }
        skipping = false
        position += end + 1
        scan.offset = position
        continue
      }
      const last = data.lastIndexOf(0x0a)
      if (last === -1) {
        // The last line is still being written: it is read again next time.
        if (position + bytesRead >= size) break
        skipping = true
        position += bytesRead
        continue
      }
      scanTitleLines(data.subarray(0, last + 1), scan)
      position += last + 1
      scan.offset = position
    }
  } finally {
    await handle.close()
  }
}

const WORKTREE_MARKER = Buffer.from('"type":"worktree-state"')

/** Picks the title entries (and the worktree) out of complete lines without parsing every line. */
function scanTitleLines(lines: Buffer, scan: TitleScan): void {
  let hit = lines.indexOf(WORKTREE_MARKER)
  while (hit !== -1) {
    const start = lines.lastIndexOf(0x0a, hit) + 1
    const end = lines.indexOf(0x0a, hit)
    try {
      const entry = JSON.parse(lines.toString('utf8', start, end)) as Record<string, unknown>
      if (entry.type === 'worktree-state') scan.worktree = toWorktree(entry.worktreeSession)
    } catch {
      // not a complete entry
    }
    hit = lines.indexOf(WORKTREE_MARKER, end)
  }
  for (const { marker, type, field, key } of TITLE_ENTRIES) {
    let hit = lines.indexOf(marker)
    while (hit !== -1) {
      const start = lines.lastIndexOf(0x0a, hit) + 1
      const end = lines.indexOf(0x0a, hit)
      try {
        const entry = JSON.parse(lines.toString('utf8', start, end)) as Record<string, unknown>
        const value = entry.type === type ? entry[field] : null
        if (typeof value === 'string' && value.trim()) scan[key] = value.trim()
      } catch {
        // not a complete entry
      }
      hit = lines.indexOf(marker, end)
    }
  }
}

interface ContentBlock {
  type?: unknown
  text?: unknown
  id?: unknown
  name?: unknown
  input?: unknown
  tool_use_id?: unknown
}

interface TranscriptEntry {
  type?: unknown
  subtype?: unknown
  isSidechain?: unknown
  isMeta?: unknown
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
