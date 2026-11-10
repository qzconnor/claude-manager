import { describe, expect, it } from 'vitest'
import type { FileEntry, FileListing, GitTreeStatus } from '@shared/types'
import {
  absolutePath,
  ancestors,
  changedFiles,
  filesTree,
  flattenTree,
  folderName,
  gitDecorations,
  parentPath,
  recordKind,
  recordTouch,
  searchTree,
  treeOrder,
  treePathOf,
  untrackedFolders,
} from './file-tree'

const file = (name: string): FileEntry => ({ name, dir: false, link: false, broken: false })
const dir = (name: string): FileEntry => ({ name, dir: true, link: false, broken: false })
const listing = (...entries: FileEntry[]): FileListing => ({ entries, omitted: 0 })

function status(files: GitTreeStatus['files'], ignored: string[] = []): GitTreeStatus {
  return { branch: 'main', commit: 'abc1234', upstream: null, ahead: 0, behind: 0, files, ignored, truncated: false }
}

describe('paths', () => {
  it('splits tree paths', () => {
    expect(parentPath('a/b/c.ts')).toBe('a/b')
    expect(parentPath('c.ts')).toBe('')
    expect(ancestors('a/b/c.ts')).toEqual(['a', 'a/b'])
    expect(ancestors('c.ts')).toEqual([])
  })

  it('names the folder of a path with either separator', () => {
    expect(folderName('C:\\Projekte\\app\\')).toBe('app')
    expect(folderName('/home/me/app')).toBe('app')
    expect(folderName('C:\\')).toBe('C:')
  })

  it('joins a tree path to its folder', () => {
    expect(absolutePath('C:\\repo', 'src/a.ts', '\\')).toBe('C:\\repo\\src\\a.ts')
    expect(absolutePath('C:\\', 'a.ts', '\\')).toBe('C:\\a.ts')
    expect(absolutePath('/repo', '', '/')).toBe('/repo')
    // A folder with slashes on Windows gets backslashes throughout.
    expect(absolutePath('F:/Projekte/repo', 'src/a.ts', '\\')).toBe('F:\\Projekte\\repo\\src\\a.ts')
    expect(absolutePath('F:/Projekte/repo', '', '\\')).toBe('F:\\Projekte\\repo')
  })

  it('finds the tree path of a file Claude names', () => {
    expect(treePathOf('C:\\Repo', 'c:/repo/src/A.ts', true)).toBe('src/A.ts')
    expect(treePathOf('C:\\Repo', 'C:\\Repo', true)).toBe('')
    expect(treePathOf('C:\\Repo', 'C:\\Repository\\a.ts', true)).toBeNull()
    expect(treePathOf('/repo', '/Repo/a.ts', false)).toBeNull()
    expect(treePathOf('/repo/', '/repo/a/b', false)).toBe('a/b')
  })
})

describe('flattenTree', () => {
  it('walks down the open folders', () => {
    const rows = flattenTree({
      listings: new Map([
        ['', listing(dir('src'), dir('docs'), file('README.md'))],
        ['src', listing(file('main.ts'))],
      ]),
      errors: new Map(),
      expanded: new Set(['src', 'docs']),
    })
    expect(rows.map((r) => (r.kind === 'entry' ? `${r.depth}:${r.path}` : `${r.depth}:${r.kind}`))).toEqual([
      '0:src',
      '1:src/main.ts',
      '0:docs',
      // docs is open but not loaded yet
      '1:message',
      '0:README.md',
    ])
  })

  it('leaves out hidden entries and counts what a folder has more', () => {
    const rows = flattenTree({
      listings: new Map([['', { entries: [dir('node_modules'), file('a.ts')], omitted: 3 }]]),
      errors: new Map(),
      expanded: new Set(['node_modules']),
      hidden: (path) => path === 'node_modules',
    })
    expect(rows).toEqual([
      { kind: 'entry', path: 'a.ts', name: 'a.ts', depth: 0, entry: file('a.ts'), expanded: false, match: null },
      { kind: 'more', path: '/\0more', depth: 0, count: 3 },
    ])
  })

  it('shows the error of a folder that could not be read', () => {
    const rows = flattenTree({
      listings: new Map([['', listing(dir('secret'))]]),
      errors: new Map([['secret', 'Zugriff verweigert']]),
      expanded: new Set(['secret']),
    })
    expect(rows[1]).toMatchObject({ kind: 'message', depth: 1, text: 'Zugriff verweigert', error: true })
  })
})

describe('gitDecorations', () => {
  const decorations = gitDecorations(
    status(
      {
        'src/a.ts': { status: 'modified', staged: false, added: 3, removed: 1 },
        'src/deep/gone.ts': { status: 'deleted', staged: true, added: 0, removed: 9 },
        'new/': { status: 'untracked', staged: false, added: null, removed: null },
      },
      ['node_modules/', 'out/', 'debug.log'],
    ),
  )

  it('marks files and the folders they lie in with the strongest state', () => {
    expect(decorations.file('src/a.ts')?.status).toBe('modified')
    expect(decorations.folder('src')).toBe('deleted')
    expect(decorations.folder('src/deep')).toBe('deleted')
    expect(decorations.folder('docs')).toBeNull()
  })

  it('takes everything in an untracked folder as untracked', () => {
    expect(decorations.folder('new')).toBe('untracked')
    expect(decorations.file('new/x/y.ts')?.status).toBe('untracked')
  })

  it('knows ignored files and everything in ignored folders', () => {
    expect(decorations.ignored('node_modules')).toBe(true)
    expect(decorations.ignored('node_modules/vue/index.js')).toBe(true)
    expect(decorations.ignored('debug.log')).toBe(true)
    expect(decorations.ignored('src/a.ts')).toBe(false)
  })

  it('counts the changes', () => {
    expect(decorations.counts).toEqual({ modified: 1, deleted: 1, untracked: 1 })
  })

  it('has no marks outside a repository', () => {
    const none = gitDecorations(null)
    expect(none.file('a.ts')).toBeNull()
    expect(none.ignored('a.ts')).toBe(false)
  })
})

describe('searchTree', () => {
  const paths = ['src/main/index.ts', 'src/renderer/index.html', 'src/renderer/main.ts', 'docs/API.md', 'README.md']

  it('shows the matching files with the folders they lie in, folders first', () => {
    const { rows, matches } = searchTree(paths, 'MAIN')
    expect(matches).toBe(2)
    expect(rows.map((r) => r.path)).toEqual(['src', 'src/main', 'src/renderer', 'src/renderer/main.ts'])
    expect(rows.find((r) => r.path === 'src/renderer/main.ts')).toMatchObject({ match: [0, 4] })
    // A matching folder stays closed: its files didn't match.
    expect(rows.find((r) => r.path === 'src/main')).toMatchObject({ expanded: false, match: [0, 4], entry: { dir: true } })
    expect(rows.find((r) => r.path === 'src')).toMatchObject({ expanded: true, match: null })
  })

  it('matches the path when the query has a slash', () => {
    expect(searchTree(paths, 'renderer/main').rows.map((r) => r.path)).toEqual(['src', 'src/renderer', 'src/renderer/main.ts'])
  })

  it('keeps the best hits', () => {
    const { rows, matches } = searchTree(['a/readme.txt', 'readme.md', 'x/readme'], 'readme', 1)
    expect(matches).toBe(3)
    expect(rows.map((r) => r.path)).toEqual(['x', 'x/readme'])
  })

  it('finds nothing for an empty query', () => {
    expect(searchTree(paths, '  ').rows).toEqual([])
  })
})

describe('filesTree', () => {
  const paths = ['src/b.ts', 'README.md', 'src/deep/a.ts', 'docs/x.md']

  it('shows the files with their folders open, folders first', () => {
    expect(filesTree(paths, new Set()).map((r) => `${r.depth}:${r.path}`)).toEqual([
      '0:docs',
      '1:docs/x.md',
      '0:src',
      '1:src/deep',
      '2:src/deep/a.ts',
      '1:src/b.ts',
      '0:README.md',
    ])
  })

  it('leaves the collapsed folders closed', () => {
    const rows = filesTree(paths, new Set(['src/deep', 'docs']))
    expect(rows.map((r) => r.path)).toEqual(['docs', 'src', 'src/deep', 'src/b.ts', 'README.md'])
    expect(rows.find((r) => r.path === 'src/deep')).toMatchObject({ expanded: false, entry: { dir: true } })
    expect(rows.find((r) => r.path === 'src')).toMatchObject({ expanded: true, match: null })
  })
})

describe('changed files', () => {
  const changed = status({
    'src/a.ts': { status: 'modified', staged: false, added: 1, removed: 0 },
    'old.ts': { status: 'deleted', staged: true, added: 0, removed: 3 },
    'new/': { status: 'untracked', staged: false, added: null, removed: null },
  })

  it('takes the files of folders new as a whole from the list of all files', () => {
    expect(untrackedFolders(changed)).toEqual(['new/'])
    expect(changedFiles(changed, null)).toEqual(['src/a.ts', 'old.ts'])
    expect(changedFiles(changed, ['src/a.ts', 'new/x.ts', 'new/deep/y.ts', 'newer.ts'])).toEqual(['src/a.ts', 'old.ts', 'new/x.ts', 'new/deep/y.ts'])
    expect(changedFiles(null, ['a.ts'])).toEqual([])
  })

  it('orders them as the tree shows them', () => {
    expect(treeOrder(['src/b.ts', 'README.md', 'src/deep/a.ts', 'docs/x.md'])).toEqual(['docs/x.md', 'src/deep/a.ts', 'src/b.ts', 'README.md'])
  })
})

describe('touch records', () => {
  it('keeps when Claude last did each kind', () => {
    const first = recordTouch(undefined, 'read', 1)
    const second = recordTouch(first, 'write', 2)
    expect(recordTouch(second, 'read', 3)).toEqual({ read: 3, write: 2 })
    expect(first).toEqual({ read: 1 })
  })

  it('shows the strongest kind that is not hidden', () => {
    const record = { search: 1, read: 2, write: 3 }
    expect(recordKind(record)).toBe('write')
    expect(recordKind(record, new Set(['write'] as const))).toBe('read')
    expect(recordKind({ search: 1 }, new Set(['search'] as const))).toBeNull()
    expect(recordKind({ commit: 1, read: 2 })).toBe('commit')
  })
})
