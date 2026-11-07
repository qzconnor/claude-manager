import type { SessionSummary } from '@shared/types'
import { shortenPath } from './format'
import { folderKey, splitFolder } from './recent-folders'

/** How the folders of the session list are ordered. */
export type SessionSort = 'recent' | 'name' | 'size' | 'count'

/** The folder sessions of one account ran in: a node of the session list between account and sessions. */
export interface SessionProject {
  /** Unique across accounts. */
  id: string
  accountId: string
  /** Where the sessions ran, as the newest of them wrote it; null when no session knows. */
  path: string | null
  /** Last part of the path, e.g. `claude-manager`; `~` for the home folder. */
  name: string
  /** Where the folder lies, shortened with `~`; for the home folder its full path. */
  parent: string
  sessions: SessionSummary[]
  /** ISO time of the newest session. */
  updatedAt: string
  sizeBytes: number
}

/** Folders compare by `folderKey`, so `F:\Code` and `f:\code\` are one; without a folder, by Claude's project key. */
export function projectId(accountId: string, session: Pick<SessionSummary, 'cwd' | 'projectKey'>): string {
  const folder = session.cwd?.trim() ? folderKey(session.cwd) : `#${session.projectKey}`
  return `${accountId}\n${folder}`
}

const byName = new Intl.Collator('de', { sensitivity: 'base', numeric: true })

const newestFirst = (a: { updatedAt: string }, b: { updatedAt: string }) => b.updatedAt.localeCompare(a.updatedAt)

function describe(path: string | null, projectKey: string, home?: string | null): { name: string; parent: string } {
  if (!path) return { name: 'Unbekannter Ordner', parent: projectKey }
  const short = shortenPath(path, home)
  if (short === '~') return { name: '~', parent: path }
  const { name, parent } = splitFolder(short)
  return { name, parent }
}

/**
 * The sessions of one account by the folder they ran in. Folders are ordered by `sort`, ties by the
 * newest session; their sessions newest first, or the largest first when sorting by size.
 */
export function groupByProject(
  accountId: string,
  sessions: SessionSummary[],
  sort: SessionSort,
  home?: string | null,
): SessionProject[] {
  const byId = new Map<string, SessionSummary[]>()
  for (const session of sessions) {
    const id = projectId(accountId, session)
    const list = byId.get(id)
    if (list) list.push(session)
    else byId.set(id, [session])
  }

  const projects = [...byId].map(([id, list]): SessionProject => {
    list.sort(newestFirst)
    const newest = list[0]!
    // The newest session spells the folder as it is now, e.g. after renaming its case.
    const path = list.find((s) => s.cwd?.trim())?.cwd?.trim() ?? null
    return {
      id,
      accountId,
      path,
      ...describe(path, newest.projectKey, home),
      sessions: sort === 'size' ? [...list].sort((a, b) => b.sizeBytes - a.sizeBytes || newestFirst(a, b)) : list,
      updatedAt: newest.updatedAt,
      sizeBytes: list.reduce((sum, s) => sum + s.sizeBytes, 0),
    }
  })

  const compare: Record<SessionSort, (a: SessionProject, b: SessionProject) => number> = {
    recent: () => 0,
    name: (a, b) => byName.compare(a.name, b.name) || byName.compare(a.parent, b.parent),
    size: (a, b) => b.sizeBytes - a.sizeBytes,
    count: (a, b) => b.sessions.length - a.sessions.length,
  }
  return projects.sort((a, b) => compare[sort](a, b) || newestFirst(a, b))
}
