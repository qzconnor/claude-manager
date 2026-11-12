import { describe, expect, it } from 'vitest'
import type { SessionSummary } from '@shared/types'
import {
  allFolders,
  buildSessionTree,
  FOLDERS_SECTION_ID,
  opensByDefault,
  PINNED_SECTION_ID,
  PAGE_SIZE,
  pageOf,
  placeFolder,
  placeSession,
  sessionsInView,
  type SessionProject,
  type SessionSort,
  type TreeRoots,
} from './session-tree'

const HOME = 'C:\\Users\\me'

function session(id: string, patch: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id,
    accountId: 'a',
    projectKey: 'C--Users-me',
    cwd: HOME,
    worktree: null,
    title: id,
    name: null,
    pinned: false,
    tags: [],
    firstPrompt: null,
    lastPrompt: null,
    gitBranch: null,
    model: null,
    messageCount: 1,
    messageCountExact: true,
    createdAt: '2026-11-01T10:00:00.000Z',
    updatedAt: '2026-11-01T10:00:00.000Z',
    sizeBytes: 100,
    version: null,
    ...patch,
  }
}

const app = 'F:\\Projekte\\Apps\\claude-manager'
const NO_ROOTS: TreeRoots = { workspaces: [], startFolders: [] }

/** The folders of their own, as the list showed them before there were workspaces. */
function folders(list: SessionSummary[], sort: SessionSort = 'recent', home?: string) {
  return buildSessionTree(list, NO_ROOTS, { sort, home, showEmpty: true }).folders
}

describe('buildSessionTree: folders of their own', () => {
  it('puts the sessions of one folder together, of all accounts, newest folder and session first', () => {
    const projects = folders(
      [
        session('old-app', { cwd: app, updatedAt: '2026-11-01T08:00:00.000Z' }),
        session('home', { updatedAt: '2026-11-02T08:00:00.000Z' }),
        session('new-app', { cwd: app, accountId: 'b', updatedAt: '2026-11-03T08:00:00.000Z' }),
      ],
      'recent',
      HOME,
    )
    expect(projects.map((p) => [p.name, p.parent, p.sessions.map((s) => s.id)])).toEqual([
      ['claude-manager', 'F:\\Projekte\\Apps', ['new-app', 'old-app']],
      ['~', HOME, ['home']],
    ])
    expect(projects[0]).toMatchObject({ path: app, updatedAt: '2026-11-03T08:00:00.000Z', sizeBytes: 200 })
  })

  it('treats a Windows folder in another case or with a trailing slash as the same', () => {
    const projects = folders([
      session('one', { cwd: 'f:\\projekte\\apps\\claude-manager\\', updatedAt: '2026-11-01T08:00:00.000Z' }),
      session('two', { cwd: app, updatedAt: '2026-11-02T08:00:00.000Z' }),
    ])
    expect(projects).toHaveLength(1)
    // As the newest session writes it.
    expect(projects[0]?.path).toBe(app)
  })

  it('shortens folders in the home folder', () => {
    const [project] = folders([session('dl', { cwd: `${HOME}\\Downloads` })], 'recent', HOME)
    expect(project).toMatchObject({ name: 'Downloads', parent: '~' })
  })

  it('puts a session in a worktree under the folder it was started in', () => {
    const worktree = {
      name: 'login',
      branch: 'worktree-login',
      path: `${app}\\.claude\\worktrees\\login`,
      originalCwd: app,
    }
    const projects = folders([
      session('in-worktree', { cwd: worktree.path, worktree, updatedAt: '2026-11-03T08:00:00.000Z' }),
      session('plain', { cwd: app, updatedAt: '2026-11-01T08:00:00.000Z' }),
    ])
    expect(projects.map((p) => [p.path, p.sessions.map((s) => s.id)])).toEqual([[app, ['in-worktree', 'plain']]])
  })

  it('groups sessions without a folder by their project key', () => {
    const projects = folders([session('x', { cwd: null, projectKey: 'one' }), session('y', { cwd: null, projectKey: 'two' })])
    expect(projects.map((p) => [p.path, p.name, p.parent])).toEqual([
      [null, 'Unbekannter Ordner', 'one'],
      [null, 'Unbekannter Ordner', 'two'],
    ])
  })

  it('sorts by name, size or number of sessions', () => {
    const list = [
      session('b1', { cwd: 'C:\\b', sizeBytes: 50, updatedAt: '2026-11-03T08:00:00.000Z' }),
      session('b2', { cwd: 'C:\\b', sizeBytes: 900, updatedAt: '2026-11-02T08:00:00.000Z' }),
      session('a1', { cwd: 'C:\\A', sizeBytes: 2000, updatedAt: '2026-11-01T08:00:00.000Z' }),
      session('c1', { cwd: 'C:\\c10', sizeBytes: 10, updatedAt: '2026-11-04T08:00:00.000Z' }),
      session('c2', { cwd: 'C:\\c9', sizeBytes: 10, updatedAt: '2026-11-05T08:00:00.000Z' }),
    ]
    const names = (sort: SessionSort) => folders(list, sort).map((p) => p.name)
    expect(names('name')).toEqual(['A', 'b', 'c9', 'c10'])
    expect(names('size')).toEqual(['A', 'b', 'c9', 'c10'])
    expect(names('count')).toEqual(['b', 'c9', 'c10', 'A'])
    expect(names('recent')).toEqual(['c9', 'c10', 'b', 'A'])
    // By size, the largest session of a folder comes first.
    expect(folders(list, 'size')[1]?.sessions.map((s) => s.id)).toEqual(['b2', 'b1'])
    expect(folders(list, 'recent')[2]?.sessions.map((s) => s.id)).toEqual(['b1', 'b2'])
  })
})

describe('buildSessionTree: workspaces and start folders', () => {
  const web = 'F:\\Webseiten'
  const downloads = `${HOME}\\Downloads`
  const roots: TreeRoots = {
    workspaces: [{ path: web, projects: ['websiteA', 'websiteB', 'websiteC'] }],
    startFolders: [downloads],
  }
  const list = [
    session('a1', { cwd: `${web}\\websiteA`, updatedAt: '2026-11-03T08:00:00.000Z' }),
    // Deeper in a project, with another account and another spelling: the same project.
    session('a2', { cwd: 'f:/webseiten/WEBSITEA/src', accountId: 'b', updatedAt: '2026-11-04T08:00:00.000Z' }),
    session('b1', { cwd: `${web}\\websiteB`, updatedAt: '2026-11-02T08:00:00.000Z' }),
    session('ws', { cwd: web, updatedAt: '2026-11-01T08:00:00.000Z' }),
    session('dl', { cwd: downloads, updatedAt: '2026-11-05T08:00:00.000Z' }),
    session('zip', { cwd: `${downloads}\\entpackt`, updatedAt: '2026-11-06T08:00:00.000Z' }),
    session('app', { cwd: app, updatedAt: '2026-11-07T08:00:00.000Z' }),
  ]

  it('shows workspaces with all their subfolders as projects, the rest apart', () => {
    const tree = buildSessionTree(list, roots, { sort: 'recent', home: HOME, showEmpty: true })
    expect(tree.workspaces).toHaveLength(1)
    const [workspace] = tree.workspaces
    expect(workspace).toMatchObject({ kind: 'workspace', path: web, name: 'Webseiten', count: 4, updatedAt: '2026-11-04T08:00:00.000Z' })
    expect(workspace?.projects.map((p) => [p.name, p.path, p.parent, p.sessions.map((s) => s.id)])).toEqual([
      ['websiteA', `${web}\\websiteA`, '', ['a2', 'a1']],
      ['websiteB', `${web}\\websiteB`, '', ['b1']],
      // Without sessions, so one can start there.
      ['websiteC', `${web}\\websiteC`, '', []],
    ])
    expect(workspace?.sessions.map((s) => s.id)).toEqual(['ws'])
    // The session deeper in the project is in its folder there, spelled as the project on disk.
    const [websiteA] = workspace?.projects ?? []
    expect(websiteA?.own.map((s) => s.id)).toEqual(['a1'])
    expect(websiteA?.folders.map((f) => [f.name, f.path, f.parent, f.own.map((s) => s.id)])).toEqual([
      ['src', `${web}\\websiteA\\src`, '', ['a2']],
    ])

    expect(tree.folders.map((p) => p.path)).toEqual([app])

    expect(tree.starts).toHaveLength(1)
    expect(tree.starts[0]).toMatchObject({ kind: 'start', path: downloads, count: 2 })
    expect(tree.starts[0]?.sessions.map((s) => s.id)).toEqual(['dl'])
    expect(tree.starts[0]?.projects.map((p) => p.name)).toEqual(['entpackt'])
  })

  it('leaves out empty projects and workspaces while searching or filtering', () => {
    const tree = buildSessionTree([list[0]!], roots, { sort: 'recent', showEmpty: false })
    expect(tree.workspaces[0]?.projects.map((p) => p.name)).toEqual(['websiteA'])
    expect(buildSessionTree([], roots, { sort: 'recent', showEmpty: false }).workspaces).toEqual([])
    // A new workspace shows without sessions, a start folder doesn't.
    const empty = buildSessionTree([], roots, { sort: 'recent', showEmpty: true })
    expect(empty.workspaces).toHaveLength(1)
    expect(empty.starts).toEqual([])
  })

  it('puts a folder in a workspace in the start folder under the workspace', () => {
    const nested: TreeRoots = { workspaces: [{ path: `${downloads}\\Kunden`, projects: [] }], startFolders: [downloads] }
    const tree = buildSessionTree([session('k', { cwd: `${downloads}\\Kunden\\acme` })], nested, { sort: 'recent', showEmpty: false })
    expect(tree.workspaces[0]?.projects.map((p) => p.name)).toEqual(['acme'])
    expect(tree.starts).toEqual([])
  })

  it('shows a project made a workspace by itself, with its sessions', () => {
    // As the main process lists them: the inner workspace is no project of the outer one.
    const inner: TreeRoots = {
      workspaces: [
        { path: 'F:\\Kunden', projects: ['acme'] },
        { path: 'F:\\Kunden\\amsplugins', projects: ['shop'] },
      ],
      startFolders: [],
    }
    const tree = buildSessionTree(
      [
        session('own', { cwd: 'F:\\Kunden\\amsplugins' }),
        session('deep', { cwd: 'F:\\Kunden\\amsplugins\\shop\\src' }),
        session('outer', { cwd: 'F:\\Kunden\\acme' }),
      ],
      inner,
      { sort: 'recent', showEmpty: true },
    )
    expect(tree.workspaces.map((w) => w.name)).toEqual(['Kunden', 'amsplugins'])
    expect(tree.workspaces[0]?.projects.map((p) => p.name)).toEqual(['acme'])
    expect(tree.workspaces[0]?.count).toBe(1)
    expect(tree.workspaces[1]?.sessions.map((s) => s.id)).toEqual(['own'])
    expect(tree.workspaces[1]?.projects.map((p) => [p.name, p.sessions.map((s) => s.id)])).toEqual([['shop', ['deep']]])
  })

  it('keeps the workspaces in their order, whatever the sort', () => {
    const two: TreeRoots = { workspaces: [{ path: 'F:\\Zeta', projects: [] }, { path: 'F:\\Alpha', projects: [] }], startFolders: [] }
    const sessions = [
      session('z', { cwd: 'F:\\Zeta', updatedAt: '2026-11-01T08:00:00.000Z' }),
      session('a', { cwd: 'F:\\Alpha\\x', updatedAt: '2026-11-09T08:00:00.000Z', sizeBytes: 900 }),
      session('a2', { cwd: 'F:\\Alpha\\x', updatedAt: '2026-11-08T08:00:00.000Z' }),
    ]
    for (const sort of ['recent', 'name', 'size', 'count'] as const) {
      expect(buildSessionTree(sessions, two, { sort, showEmpty: true }).workspaces.map((w) => w.name)).toEqual(['Zeta', 'Alpha'])
    }
  })

  it('places a folder where the list shows it, with the folders above it', () => {
    expect(placeFolder(`${web}\\websiteA`, 'k', roots)).toEqual(placeSession(session('x', { cwd: 'F:\\WEBSEITEN\\websiteA' }), roots))
    expect(placeFolder(`${web}\\websiteA\\src\\app`, 'k', roots)).toEqual({
      rootId: 'workspace\nf:\\webseiten',
      projectId: 'folder\nf:\\webseiten\\websitea\\src\\app',
      folderIds: [
        'folder\nf:\\webseiten\\websitea',
        'folder\nf:\\webseiten\\websitea\\src',
        'folder\nf:\\webseiten\\websitea\\src\\app',
      ],
    })
    expect(placeFolder(web, 'k', roots)).toMatchObject({ projectId: null, folderIds: [] })
    expect(placeFolder(app, 'k', roots).rootId).toBeNull()
    expect(placeFolder(null, 'k', roots)).toEqual({ rootId: null, projectId: 'folder\n#k', folderIds: ['folder\n#k'] })
  })

  it('shows every folder between a project and its sessions, however deep', () => {
    const root: TreeRoots = { workspaces: [{ path: 'F:\\Projekte', projects: ['Apps'] }], startFolders: [] }
    const tree = buildSessionTree(
      [
        session('deep', { cwd: 'F:\\Projekte\\Apps\\claude-manager\\src\\main', updatedAt: '2026-11-05T08:00:00.000Z' }),
        session('app', { cwd: 'F:\\Projekte\\Apps\\claude-manager', updatedAt: '2026-11-04T08:00:00.000Z' }),
        session('other', { cwd: 'F:\\Projekte\\Apps\\photocraft', updatedAt: '2026-11-03T08:00:00.000Z' }),
        session('apps', { cwd: 'F:\\Projekte\\Apps', updatedAt: '2026-11-02T08:00:00.000Z' }),
      ],
      root,
      { sort: 'recent', showEmpty: false },
    )
    const shape = (f: SessionProject): unknown => [f.name, f.own.map((s) => s.id), f.folders.map(shape)]
    const [apps] = tree.workspaces[0]?.projects ?? []
    expect(apps && shape(apps)).toEqual([
      'Apps',
      ['apps'],
      [
        ['claude-manager', ['app'], [['src', [], [['main', ['deep'], []]]]]],
        ['photocraft', ['other'], []],
      ],
    ])
    // A folder counts the sessions below it too.
    expect(apps?.sessions.map((s) => s.id)).toEqual(['deep', 'app', 'other', 'apps'])
    expect(apps?.folders[0]).toMatchObject({ updatedAt: '2026-11-05T08:00:00.000Z', sizeBytes: 200 })
    expect(tree.workspaces[0]?.count).toBe(4)
    expect(allFolders(tree.workspaces[0]?.projects ?? []).map((f) => f.name)).toEqual(['Apps', 'claude-manager', 'src', 'main', 'photocraft'])
  })
})

describe('sessionsInView', () => {
  const root: TreeRoots = { workspaces: [{ path: 'F:\\Projekte', projects: ['Apps'] }], startFolders: [] }
  // 60 sessions in a project, the newest first, and one in the workspace's own folder below them.
  const many = Array.from({ length: 60 }, (_, i) =>
    session(`s${i}`, { cwd: 'F:\\Projekte\\Apps', updatedAt: new Date(Date.UTC(2026, 10, 2) - i * 60_000).toISOString() }),
  )
  const tree = buildSessionTree([...many, session('own', { cwd: 'F:\\Projekte' })], root, { sort: 'recent', showEmpty: false })
  const sections = tree.workspaces.map((w) => ({ id: w.id, projects: w.projects, sessions: w.sessions }))
  const apps = tree.workspaces[0]?.projects[0]
  const ids = (list: SessionSummary[]) => list.map((s) => s.id)

  it('takes only the sessions a folder shows, not those behind „Weitere … anzeigen“', () => {
    const inView = sessionsInView(sections, () => true, new Set([apps?.id ?? '']), new Map())
    expect(ids(inView)).toEqual([...many.slice(0, PAGE_SIZE).map((s) => s.id), 'own'])
    // Shown further, they are in view too.
    const further = sessionsInView(sections, () => true, new Set([apps?.id ?? '']), new Map([[apps?.id ?? '', 100]]))
    expect(ids(further)).toEqual([...ids(many), 'own'])
  })

  it('leaves out closed folders and sections', () => {
    expect(ids(sessionsInView(sections, () => true, new Set(), new Map()))).toEqual(['own'])
    expect(sessionsInView(sections, () => false, new Set([apps?.id ?? '']), new Map())).toEqual([])
  })

  it('shows a page of a section’s own sessions too', () => {
    expect(pageOf(['a', 'b', 'c'], 'x', new Map([['x', 2]]))).toEqual(['a', 'b'])
    expect(pageOf(ids(many), 'x', new Map())).toHaveLength(PAGE_SIZE)
  })
})

describe('opensByDefault', () => {
  it('opens the pinned sessions, the workspaces and the other folders, not the start folders and folders', () => {
    expect(opensByDefault(PINNED_SECTION_ID)).toBe(true)
    expect(opensByDefault(FOLDERS_SECTION_ID)).toBe(true)
    expect(opensByDefault('workspace\nC:\\dev')).toBe(true)
    expect(opensByDefault('start\nC:\\dev')).toBe(false)
    expect(opensByDefault('C--dev')).toBe(false)
  })
})
