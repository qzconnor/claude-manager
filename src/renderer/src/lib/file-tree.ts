import type { FileEntry, FileListing, FileTouchKind, GitFileState, GitFileStatus, GitTreeStatus } from '@shared/types'

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

/** Git's states in the order the tree lists them, e.g. in the count of the changes. */
export const GIT_STATUSES: readonly GitFileStatus[] = ['conflict', 'modified', 'added', 'renamed', 'deleted', 'untracked']

// ── What Claude does with files ──

/** The kinds of touch in the order the tree lists them: read, searched, written, committed. */
export const TOUCH_KINDS: readonly FileTouchKind[] = ['read', 'search', 'write', 'commit']

/** Which kind shows when a file (or the files in a folder) was touched in several ways: the highest. */
export const TOUCH_RANK: Record<FileTouchKind, number> = { search: 0, read: 1, commit: 2, write: 3 }

/** What Claude did with a file in a session: when it last did each kind of touch (ms since the epoch). */
export type TouchRecord = Partial<Record<FileTouchKind, number>>

/** The strongest kind of touch in a record, leaving out the `hidden` ones; null when none is left. */
export function recordKind(record: TouchRecord, hidden?: ReadonlySet<FileTouchKind>): FileTouchKind | null {
  let strongest: FileTouchKind | null = null
  for (const kind of TOUCH_KINDS) {
    if (record[kind] === undefined || hidden?.has(kind)) continue
    if (!strongest || TOUCH_RANK[kind] > TOUCH_RANK[strongest]) strongest = kind
  }
  return strongest
}

/** The record with a touch of `kind` at `at`. */
export function recordTouch(record: TouchRecord | undefined, kind: FileTouchKind, at: number): TouchRecord {
  return Object.freeze({ ...record, [kind]: at })
}

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

/** Folders git reports as new as a whole (`dir/`): their files aren't listed one by one. */
export function untrackedFolders(status: GitTreeStatus | null): string[] {
  return Object.keys(status?.files ?? {}).filter((key) => key.endsWith('/'))
}

/**
 * The files git sees changed, deleted ones too, and those in folders new as a whole, taken from
 * `listed` (the list of all files) once it is there.
 */
export function changedFiles(status: GitTreeStatus | null, listed: readonly string[] | null | undefined): string[] {
  const paths = Object.keys(status?.files ?? {}).filter((key) => !key.endsWith('/'))
  const dirs = untrackedFolders(status)
  if (dirs.length > 0) {
    for (const path of listed ?? []) if (dirs.some((dir) => path.startsWith(dir))) paths.push(path)
  }
  return paths
}

/** Files in the order the tree shows them: folder by folder, folders before files, by name. */
export function treeOrder(paths: readonly string[]): string[] {
  return filesTree(paths, new Set()).flatMap((row) => (row.kind === 'entry' && !row.entry.dir ? [row.path] : []))
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })

/** The folders of a list of files, cached per list: the search looks at them for every key. */
const folderCache = new WeakMap<readonly string[], string[]>()
export function foldersOf(paths: readonly string[]): string[] {
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
  // The tree of the hits: every folder they lie in is open.
  const rows = treeRows(hits.slice(0, limit), null, (name) => {
    const at = name.toLowerCase().indexOf(needle)
    return at === -1 ? null : [at, at + needle.length]
  })
  return { rows, matches: hits.length }
}

/**
 * The files a filter lets through (`paths`: the changed ones, those Claude touched) as a tree with the
 * folders they lie in; those in `collapsed` are closed.
 */
export function filesTree(paths: readonly string[], collapsed: ReadonlySet<string>): TreeRow[] {
  return treeRows(
    paths.map((path) => ({ path, dir: false })),
    collapsed,
    () => null,
  )
}

/**
 * Entries shown as a tree with the folders they lie in, folders first: a folder with entries in it is
 * open unless it is in `collapsed`; `match` marks the part of a name to highlight.
 */
function treeRows(
  items: Iterable<{ path: string; dir: boolean }>,
  collapsed: ReadonlySet<string> | null,
  match: (name: string) => [number, number] | null,
): TreeRow[] {
  const children = new Map<string, Map<string, boolean>>()
  const add = (path: string, dir: boolean) => {
    const parent = parentPath(path)
    let list = children.get(parent)
    if (!list) children.set(parent, (list = new Map()))
    list.set(path, dir || (list.get(path) ?? false))
  }
  for (const item of items) {
    add(item.path, item.dir)
    for (const dir of ancestors(item.path)) add(dir, true)
  }
  const rows: TreeRow[] = []
  const walk = (dir: string, depth: number) => {
    const list = [...(children.get(dir) ?? [])].sort(([a, aDir], [b, bDir]) =>
      aDir !== bDir ? (aDir ? -1 : 1) : collator.compare(baseName(a), baseName(b)),
    )
    for (const [path, isDir] of list) {
      const name = baseName(path)
      const expanded = isDir && children.has(path) && !collapsed?.has(path)
      rows.push({ kind: 'entry', path, name, depth, entry: { name, dir: isDir, link: false, broken: false }, expanded, match: match(name) })
      if (expanded) walk(path, depth + 1)
    }
  }
  walk('', 0)
  return rows
}
