import type { FileEntry, FileListing, GitFileState, GitFileStatus, GitTreeStatus } from '@shared/types'

/**
 * The file tree of a tab, without Vue: paths, the rows it shows, git's marks and the search. A path in
 * a tree is relative to its folder and `/`-separated on every platform; '' is the folder itself.
 */

/** The type an entry dragged out of the tree carries: its absolute path, which a terminal pastes. */
export const FILE_TREE_DRAG_TYPE = 'application/x-claude-manager-path'

export const childPath = (dir: string, name: string) => (dir ? `${dir}/${name}` : name)

export function parentPath(path: string): string {
  const index = path.lastIndexOf('/')
  return index === -1 ? '' : path.slice(0, index)
}

export const baseName = (path: string) => path.slice(path.lastIndexOf('/') + 1)

/** The folders a path lies in, outermost first: `a/b/c` → `a`, `a/b`. */
export function ancestors(path: string): string[] {
  const parts = path.split('/')
  return parts.slice(0, -1).map((_, i) => parts.slice(0, i + 1).join('/'))
}

/** The last part of a folder's path, whichever separator it uses. */
export function folderName(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, '')
  return trimmed.slice(Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\')) + 1) || trimmed
}

/** The file system's path of a tree path; `separator` is the platform's. */
export function absolutePath(root: string, path: string, separator: string): string {
  // A folder given with slashes on Windows (e.g. through the API) gets the same separators as its files.
  if (separator === '\\') root = root.replaceAll('/', '\\')
  if (!path) return root
  const base = root.endsWith('/') || root.endsWith('\\') ? root : root + separator
  return base + path.split('/').join(separator)
}

/**
 * The tree path of an absolute path, as Claude names files; null outside the tree's folder. On Windows
 * both separators count and letter case doesn't.
 */
export function treePathOf(root: string, absolute: string, windows: boolean): string | null {
  const normalize = (path: string) => {
    const slashed = windows ? path.replaceAll('\\', '/') : path
    return slashed.replace(/\/+$/, '')
  }
  const base = normalize(root)
  const full = normalize(absolute)
  const same = (a: string, b: string) => (windows ? a.toLowerCase() === b.toLowerCase() : a === b)
  if (same(full, base)) return ''
  if (full.length <= base.length + 1 || full[base.length] !== '/' || !same(full.slice(0, base.length), base)) return null
  return full.slice(base.length + 1)
}

/** A line of the tree: an entry, the note that a folder has more, or a message (an error, still loading). */
export type TreeRow =
  | {
      kind: 'entry'
      path: string
      name: string
      depth: number
      entry: FileEntry
      /** An open folder. */
      expanded: boolean
      /** Where the search matched the name: start and end. */
      match: [number, number] | null
    }
  | { kind: 'more'; path: string; depth: number; count: number }
  | { kind: 'message'; path: string; depth: number; text: string; error: boolean }

export interface TreeSource {
  listings: ReadonlyMap<string, FileListing>
  errors: ReadonlyMap<string, string>
  expanded: ReadonlySet<string>
  /** Entries left out, e.g. the ones git ignores while they are hidden. */
  hidden?: (path: string, entry: FileEntry) => boolean
}

/** The rows of the tree from its folder down through the open folders, as it shows them. */
export function flattenTree(source: TreeSource): TreeRow[] {
  const rows: TreeRow[] = []
  const walk = (dir: string, depth: number) => {
    const listing = source.listings.get(dir)
    if (!listing) {
      const error = source.errors.get(dir)
      // The folder itself shows what happened with the tree's folder.
      if (dir) rows.push({ kind: 'message', path: `${dir}/\0message`, depth, text: error ?? 'Wird geladen…', error: !!error })
      return
    }
    for (const entry of listing.entries) {
      const path = childPath(dir, entry.name)
      if (source.hidden?.(path, entry)) continue
      const expanded = entry.dir && source.expanded.has(path)
      rows.push({ kind: 'entry', path, name: entry.name, depth, entry, expanded, match: null })
      if (expanded) walk(path, depth + 1)
    }
    if (listing.omitted > 0) rows.push({ kind: 'more', path: `${dir}/\0more`, depth, count: listing.omitted })
  }
  walk('', 0)
  return rows
}

/** Order of the marks, the strongest first: a folder shows the strongest of the files in it. */
const PRIORITY: GitFileStatus[] = ['conflict', 'deleted', 'modified', 'renamed', 'added', 'untracked']

export const STATUS_LETTER: Record<GitFileStatus, string> = {
  modified: 'M',
  added: 'A',
  deleted: 'D',
  renamed: 'R',
  untracked: 'U',
  conflict: '!',
}

export const STATUS_LABEL: Record<GitFileStatus, string> = {
  modified: 'Geändert',
  added: 'Hinzugefügt',
  deleted: 'Gelöscht',
  renamed: 'Umbenannt',
  untracked: 'Neu, nicht in Git',
  conflict: 'Konflikt',
}

/** Text colour of a mark, from the theme. */
export const STATUS_CLASS: Record<GitFileStatus, string> = {
  modified: 'text-warning',
  added: 'text-success',
  deleted: 'text-destructive',
  renamed: 'text-success',
  untracked: 'text-success',
  conflict: 'text-destructive',
}

export interface GitDecorations {
  /** A file's own state; a file in an untracked folder is untracked too. */
  file(path: string): GitFileState | null
  /** The strongest state of the files in a folder (or of the folder, when it is untracked as a whole). */
  folder(path: string): GitFileStatus | null
  ignored(path: string): boolean
  /** How many files have each state; an untracked folder counts once. */
  counts: Partial<Record<GitFileStatus, number>>
}

const UNTRACKED: GitFileState = { status: 'untracked', staged: false, added: null, removed: null }

export function gitDecorations(status: GitTreeStatus | null): GitDecorations {
  const files = new Map<string, GitFileState>()
  const untrackedDirs = new Set<string>()
  const folders = new Map<string, GitFileStatus>()
  const counts: Partial<Record<GitFileStatus, number>> = {}
  const mark = (dir: string, state: GitFileStatus) => {
    const current = folders.get(dir)
    if (!current || PRIORITY.indexOf(state) < PRIORITY.indexOf(current)) folders.set(dir, state)
  }
  for (const [key, state] of Object.entries(status?.files ?? {})) {
    counts[state.status] = (counts[state.status] ?? 0) + 1
    if (key.endsWith('/')) {
      const dir = key.slice(0, -1)
      untrackedDirs.add(dir)
      mark(dir, state.status)
      for (const parent of ancestors(dir)) mark(parent, state.status)
    } else {
      files.set(key, state)
      for (const parent of ancestors(key)) mark(parent, state.status)
    }
  }
  const ignoredFiles = new Set<string>()
  const ignoredDirs = new Set<string>()
  for (const path of status?.ignored ?? []) {
    if (path.endsWith('/')) ignoredDirs.add(path.slice(0, -1))
    else ignoredFiles.add(path)
  }
  const inside = (set: Set<string>, path: string) => set.size > 0 && ancestors(path).some((dir) => set.has(dir))
  return {
    file: (path) => files.get(path) ?? (inside(untrackedDirs, path) ? UNTRACKED : null),
    folder: (path) => folders.get(path) ?? (inside(untrackedDirs, path) ? 'untracked' : null),
    ignored: (path) => ignoredFiles.has(path) || ignoredDirs.has(path) || inside(ignoredDirs, path),
    counts,
  }
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })

/** The folders of a list of files, cached per list: the search looks at them for every key. */
const folderCache = new WeakMap<readonly string[], string[]>()
function foldersOf(paths: readonly string[]): string[] {
  let folders = folderCache.get(paths)
  if (!folders) {
    const set = new Set<string>()
    for (const path of paths) for (const dir of ancestors(path)) set.add(dir)
    folders = [...set]
    folderCache.set(paths, folders)
  }
  return folders
}

export interface SearchResult {
  rows: TreeRow[]
  /** Files and folders that matched; more than `limit` are cut off. */
  matches: number
}

/**
 * The files and folders whose name contains `query` (case doesn't matter; with a `/` in it, their path),
 * the best `limit` of them, shown as a tree with the folders they lie in.
 */
export function searchTree(paths: readonly string[], query: string, limit = 400): SearchResult {
  const needle = query.trim().toLowerCase()
  if (!needle) return { rows: [], matches: 0 }
  const byPath = needle.includes('/')
  const score = (path: string): number | null => {
    const name = baseName(path).toLowerCase()
    if (name === needle) return 0
    if (name.startsWith(needle)) return 1
    if (name.includes(needle)) return 2
    if (byPath && path.toLowerCase().includes(needle)) return 3
    return null
  }
  const hits: { path: string; dir: boolean; score: number }[] = []
  for (const dir of foldersOf(paths)) {
    const s = score(dir)
    if (s !== null) hits.push({ path: dir, dir: true, score: s })
  }
  for (const path of paths) {
    const s = score(path)
    if (s !== null) hits.push({ path, dir: false, score: s })
  }
  hits.sort((a, b) => a.score - b.score || a.path.length - b.path.length)
  const shown = hits.slice(0, limit)

  // The tree of the hits: every folder they lie in is open.
  const children = new Map<string, Map<string, boolean>>()
  const add = (path: string, dir: boolean) => {
    const parent = parentPath(path)
    let list = children.get(parent)
    if (!list) children.set(parent, (list = new Map()))
    list.set(path, dir || (list.get(path) ?? false))
  }
  for (const hit of shown) {
    add(hit.path, hit.dir)
    for (const dir of ancestors(hit.path)) add(dir, true)
  }
  const rows: TreeRow[] = []
  const walk = (dir: string, depth: number) => {
    const list = [...(children.get(dir) ?? [])].sort(([a, aDir], [b, bDir]) =>
      aDir !== bDir ? (aDir ? -1 : 1) : collator.compare(baseName(a), baseName(b)),
    )
    for (const [path, isDir] of list) {
      const name = baseName(path)
      const at = name.toLowerCase().indexOf(needle)
      const expanded = isDir && children.has(path)
      rows.push({
        kind: 'entry',
        path,
        name,
        depth,
        entry: { name, dir: isDir, link: false, broken: false },
        expanded,
        match: at === -1 ? null : [at, at + needle.length],
      })
      if (expanded) walk(path, depth + 1)
    }
  }
  walk('', 0)
  return { rows, matches: hits.length }
}
