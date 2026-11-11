import { realpathSync, statSync } from 'node:fs'
import { basename, isAbsolute, relative, resolve } from 'node:path'

/**
 * Which local files Claude may put into a page (browser_file_upload). A page can talk Claude into
 * uploading files (prompt injection), so only the session's own folder and the temp folder count,
 * and keys or credentials never: other files the user uploads themselves.
 */

/** Names of keys and credentials, wherever they lie. */
const SECRET_NAME =
  /^\.env(\..+)?$|^\.(npmrc|netrc|pgpass|git-credentials|pypirc)$|^id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$|\.(pem|key|p12|pfx|kdbx|keystore|jks|ppk)$|^\.?credentials(\.json)?$/i

const ASK_USER = 'Ask the user to upload it themselves (they can take over the browser).'

/** Why `path` can't be uploaded, or null when it can. `folders`: where uploads may come from. */
export function uploadProblem(path: string, folders: readonly string[], platform: NodeJS.Platform = process.platform): string | null {
  if (!isAbsolute(path)) return `Not an absolute path: ${path}`
  // Even looking at a network path makes Windows sign in to the server.
  if (isNetworkPath(path, platform)) return `Files on network shares can't be uploaded: ${path}. ${ASK_USER}`
  let real: string
  try {
    real = realpathSync.native(path)
  } catch {
    return `No such file: ${path}`
  }
  if (isNetworkPath(real, platform)) return `Files on network shares can't be uploaded: ${path}. ${ASK_USER}`
  try {
    if (!statSync(real).isFile()) return `No such file: ${path}`
  } catch {
    return `No such file: ${path}`
  }
  if (SECRET_NAME.test(basename(real))) return `${basename(real)} looks like a key or credentials file and can't be uploaded. ${ASK_USER}`
  const roots = folders.map((folder) => {
    try {
      return realpathSync.native(folder)
    } catch {
      return resolve(folder)
    }
  })
  if (!roots.some((root) => isInside(real, root))) {
    return `Only files in the session's folder (${folders[0] ?? 'none'}) or the temp folder can be uploaded, not ${path}. ${ASK_USER}`
  }
  return null
}

/** Whether `path` is `folder` or lies in it (without case on Windows, see path.relative). */
export function isInside(path: string, folder: string): boolean {
  const rel = relative(folder, path)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

function isNetworkPath(path: string, platform: NodeJS.Platform): boolean {
  return platform === 'win32' && /^[\\/]{2}/.test(path)
}
