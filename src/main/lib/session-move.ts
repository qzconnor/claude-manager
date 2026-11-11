import { appendFile, mkdir, open, rename, rmdir, stat, truncate } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { folderKey, movedPath } from '@shared/folders'
import { projectKey } from './session-files'

/** Claude Code shortens the name of a project folder longer than this, with a hash of the path. */
const MAX_FOLDER_NAME = 200

/** The folder in `projects` that Claude Code keeps the sessions of a working directory in. */
export function projectFolderName(cwd: string): string {
  const name = projectKey(cwd)
  if (name.length <= MAX_FOLDER_NAME) return name
  // As Claude Code hashes it.
  let hash = 0
  for (let i = 0; i < cwd.length; i++) hash = ((hash << 5) - hash + cwd.charCodeAt(i)) | 0
  return `${name.slice(0, MAX_FOLDER_NAME)}-${Math.abs(hash).toString(36)}`
}

/** A session as the index knows it: where it works and where its transcript lies. */
export interface MovableSession {
  id: string
  cwd: string | null
  filePath: string
}

export interface SessionMoveResult {
  /** Sessions that now work in the new place. */
  moved: number
  /** Sessions that stay where they were: open in a running Claude Code, or already there in a copy. */
  skipped: number
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
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
 * Appends a line, on a line of its own also when the transcript ends in the middle of one. Failing,
 * it cuts off what it wrote of it: the transcript stays as it was.
 */
async function appendLine(file: string, line: string): Promise<void> {
  const handle = await open(file, 'r')
  let ending = '\n'
  let size = 0
  try {
    size = (await handle.stat()).size
    if (size > 0) {
      const last = Buffer.alloc(1)
      await handle.read(last, 0, 1, size - 1)
      ending = last[0] === 0x0a ? '' : '\n'
    } else {
      ending = ''
    }
  } finally {
    await handle.close()
  }
  try {
    await appendFile(file, `${ending}${line}\n`, 'utf8')
  } catch (error) {
    await truncate(file, size).catch(() => undefined)
    throw error
  }
}

/** Moves back what moved, last first; false when something stays in the new place. */
async function moveBack(moved: readonly (readonly [from: string, to: string])[]): Promise<boolean> {
  let back = true
  for (const [from, to] of [...moved].reverse()) {
    await rename(to, from).catch((error: unknown) => {
      console.warn(`[sessions] ${to} could not move back to ${from}`, error)
      back = false
    })
  }
  return back
}

/**
 * Moves the session to the folder `cwd` as `/cd` does: the transcript and the folder next to it into
 * the project folder of `cwd`, then a `relocated` entry, so Claude Code resumes it there. Resolves to
 * that project folder; null when a transcript of the session lies there already (a copy), then nothing moved.
 * A step failing (a transcript a virus scanner holds, a full disk), what moved goes back: half a move
 * would leave Claude Code a session without its subagents, or one that doesn't know it moved.
 */
async function relocate(projectsDir: string, session: MovableSession, cwd: string): Promise<string | null> {
  const source = dirname(session.filePath)
  const targetDir = join(projectsDir, projectFolderName(cwd))
  let transcript = session.filePath
  const moved: [from: string, to: string][] = []
  try {
    if (folderKey(source) !== folderKey(targetDir)) {
      transcript = join(targetDir, basename(session.filePath))
      if (await exists(transcript)) return null
      await mkdir(targetDir, { recursive: true })
      // Subagents and saved tool output first: Claude Code finds the session once the transcript is there.
      const extras = join(source, session.id)
      if ((await isDirectory(extras)) && !(await exists(join(targetDir, session.id)))) {
        await rename(extras, join(targetDir, session.id))
        moved.push([extras, join(targetDir, session.id)])
      }
      await rename(session.filePath, transcript)
      moved.push([session.filePath, transcript])
    }
    await appendLine(transcript, JSON.stringify({ type: 'relocated', sessionId: session.id, relocatedCwd: cwd }))
  } catch (error) {
    const back = await moveBack(moved)
    // Made for it and empty again: it goes.
    if (folderKey(source) !== folderKey(targetDir)) await rmdir(targetDir).catch(() => undefined)
    const reason = error instanceof Error ? error.message : String(error)
    throw new Error(back ? `Die Session bleibt im alten Ordner: ${reason}` : `Die Session ist nur zum Teil verschoben: ${reason}`)
  }
  return targetDir
}

/**
 * One session goes on in the folder `to`, as after `/cd` in Claude Code. The memory stays: it belongs
 * to the project, not to the session. The project folder it leaves goes if nothing else is in it.
 * False when a transcript of the session lies in the new place already (a copy): then nothing moved.
 * The caller makes sure no running Claude Code has the session open.
 */
export async function moveSession(projectsDir: string, session: MovableSession, to: string): Promise<boolean> {
  const target = await relocate(projectsDir, session, to)
  if (target === null) return false
  const source = dirname(session.filePath)
  if (folderKey(source) !== folderKey(target)) await rmdir(source).catch(() => undefined)
  return true
}

/**
 * The sessions that worked in the folder `from` (or below it), which is now `to`, go along, as `/cd`
 * moves a session (see `relocate`). Sessions in `live` are open in a running Claude Code and stay: two
 * writers must never share a transcript. The project's memory goes along too.
 */
export async function moveSessions(
  projectsDir: string,
  sessions: readonly MovableSession[],
  from: string,
  to: string,
  live: ReadonlySet<string>,
): Promise<SessionMoveResult> {
  const result: SessionMoveResult = { moved: 0, skipped: 0 }
  // Project folders whose sessions went to another one: their memory goes along, and they go if empty.
  const folders = new Map<string, string>([[join(projectsDir, projectFolderName(from)), join(projectsDir, projectFolderName(to))]])
  for (const session of sessions) {
    const cwd = session.cwd && movedPath(session.cwd, from, to)
    if (!cwd) continue
    if (live.has(session.id)) {
      result.skipped++
      continue
    }
    try {
      const target = await relocate(projectsDir, session, cwd)
      if (target === null) {
        result.skipped++
        continue
      }
      const source = dirname(session.filePath)
      if (folderKey(source) !== folderKey(target) && !folders.has(source)) folders.set(source, target)
      result.moved++
    } catch (error) {
      console.warn(`[sessions] session ${session.id} could not move along`, error)
      result.skipped++
    }
  }
  for (const [source, target] of folders) {
    if (folderKey(source) === folderKey(target)) continue
    const memory = join(source, 'memory')
    try {
      if ((await isDirectory(memory)) && !(await exists(join(target, 'memory')))) {
        await mkdir(target, { recursive: true })
        await rename(memory, join(target, 'memory'))
      }
    } catch (error) {
      console.warn('[sessions] the memory could not move along', error)
    }
    // Only an empty one: whatever else lies there stays.
    await rmdir(source).catch(() => undefined)
  }
  return result
}
