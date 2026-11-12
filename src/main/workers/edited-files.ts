import { posix, win32 } from 'node:path'
import { windowsPath } from '@shared/folders'
import type { EditedFile } from './transcript-parser'

/**
 * A path to compare: normalized, without a trailing separator, under Windows without case and with
 * `/f/x` (Git Bash) as `F:\x`.
 */
export function fileKey(path: string, platform: NodeJS.Platform = process.platform): string {
  if (platform === 'win32') return win32.normalize(windowsPath(path)).replace(/[\\]+$/, '').toLowerCase()
  return posix.normalize(path).replace(/\/+$/, '')
}

/** What the index knows of the files a session changed (see `ParseResult`). */
export interface EditedFiles {
  files?: readonly EditedFile[]
  edits?: readonly EditedFile[]
}

/**
 * When the session changed `path` last: at its latest call that changed it. Without one (a subagent's
 * change, a call in a part of the transcript that is gone) when Claude Code backed it up last, which
 * may also be a turn after someone else changed it. Null when the session didn't change it.
 */
export function editedAt(session: EditedFiles | undefined, path: string, platform: NodeJS.Platform = process.platform): string | null {
  const wanted = fileKey(path, platform)
  const latest = (files: readonly EditedFile[] | undefined): string | null => {
    let found: string | null = null
    for (const [file, at] of files ?? []) {
      if (fileKey(file, platform) === wanted && (found === null || at > found)) found = at
    }
    return found
  }
  return latest(session?.edits) ?? latest(session?.files)
}
