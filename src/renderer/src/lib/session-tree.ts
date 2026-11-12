import type { SessionSummary } from '@shared/types'
import { pathSegments, workspaceOf } from '@shared/workspaces'
import { shortenPath } from './format'
import { folderKey, splitFolder } from './recent-folders'

/** How the folders of the session list are ordered. */
export type SessionSort = 'recent' | 'name' | 'size' | 'count'

/**
 * A folder in the session list with its sessions, of all accounts: a project of a workspace or of a
 * start folder (with the folders in it that sessions ran in), or a folder of its own.
 */
export interface SessionProject {
  /** Unique in the list. */
  id: string
  /** Where the sessions ran; null when none of them knows. */
  path: string | null
  /** Last part of the path, e.g. `claude-manager`; `~` for the home folder. */
  name: string
  /** Where the folder lies, shortened with `~`; empty in a workspace or start folder, where it lies in the folder above. */
  parent: string
  /** The sessions in the folder and in all folders below it. */
  sessions: SessionSummary[]
  /** The sessions in the folder itself. */
  own: SessionSummary[]
  /**
   * The folders in it that sessions ran in, also deeper down: every level between the folder and its
   * sessions is one, however deep. Only in a workspace or start folder; a folder of its own has none.
   */
  folders: SessionProject[]
  /** ISO time of the newest session; null without sessions. */
  updatedAt: string | null
  sizeBytes: number
}

/**
 * A folder whose subfolders the list shows as projects: a workspace, or a start folder (where new
 * sessions start without a folder chosen, e.g. the Downloads folder), which the list keeps apart.
 */
export interface SessionRoot {
  kind: 'workspace' | 'start'
  id: string
  path: string
  name: string
  /** Where the folder lies, shortened with `~`. */
  parent: string
  projects: SessionProject[]
  /** Sessions in the folder itself. */
  sessions: SessionSummary[]
  /** Sessions in the folder and its projects. */
  count: number
  sizeBytes: number
  updatedAt: string | null
}

/** The session list: workspaces › projects › sessions, the other folders and the start folders. */
export interface SessionTree {
  /** In the order of `TreeRoots.workspaces`, which the user sets by dragging. */
  workspaces: SessionRoot[]
  /** Folders in no workspace and no start folder. */
  folders: SessionProject[]
  /** Start folders sessions ran in. */
  starts: SessionRoot[]
}

/** The folders the list takes apart into projects. */
export interface TreeRoots {
  /** The workspaces, with the names of their subfolders. */
  workspaces: readonly { path: string; projects: readonly string[] }[]
  /** Where new sessions start without a folder chosen. */
  startFolders: readonly string[]
}

/** Where a folder shows in the list: the root (workspace or start folder) and the folder in it. */
export interface Placement {
  /** Null for a folder of its own. */
  rootId: string | null
  /** The folder itself, maybe deep in a project; null for the sessions of a root's own folder. */
  projectId: string | null
  /** The folders from the root's project down to `projectId`, the outermost first; empty without one. */
  folderIds: string[]
}

/** The section of the folders in no workspace. */
export const FOLDERS_SECTION_ID = 'folders'
/** The pinned sessions on top of the list. */
export const PINNED_SECTION_ID = 'pinned'

/** The pinned sessions, workspaces and the other folders start open, start folders and folders closed (for an overview). */
export function opensByDefault(id: string): boolean {
  return id === PINNED_SECTION_ID || id === FOLDERS_SECTION_ID || id.startsWith('workspace\n')
}

/**
 * The folder a session belongs to: where it ran, for a session in a worktree (`claude --worktree`)
 * the folder it was started in. Null when the session doesn't record it.
 */
export function sessionFolder(session: Pick<SessionSummary, 'cwd' | 'worktree'>): string | null {
  return session.worktree?.originalCwd.trim() || session.cwd?.trim() || null
}

/** How the list names a folder: its last part, and where it lies (shortened with `~`). */
export function describeFolder(path: string | null, projectKey: string, home?: string | null): { name: string; parent: string } {
  if (!path) return { name: 'Unbekannter Ordner', parent: projectKey }
  const short = shortenPath(path, home)
  if (short === '~') return { name: '~', parent: path }
  const { name, parent } = splitFolder(short)
  return { name, parent }
}

const byName = new Intl.Collator('de', { sensitivity: 'base', numeric: true })

const rootId = (kind: SessionRoot['kind'], path: string) => `${kind}\n${folderKey(path)}`
const folderId = (path: string | null, projectKey: string) => `folder\n${path ? folderKey(path) : `#${projectKey}`}`

/** `name` in the folder `root`, with the root's kind of separator. */
export function childPath(root: string, name: string): string {
  const separator = root.includes('\\') || /^[a-z]:/i.test(root) ? '\\' : '/'
  return /[\\/]$/.test(root) ? `${root}${name}` : `${root}${separator}${name}`
}

/**
 * Finds the root a folder lies in and the folders between them: the project in the root, the folders
 * in it, down to the folder itself (`chain`, empty for the root's own folder).
 */
function placer(roots: TreeRoots) {
  const workspaces = roots.workspaces.map((w) => w.path)
  const starts = roots.startFolders.filter((s) => s.trim())
  const listed = new Map(
    roots.workspaces.flatMap((w) => w.projects.map((name) => [folderKey(childPath(w.path, name)), name] as const)),
  )

  return (path: string | null) => {
    if (!path) return null
    const workspace = workspaceOf(path, workspaces)
    const kind = workspace ? 'workspace' : 'start'
    const root = workspace ?? workspaceOf(path, starts)
    if (!root) return null
    const [first, ...deeper] = pathSegments(path).slice(pathSegments(folderKey(root)).length)
    if (!first) return { kind, root, chain: [] as string[] } as const
    // The project as it is spelled on disk, not as some session wrote it; below it as the session wrote it.
    let folder = childPath(root, listed.get(folderKey(childPath(root, first))) ?? first)
    const chain = [folder]
    for (const segment of deeper) {
      folder = childPath(folder, segment)
      chain.push(folder)
    }
    return { kind, root, chain } as const
  }
}

/** Where the list shows sessions of the folder `path` (null: unknown, by Claude's `projectKey`). */
export function placeFolder(path: string | null, projectKey: string, roots: TreeRoots): Placement {
  const place = placer(roots)(path)
  if (!place) {
    const id = folderId(path, projectKey)
    return { rootId: null, projectId: id, folderIds: [id] }
  }
  const folderIds = place.chain.map((folder) => folderId(folder, ''))
  return { rootId: rootId(place.kind, place.root), projectId: folderIds.at(-1) ?? null, folderIds }
}

/** Where the list shows a session. */
export function placeSession(session: SessionSummary, roots: TreeRoots): Placement {
  return placeFolder(sessionFolder(session), session.projectKey, roots)
}

interface Bucket {
  id: string
  path: string | null
  projectKey: string
  sessions: SessionSummary[]
  /** The folders in it sessions ran in, by id; only in a root. */
  folders: Map<string, Bucket>
}

function newBucket(path: string | null, projectKey: string): Bucket {
  return { id: folderId(path, projectKey), path, projectKey, sessions: [], folders: new Map() }
}

/**
 * The sessions as the list shows them: workspaces with all their subfolders as projects (also those
 * without sessions while `showEmpty`, so sessions can start there), sessions in the workspace's own
 * folder beside them; in a project the folders sessions ran in, level by level down to them; the other
 * folders by themselves; start folders like workspaces, but only with the projects sessions ran in.
 * Workspaces keep their order; folders are ordered by `sort`, ties by the newest session and the name;
 * their sessions newest first, or the largest first when sorting by size.
 */
export function buildSessionTree(
  sessions: readonly SessionSummary[],
  roots: TreeRoots,
  options: { sort: SessionSort; home?: string | null; showEmpty: boolean },
): SessionTree {
  const place = placer(roots)
  const rootBuckets = new Map<string, { kind: SessionRoot['kind']; path: string; own: SessionSummary[]; projects: Map<string, Bucket> }>()
  const folders = new Map<string, Bucket>()

  for (const workspace of roots.workspaces) {
    const projects = new Map<string, Bucket>()
    for (const name of workspace.projects) {
      const project = newBucket(childPath(workspace.path, name), '')
      projects.set(project.id, project)
    }
    rootBuckets.set(rootId('workspace', workspace.path), { kind: 'workspace', path: workspace.path, own: [], projects })
  }

  for (const session of sessions) {
    const path = sessionFolder(session)
    const placed = place(path)
    if (!placed) {
      const id = folderId(path, session.projectKey)
      let folder = folders.get(id)
      if (!folder) {
        folder = newBucket(path, session.projectKey)
        folders.set(id, folder)
      }
      folder.sessions.push(session)
      continue
    }
    const id = rootId(placed.kind, placed.root)
    let root = rootBuckets.get(id)
    if (!root) {
      root = { kind: placed.kind, path: placed.root, own: [], projects: new Map() }
      rootBuckets.set(id, root)
    }
    // Level by level: the project, the folders in it, the folder the session ran in.
    let level = root.projects
    let folder: Bucket | null = null
    for (const path of placed.chain) {
      const id = folderId(path, '')
      let next = level.get(id)
      if (!next) {
        next = newBucket(path, session.projectKey)
        level.set(id, next)
      }
      folder = next
      level = next.folders
    }
    if (folder) folder.sessions.push(session)
    else root.own.push(session)
  }

  const { sort, home, showEmpty } = options
  const sortSessions = (list: SessionSummary[]) => {
    list.sort(newestFirst)
    if (sort === 'size') list.sort((a, b) => b.sizeBytes - a.sizeBytes || newestFirst(a, b))
    return list
  }

  const compare = comparer(sort)
  const toProject = (bucket: Bucket, inRoot: boolean): SessionProject => {
    const own = sortSessions(bucket.sessions)
    const folders = [...bucket.folders.values()].map((f) => toProject(f, true)).sort(compare)
    const list = folders.length > 0 ? sortSessions([...own, ...folders.flatMap((f) => f.sessions)]) : own
    // A folder of its own is spelled as its newest session writes it, e.g. after renaming its case.
    const path = inRoot ? bucket.path : ([...own].sort(newestFirst).map(sessionFolder).find((p) => p !== null) ?? bucket.path)
    const described = describeFolder(path, bucket.projectKey, home)
    return {
      id: bucket.id,
      path,
      name: described.name,
      parent: inRoot ? '' : described.parent,
      sessions: list,
      own,
      folders,
      updatedAt: newestOf(list),
      sizeBytes: list.reduce((sum, s) => sum + s.sizeBytes, 0),
    }
  }

  const result: SessionTree = { workspaces: [], folders: [], starts: [] }
  for (const [id, bucket] of rootBuckets) {
    const projects = [...bucket.projects.values()]
      .map((p) => toProject(p, true))
      .filter((p) => p.sessions.length > 0 || (showEmpty && bucket.kind === 'workspace'))
      .sort(compare)
    const own = sortSessions(bucket.own)
    const all = [...own, ...projects.flatMap((p) => p.sessions)]
    if (all.length === 0 && !(showEmpty && bucket.kind === 'workspace')) continue
    const root: SessionRoot = {
      kind: bucket.kind,
      id,
      path: bucket.path,
      ...describeFolder(bucket.path, '', home),
      projects,
      sessions: own,
      count: all.length,
      sizeBytes: all.reduce((sum, s) => sum + s.sizeBytes, 0),
      updatedAt: newestOf(all),
    }
    ;(root.kind === 'workspace' ? result.workspaces : result.starts).push(root)
  }

  // The workspaces are already in their order: their buckets were made first, from `roots.workspaces`.
  const startOrder = new Map(roots.startFolders.map((path, i) => [rootId('start', path), i]))
  result.starts.sort((a, b) => (startOrder.get(a.id) ?? 0) - (startOrder.get(b.id) ?? 0))
  result.folders = [...folders.values()].map((f) => toProject(f, false)).sort(compare)
  return result
}

/** The folders and all folders in them, each before the ones in it. */
export function allFolders(folders: readonly SessionProject[]): SessionProject[] {
  return folders.flatMap((f) => [f, ...allFolders(f.folders)])
}

/** How many sessions a folder shows at first, and how many more each „Weitere … anzeigen“ adds. */
export const PAGE_SIZE = 50

/** The sessions a folder or section shows of its own: the first `PAGE_SIZE`, or as many as `pages` holds for its id. */
export function pageOf<T>(sessions: readonly T[], id: string, pages: ReadonlyMap<string, number>): T[] {
  return sessions.slice(0, pages.get(id) ?? PAGE_SIZE)
}

/**
 * The sessions one sees in the list, top to bottom: those of open sections and open folders, and of
 * each only as many as it shows (see `pageOf`). A Shift+click range takes these, never sessions hidden
 * behind „Weitere … anzeigen“ in the middle of it.
 */
export function sessionsInView(
  sections: readonly { id: string; projects: readonly SessionProject[]; sessions: readonly SessionSummary[] }[],
  isOpen: (id: string) => boolean,
  openFolders: ReadonlySet<string>,
  pages: ReadonlyMap<string, number>,
): SessionSummary[] {
  // As a folder shows them: the folders in it first, then its own sessions.
  const inFolder = (p: SessionProject): SessionSummary[] =>
    openFolders.has(p.id) ? [...p.folders.flatMap(inFolder), ...pageOf(p.own, p.id, pages)] : []
  return sections.filter((s) => isOpen(s.id)).flatMap((s) => [...s.projects.flatMap(inFolder), ...pageOf(s.sessions, s.id, pages)])
}

function newestFirst(a: { updatedAt: string }, b: { updatedAt: string }): number {
  return b.updatedAt.localeCompare(a.updatedAt)
}

function newestOf(sessions: readonly SessionSummary[]): string | null {
  return sessions.reduce<string | null>((newest, s) => (newest === null || s.updatedAt > newest ? s.updatedAt : newest), null)
}

interface Sortable {
  name: string
  parent: string
  updatedAt: string | null
  sizeBytes: number
  sessions: { length: number }
}

/** Orders folders by `sort`, then the newest first (those without sessions last), then by name. */
function comparer(sort: SessionSort): (a: Sortable, b: Sortable) => number {
  const recent = (a: Sortable, b: Sortable) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? '')
  const name = (a: Sortable, b: Sortable) => byName.compare(a.name, b.name) || byName.compare(a.parent, b.parent)
  const first: Record<SessionSort, (a: Sortable, b: Sortable) => number> = {
    recent,
    name,
    size: (a, b) => b.sizeBytes - a.sizeBytes,
    count: (a, b) => b.sessions.length - a.sessions.length,
  }
  return (a, b) => first[sort](a, b) || recent(a, b) || name(a, b)
}
