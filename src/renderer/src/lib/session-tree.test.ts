import { describe, expect, it } from 'vitest'
import type { SessionSummary } from '@shared/types'
import { groupByProject, projectId } from './session-tree'

const HOME = 'C:\\Users\\me'

function session(id: string, patch: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id,
    accountId: 'a',
    projectKey: 'C--Users-me',
    cwd: HOME,
    worktree: null,
    title: id,
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

describe('groupByProject', () => {
  it('puts the sessions of one folder together, newest folder and session first', () => {
    const projects = groupByProject(
      'a',
      [
        session('old-app', { cwd: app, updatedAt: '2026-11-01T08:00:00.000Z' }),
        session('home', { updatedAt: '2026-11-02T08:00:00.000Z' }),
        session('new-app', { cwd: app, updatedAt: '2026-11-03T08:00:00.000Z' }),
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
    const projects = groupByProject(
      'a',
      [
        session('one', { cwd: 'f:\\projekte\\apps\\claude-manager\\', updatedAt: '2026-11-01T08:00:00.000Z' }),
        session('two', { cwd: app, updatedAt: '2026-11-02T08:00:00.000Z' }),
      ],
      'recent',
      HOME,
    )
    expect(projects).toHaveLength(1)
    // As the newest session writes it.
    expect(projects[0]?.path).toBe(app)
  })

  it('shortens folders in the home folder', () => {
    const [project] = groupByProject('a', [session('dl', { cwd: `${HOME}\\Downloads` })], 'recent', HOME)
    expect(project).toMatchObject({ name: 'Downloads', parent: '~' })
  })

  it('puts a session in a worktree under the folder it was started in', () => {
    const worktree = {
      name: 'login',
      branch: 'worktree-login',
      path: `${app}\\.claude\\worktrees\\login`,
      originalCwd: app,
    }
    const projects = groupByProject(
      'a',
      [
        session('in-worktree', { cwd: worktree.path, worktree, updatedAt: '2026-11-03T08:00:00.000Z' }),
        session('plain', { cwd: app, updatedAt: '2026-11-01T08:00:00.000Z' }),
      ],
      'recent',
      HOME,
    )
    expect(projects.map((p) => [p.path, p.sessions.map((s) => s.id)])).toEqual([[app, ['in-worktree', 'plain']]])
  })

  it('groups sessions without a folder by their project key', () => {
    const projects = groupByProject(
      'a',
      [session('x', { cwd: null, projectKey: 'one' }), session('y', { cwd: null, projectKey: 'two' })],
      'recent',
      HOME,
    )
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
    const names = (sort: Parameters<typeof groupByProject>[2]) => groupByProject('a', list, sort).map((p) => p.name)
    expect(names('name')).toEqual(['A', 'b', 'c9', 'c10'])
    expect(names('size')).toEqual(['A', 'b', 'c9', 'c10'])
    expect(names('count')).toEqual(['b', 'c9', 'c10', 'A'])
    expect(names('recent')).toEqual(['c9', 'c10', 'b', 'A'])
    // By size, the largest session of a folder comes first.
    expect(groupByProject('a', list, 'size')[1]?.sessions.map((s) => s.id)).toEqual(['b2', 'b1'])
    expect(groupByProject('a', list, 'recent')[2]?.sessions.map((s) => s.id)).toEqual(['b1', 'b2'])
  })
})

describe('projectId', () => {
  it('differs between accounts', () => {
    expect(projectId('a', { cwd: app, worktree: null, projectKey: 'k' })).not.toBe(projectId('b', { cwd: app, worktree: null, projectKey: 'k' }))
  })
})
