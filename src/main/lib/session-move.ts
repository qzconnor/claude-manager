import { appendFile, mkdir, open, rename, rmdir, stat } from 'node:fs/promises'
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

/** Appends a line, on a line of its own also when the transcript ends in the middle of one. */
async function appendLine(file: string, line: string): Promise<void> {
  const handle = await open(file, 'r')
  let ending = '\n'
  try {
    const { size } = await handle.stat()
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
  await appendFile(file, `${ending}${line}\n`, 'utf8')
}

/**
 * The sessions that worked in the folder `from` (or below it), which is now `to`, go along, as `/cd`
 * moves a session: the transcript and the folder next to it into the project folder of the new place,
 * then a `relocated` entry, so Claude Code resumes them there. Sessions in `live` are open in a running
 * Claude Code and stay: two writers must never share a transcript. The project's memory goes along too.
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
      const source = dirname(session.filePath)
      const targetDir = join(projectsDir, projectFolderName(cwd))
      let transcript = session.filePath
      if (folderKey(source) !== folderKey(targetDir)) {
        transcript = join(targetDir, basename(session.filePath))
        if (await exists(transcript)) {
          result.skipped++
          continue
        }
        await mkdir(targetDir, { recursive: true })
        // Subagents and saved tool output first: Claude Code finds the session once the transcript is there.
        const extras = join(source, session.id)
        if ((await isDirectory(extras)) && !(await exists(join(targetDir, session.id)))) {
          await rename(extras, join(targetDir, session.id))
        }
        await rename(session.filePath, transcript)
        if (!folders.has(source)) folders.set(source, targetDir)
      }
      await appendLine(transcript, JSON.stringify({ type: 'relocated', sessionId: session.id, relocatedCwd: cwd }))
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
