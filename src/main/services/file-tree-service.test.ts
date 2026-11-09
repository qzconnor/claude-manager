import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { FileTreeService, parseGitStatus } from './file-tree-service'

const z = (...tokens: string[]) => tokens.map((t) => `${t}\0`).join('')

describe('parseGitStatus', () => {
  it('reads the branch and how far it is from its upstream', () => {
    const status = parseGitStatus(
      z('# branch.oid 1234567890abcdef', '# branch.head feature/tree', '# branch.upstream origin/feature/tree', '# branch.ab +2 -1'),
      '',
      '',
    )
    expect(status).toMatchObject({ branch: 'feature/tree', commit: '1234567', upstream: 'origin/feature/tree', ahead: 2, behind: 1 })
  })

  it('knows a detached HEAD and a repository without commits', () => {
    expect(parseGitStatus(z('# branch.oid abcdef1234', '# branch.head (detached)'), '', '')).toMatchObject({ branch: null, commit: 'abcdef1' })
    expect(parseGitStatus(z('# branch.oid (initial)', '# branch.head main'), '', '')).toMatchObject({ branch: 'main', commit: null })
  })

  it('reads changed, renamed, conflicting, untracked and ignored paths with spaces', () => {
    const status = parseGitStatus(
      z(
        '1 .M N... 100644 100644 100644 aaa bbb src/a file.ts',
        '1 A. N... 000000 100644 100644 000 ccc src/new.ts',
        '1 D. N... 100644 000000 000000 ddd 000 gone.ts',
        '2 R. N... 100644 100644 100644 eee eee R100 src/renamed.ts',
        'src/old.ts',
        'u UU N... 100644 100644 100644 100644 f1 f2 f3 conflict.ts',
        '? notes/',
        '! node_modules/',
        '! debug.log',
      ),
      z('3\t1\tsrc/a file.ts', '-\t-\tgone.ts', '5\t0\t', 'src/old.ts', 'src/renamed.ts'),
      '',
    )
    expect(status.files).toEqual({
      'src/a file.ts': { status: 'modified', staged: false, added: 3, removed: 1 },
      'src/new.ts': { status: 'added', staged: true, added: null, removed: null },
      'gone.ts': { status: 'deleted', staged: true, added: null, removed: null },
      'src/renamed.ts': { status: 'renamed', staged: true, added: 5, removed: 0 },
      'conflict.ts': { status: 'conflict', staged: false, added: null, removed: null },
      'notes/': { status: 'untracked', staged: false, added: null, removed: null },
    })
    expect(status.ignored).toEqual(['node_modules/', 'debug.log'])
  })

  it('makes the paths relative to a folder inside the repository', () => {
    const status = parseGitStatus(z('1 .M N... 1 1 1 a b app/src/x.ts', '? other/y.ts', '! app/out/'), z('1\t2\tapp/src/x.ts'), 'app/')
    expect(status.files).toEqual({ 'src/x.ts': { status: 'modified', staged: false, added: 1, removed: 2 } })
    expect(status.ignored).toEqual(['out/'])
  })
})

describe('FileTreeService.list', () => {
  let dir: string
  const service = new FileTreeService()

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'file-tree-'))
  })
  afterEach(async () => {
    service.dispose()
    await rm(dir, { recursive: true, force: true })
  })

  it('lists folders first, sorts numbers by value and leaves out .git', async () => {
    await mkdir(join(dir, '.git'))
    await mkdir(join(dir, 'src'))
    await writeFile(join(dir, 'file10.txt'), '')
    await writeFile(join(dir, 'file2.txt'), '')
    await writeFile(join(dir, 'B.md'), '')
    const { entries, omitted } = await service.list(dir)
    expect(entries.map((e) => e.name)).toEqual(['src', 'B.md', 'file2.txt', 'file10.txt'])
    expect(entries[0]).toEqual({ name: 'src', dir: true, link: false, broken: false })
    expect(omitted).toBe(0)
  })

  it('follows links to tell folders from files and marks broken ones', async () => {
    await mkdir(join(dir, 'target'))
    try {
      await symlink(join(dir, 'target'), join(dir, 'linked'), 'junction')
      await symlink(join(dir, 'missing'), join(dir, 'dangling'), 'file')
    } catch {
      // Creating file links needs developer mode on Windows.
      return
    }
    const { entries } = await service.list(dir)
    expect(entries.find((e) => e.name === 'linked')).toEqual({ name: 'linked', dir: true, link: true, broken: false })
    expect(entries.find((e) => e.name === 'dangling')).toEqual({ name: 'dangling', dir: false, link: true, broken: true })
  })
})
