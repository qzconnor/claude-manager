/** Trailing separators, except the one of a root like `C:\` or `/`. */
export const TRAILING_SEPARATORS = /(?<=[^\\/:])[\\/]+$/

/** Drive letters and UNC paths: Windows compares them without regard to case and slash. */
const WINDOWS_PATH = /^(?:[a-z]:|\\\\|\/\/)/i

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
