/** A folder a tab or a session ran in, and when. */
export interface FolderUse {
  path: string
  /** ISO time: when the tab opened or the session was last written. */
  at: string
}

export interface RecentFolder {
  path: string
  /** Last part of the path, e.g. `claude-manager`. */
  name: string
  /** The folder it lies in; empty for a drive or the root. */
  parent: string
  /** ISO time of the latest use. */
  lastUsed: string
}

/** Trailing separators, except the one of a root like `C:\` or `/`. */
const TRAILING_SEPARATORS = /(?<=[^\\/:])[\\/]+$/

/** Drive letters and UNC paths: Windows compares them without regard to case and slash. */
const WINDOWS_PATH = /^(?:[a-z]:|\\\\|\/\/)/i

/** What a folder is compared by, so `F:\Code\` and `f:/code` count as one. */
export function folderKey(path: string): string {
  const trimmed = path.trim().replace(TRAILING_SEPARATORS, '')
  return WINDOWS_PATH.test(trimmed) ? trimmed.replaceAll('/', '\\').toLowerCase() : trimmed
}

/** Name and parent of a folder; a drive or the root is its own name. */
export function splitFolder(path: string): { name: string; parent: string } {
  const trimmed = path.trim().replace(TRAILING_SEPARATORS, '')
  const cut = Math.max(trimmed.lastIndexOf('\\'), trimmed.lastIndexOf('/'))
  const name = trimmed.slice(cut + 1)
  if (!name) return { name: trimmed, parent: '' }
  // `C:\Code` lies in `C:\`, `/home` in `/`.
  const parent = trimmed.slice(0, cut)
  return { name, parent: parent === '' || parent.endsWith(':') ? trimmed.slice(0, cut + 1) : parent }
}

function time(iso: string): number {
  const ms = Date.parse(iso)
  return Number.isNaN(ms) ? 0 : ms
}

/**
 * The folders of `uses`, latest first and each once (by `folderKey`), at most `limit`. Folders in
 * `exclude` are left out: those a new session starts in anyway, without choosing a folder.
 */
export function recentFolders(
  uses: Iterable<FolderUse>,
  options: { limit: number; exclude?: Iterable<string | null | undefined> },
): RecentFolder[] {
  const skip = new Set<string>()
  for (const path of options.exclude ?? []) if (path?.trim()) skip.add(folderKey(path))

  const latest = new Map<string, FolderUse>()
  for (const use of uses) {
    if (!use.path.trim()) continue
    const key = folderKey(use.path)
    if (skip.has(key)) continue
    const known = latest.get(key)
    if (!known || time(use.at) > time(known.at)) latest.set(key, use)
  }

  return [...latest.values()]
    .sort((a, b) => time(b.at) - time(a.at))
    .slice(0, Math.max(0, options.limit))
    .map((use) => {
      const path = use.path.trim().replace(TRAILING_SEPARATORS, '')
      return { path, ...splitFolder(path), lastUsed: use.at }
    })
}
