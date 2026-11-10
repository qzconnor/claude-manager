/** Trailing separators, except the one of a root like `C:\` or `/`. */
export const TRAILING_SEPARATORS = /(?<=[^\\/:])[\\/]+$/

/** Drive letters and UNC paths: Windows compares them without regard to case and slash. */
const WINDOWS_PATH = /^(?:[a-z]:|\\\\|\/\/)/i

/** `/f/Projekte` (Git Bash) and `/cygdrive/f/Projekte` (Cygwin): how some sessions write a folder on Windows. */
const POSIX_DRIVE = /^\/(?:cygdrive\/)?([a-z])(?=\/|$)/i
const DRIVE = /^[a-z]:/i

/**
 * A folder as Windows writes it: `F:\Projekte` also for `f:/Projekte`, `/f/Projekte` (Git Bash) or
 * `/cygdrive/f/Projekte`, every drive letter upper case. Other paths (UNC, relative) stay as they are.
 * Only for folders on Windows: elsewhere `/f/Projekte` is a folder of its own.
 */
export function windowsPath(path: string): string {
  const trimmed = path.trim()
  const posix = POSIX_DRIVE.exec(trimmed)
  const drive = posix ? `${posix[1]}:${trimmed.slice(posix[0].length) || '\\'}` : trimmed
  if (!DRIVE.test(drive)) return path
  return drive.charAt(0).toUpperCase() + drive.slice(1).replaceAll('/', '\\')
}

/** What a folder is compared by, so `F:\Code\` and `f:/code` count as one. */
export function folderKey(path: string): string {
  const trimmed = path.trim().replace(TRAILING_SEPARATORS, '')
  return WINDOWS_PATH.test(trimmed) ? trimmed.replaceAll('/', '\\').toLowerCase() : trimmed
}

/** Whether `path` is the folder `folder` or lies in it, compared by `folderKey`. */
export function inFolder(path: string, folder: string): boolean {
  const a = folderKey(path)
  const b = folderKey(folder)
  if (!b) return false
  if (a === b) return true
  const separator = WINDOWS_PATH.test(b) ? '\\' : '/'
  return a.startsWith(b.endsWith(separator) ? b : `${b}${separator}`)
}

/**
 * Where `path` is once the folder `from` it lies in (or is) has moved to `to`, with the separators of
 * `to`; null when it doesn't lie in `from`.
 */
export function movedPath(path: string, from: string, to: string): string | null {
  if (!inFolder(path, from)) return null
  // Spelled differently maybe, but as long: `folderKey` changes neither the length nor the separators' places.
  const rest = path.trim().replace(TRAILING_SEPARATORS, '').slice(from.trim().replace(TRAILING_SEPARATORS, '').length)
  const parts = rest.split(/[\\/]+/).filter(Boolean)
  if (parts.length === 0) return to
  const separator = to.includes('\\') || DRIVE.test(to) ? '\\' : '/'
  return `${to.replace(/[\\/]+$/, '')}${separator}${parts.join(separator)}`
}
