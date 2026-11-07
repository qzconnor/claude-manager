/** Trailing separators, except the one of a root like `C:\` or `/`. */
export const TRAILING_SEPARATORS = /(?<=[^\\/:])[\\/]+$/

/** Drive letters and UNC paths: Windows compares them without regard to case and slash. */
const WINDOWS_PATH = /^(?:[a-z]:|\\\\|\/\/)/i

/** What a folder is compared by, so `F:\Code\` and `f:/code` count as one. */
export function folderKey(path: string): string {
  const trimmed = path.trim().replace(TRAILING_SEPARATORS, '')
  return WINDOWS_PATH.test(trimmed) ? trimmed.replaceAll('/', '\\').toLowerCase() : trimmed
}
