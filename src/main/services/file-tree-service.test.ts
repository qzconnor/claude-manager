import { execFileSync } from 'node:child_process'
import { chmod, mkdtemp, mkdir, readdir, readFile, rm, stat, symlink, unlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  FileTreeService,
  filterGuard,
  gitStateChange,
  hunkPatch,
  isCommitHash,
  isTreePath,
  MAX_GREP_MATCHES,
  parseCommits,
  parseGitStatus,
  parseGrep,
  parseReviewFiles,
} from './file-tree-service'

describe('isTreePath', () => {
  it('takes paths inside the root, joined with /', () => {
    expect(isTreePath('', 'win32')).toBe(true)
    expect(isTreePath('src/main/index.ts', 'win32')).toBe(true)
    expect(isTreePath('.github/workflows', 'linux')).toBe(true)
  })

  it('refuses whatever leads out of the root', () => {
    for (const platform of ['win32', 'linux'] as const) {
      expect(isTreePath('..', platform)).toBe(false)
      expect(isTreePath('src/../../x', platform)).toBe(false)
      expect(isTreePath('/etc/passwd', platform)).toBe(false)
      expect(isTreePath('src//x', platform)).toBe(false)
      expect(isTreePath('a\0b', platform)).toBe(false)
      expect(isTreePath(42, platform)).toBe(false)
    }
    expect(isTreePath('..\\..\\Windows\\win.ini', 'win32')).toBe(false)
    expect(isTreePath('src\\..\\..\\x', 'win32')).toBe(false)
    expect(isTreePath('C:/Windows/win.ini', 'win32')).toBe(false)
    expect(isTreePath('file.txt:stream', 'win32')).toBe(false)
    // On Linux `\` is an ordinary character of a name.
    expect(isTreePath('a\\b', 'linux')).toBe(true)
  })
})

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

describe('filterGuard', () => {
  it('switches off the filters of the repository, not those of the user', () => {
    const out = ['global\tfilter.lfs.process', 'local\tfilter.evil.clean', 'worktree\tfilter.a=b.c.process\r', 'command\tfilter.mine.clean', ''].join('\n')
    expect(filterGuard(out)).toEqual({
      GIT_CONFIG_KEY_0: 'filter.evil.clean',
      GIT_CONFIG_VALUE_0: '',
      GIT_CONFIG_KEY_1: 'filter.evil.process',
      GIT_CONFIG_VALUE_1: '',
      GIT_CONFIG_KEY_2: 'filter.evil.required',
      GIT_CONFIG_VALUE_2: 'false',
      GIT_CONFIG_KEY_3: 'filter.a=b.c.clean',
      GIT_CONFIG_VALUE_3: '',
      GIT_CONFIG_KEY_4: 'filter.a=b.c.process',
      GIT_CONFIG_VALUE_4: '',
      GIT_CONFIG_KEY_5: 'filter.a=b.c.required',
      GIT_CONFIG_VALUE_5: 'false',
      GIT_CONFIG_COUNT: '6',
    })
  })

  it('adds to settings the environment gives git already, and is empty without filters', () => {
    expect(filterGuard('local\tfilter.x.clean', '2')).toMatchObject({ GIT_CONFIG_KEY_2: 'filter.x.clean', GIT_CONFIG_COUNT: '5' })
    expect(filterGuard(null)).toEqual({})
    expect(filterGuard('global\tfilter.lfs.clean')).toEqual({})
  })
})

describe('gitStateChange', () => {
  it('takes what git shows from its folder, not its objects, logs and locks', () => {
    for (const path of ['index', 'HEAD', 'refs/heads/main', 'refs/remotes/origin/main', 'packed-refs', 'config', 'MERGE_HEAD', 'info/exclude', 'modules/lib/index']) {
      expect(gitStateChange(path.split('/')), path).toBe(true)
    }
    for (const path of ['objects/ab/cdef', 'objects/pack/pack-1.pack', 'logs/HEAD', 'logs/refs/heads/main', 'index.lock', 'refs/heads/main.lock', 'FETCH_HEAD', 'ORIG_HEAD', 'COMMIT_EDITMSG', 'lfs/tmp/x', 'modules/lib/objects/ab/cd', 'fsmonitor--daemon.ipc']) {
      expect(gitStateChange(path.split('/')), path).toBe(false)
    }
    // A branch may be called like git's folders.
    expect(gitStateChange(['refs', 'heads', 'logs'])).toBe(true)
    // The folder of a worktree.
    expect(gitStateChange(['worktrees', 'x', 'index'])).toBe(true)
    expect(gitStateChange(['worktrees', 'x', 'HEAD'])).toBe(true)
    expect(gitStateChange(['worktrees', 'x', 'logs', 'HEAD'])).toBe(false)
    expect(gitStateChange(['worktrees', 'x', 'index.lock'])).toBe(false)
  })
})

describe('FileTreeService with git', () => {
  let dir: string
  const service = new FileTreeService()

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'file-tree-git-'))
    // git as the service runs it: without the user's configuration, no repository above the temp folder.
    vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1')
    vi.stubEnv('GIT_CONFIG_GLOBAL', join(dir, 'no-gitconfig'))
    vi.stubEnv('GIT_CEILING_DIRECTORIES', tmpdir())
    vi.stubEnv('GIT_DIR', undefined)
    vi.stubEnv('GIT_WORK_TREE', undefined)
  })
  afterEach(async () => {
    vi.unstubAllEnvs()
    service.dispose()
    await rm(dir, { recursive: true, force: true })
  })

  const git = (cwd: string, ...args: string[]) =>
    execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'init.defaultBranch=main', ...args], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })

  it('runs none of the programs the repository configures', async () => {
    const repo = join(dir, 'repo')
    await mkdir(repo)
    git(repo, 'init', '-q')
    await writeFile(join(repo, 'a.txt'), 'hello\n')
    await writeFile(join(repo, '.gitattributes'), '*.txt filter=evil diff=evil\n')
    git(repo, 'add', '-A')
    git(repo, 'commit', '-qm', 'init')
    // A program that notes that it ran; git starts it through its shell.
    const ran = join(dir, 'ran.txt').replaceAll('\\', '/')
    const mark = join(dir, 'mark.sh').replaceAll('\\', '/')
    await writeFile(mark, `echo "$1" >> '${ran}'\ncat > /dev/null\n`)
    for (const [key, what] of [
      ['core.fsmonitor', 'fsmonitor'],
      ['filter.evil.clean', 'clean'],
      ['diff.evil.textconv', 'textconv'],
      ['diff.external', 'external'],
    ]) {
      git(repo, 'config', key!, `sh '${mark}' ${what}`)
    }
    // Same size, another time: git has to compare the content and runs the filter for it.
    await writeFile(join(repo, 'a.txt'), 'HELLO\n')
    await utimes(join(repo, 'a.txt'), new Date('2001-01-01'), new Date('2001-01-01'))
    const programs = () => readFile(ran, 'utf8').then((text) => text.split(/\s+/).filter(Boolean).sort(), () => [])

    // Without the guard git runs them; else this test would prove nothing.
    git(repo, '--no-optional-locks', 'diff', 'HEAD')
    git(repo, '--no-optional-locks', 'diff', '--no-ext-diff', 'HEAD')
    expect(new Set(await programs())).toEqual(new Set(['fsmonitor', 'clean', 'textconv', 'external']))
    await rm(ran)

    const status = await service.status(repo)
    expect(status?.files['a.txt']).toMatchObject({ status: 'modified', added: 1, removed: 1 })
    const diff = await service.diff(repo, 'a.txt', false)
    expect(diff.patch).toContain('-hello')
    expect(diff.patch).toContain('+HELLO')
    expect((await service.searchList(repo)).paths).toContain('a.txt')
    expect(await programs()).toEqual([])
    // About 15 runs of git and sh: on Windows, with the other tests running, more than the 5 s default.
  }, 20_000)

  it('shows the files of a repository without a commit as new', async () => {
    const repo = join(dir, 'repo')
    await mkdir(join(repo, 'sub'), { recursive: true })
    git(repo, 'init', '-q')
    await writeFile(join(repo, 'sub', 'new.txt'), 'a\n')
    git(repo, 'add', '-A')
    const sub = join(repo, 'sub')
    expect(await service.status(sub)).toMatchObject({ branch: 'main', commit: null, files: { 'new.txt': { status: 'added' } } })
    expect(await service.diff(sub, 'new.txt', false)).toMatchObject({ repo: true, patch: '', text: 'a\n' })
  })

  it('compares a file git mv moved with the one it was', async () => {
    const repo = join(dir, 'repo')
    await mkdir(join(repo, 'sub'), { recursive: true })
    git(repo, 'init', '-q')
    const numbers = Array.from({ length: 20 }, (_, i) => `${i + 1}\n`).join('')
    await writeFile(join(repo, 'sub', 'a.txt'), numbers)
    await writeFile(join(repo, 'b.txt'), numbers)
    git(repo, 'add', '-A')
    git(repo, 'commit', '-qm', 'init')
    git(repo, 'mv', 'sub/a.txt', 'sub/moved.txt')
    git(repo, 'mv', 'b.txt', 'sub/b.txt')
    await writeFile(join(repo, 'sub', 'moved.txt'), numbers.replace('5\n', 'five\n'))
    const sub = join(repo, 'sub')

    // Renamed and changed: only the change, not the whole file as new.
    const moved = await service.diff(sub, 'moved.txt', false)
    expect(moved.patch).toContain('rename from sub/a.txt')
    expect(moved.patch).toMatch(/^-5$/m)
    expect(moved.patch).toMatch(/^\+five$/m)
    expect(moved.patch).not.toMatch(/^\+1$/m)

    // Only renamed, from outside the folder: no hunk, the file as it is.
    const kept = await service.diff(sub, 'b.txt', false)
    expect(kept.patch).toContain('rename from b.txt')
    expect(kept.patch).not.toContain('@@')
    expect(kept.text).toBe(numbers)
  })

  it('asks git only about changes it may see', async () => {
    const repo = join(dir, 'repo')
    await mkdir(join(repo, 'node_modules', 'pkg'), { recursive: true })
    git(repo, 'init', '-q')
    await writeFile(join(repo, '.gitignore'), 'node_modules/\n')
    git(repo, 'add', '-A')
    git(repo, 'commit', '-qm', 'init')
    expect((await service.status(repo))?.ignored).toEqual(['node_modules/'])
    const told: { dirs: string[]; git: boolean; repo: boolean }[] = []
    service.on('changed', (_root, dirs, git, repo) => told.push({ dirs, git, repo }))
    service.watch([{ root: repo, dirs: [''] }])
    await new Promise((resolve) => setTimeout(resolve, 300))

    // An install in an ignored folder, objects of a fetch: nothing to do.
    for (let i = 0; i < 20; i++) await writeFile(join(repo, 'node_modules', 'pkg', `f${i}.js`), 'x')
    await mkdir(join(repo, '.git', 'objects', 'zz'), { recursive: true })
    await writeFile(join(repo, '.git', 'objects', 'zz', 'object'), 'x')
    await new Promise((resolve) => setTimeout(resolve, 800))
    expect(told.filter((t) => t.git)).toEqual([])

    await writeFile(join(repo, 'app.ts'), 'x')
    await expect.poll(() => told.some((t) => t.git && t.dirs.includes('')), { timeout: 3000 }).toBe(true)
    // A file changed, the repository didn't: a diff of another file needn't ask again.
    expect(told.some((t) => t.repo)).toBe(false)
    git(repo, 'add', 'app.ts')
    await expect.poll(() => told.some((t) => t.repo), { timeout: 3000 }).toBe(true)
  })

  it('asks git again outside a repository only after a while, at once when .git appears', async () => {
    const plain = join(dir, 'plain')
    const watched = join(dir, 'watched')
    await mkdir(plain)
    await mkdir(watched)
    expect(await service.status(plain)).toBeNull()
    git(plain, 'init', '-q')
    // Still known as no repository: a busy folder doesn't start git for every change.
    expect(await service.status(plain)).toBeNull()

    service.watch([{ root: watched, dirs: [''] }])
    expect(await service.status(watched)).toBeNull()
    await new Promise((resolve) => setTimeout(resolve, 300))
    git(watched, 'init', '-q')
    await expect.poll(() => service.status(watched), { timeout: 3000 }).not.toBeNull()
  })

  describe('the writes of shell commands', () => {
    const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
    let repo: string
    let writes: { terminal: string; path: string }[]
    let off = () => {}
    const shell = (terminal: string, end: boolean) => service.activity(terminal, { shell: { id: `bash-${terminal}`, cwd: repo, end, writes: [] } })
    afterEach(() => off())

    beforeEach(async () => {
      repo = join(dir, 'repo')
      await mkdir(join(repo, 'src'), { recursive: true })
      git(repo, 'init', '-q')
      await writeFile(join(repo, '.gitignore'), 'dist/\n*.log\n')
      await writeFile(join(repo, 'src', 'a.ts'), 'a')
      await writeFile(join(repo, 'src', 'old.ts'), 'old')
      git(repo, 'add', '-A')
      git(repo, 'commit', '-qm', 'init')
      writes = []
      off = service.on('touched', (terminal, touches) => {
        for (const touch of touches) if (touch.kind === 'write') writes.push({ terminal, path: touch.path })
      })
    })

    it('are what changes meanwhile, not what git ignores or another session’s tool writes', async () => {
      await service.status(repo)
      service.watch([{ root: repo, dirs: [''] }])
      await wait(300)
      // Another session's tool is about to write b.ts.
      service.activity('t2', { touches: [{ path: join(repo, 'src', 'b.ts'), kind: 'write' }] })
      shell('t1', false)
      // A build's output in a folder it makes, a log, the file the other session writes, and its own.
      await mkdir(join(repo, 'dist'))
      await writeFile(join(repo, 'dist', 'out.js'), 'x')
      await writeFile(join(repo, 'debug.log'), 'x')
      await writeFile(join(repo, 'src', 'b.ts'), 'by t2')
      await writeFile(join(repo, 'src', 'a.ts'), 'changed')
      await wait(800)
      shell('t1', true)
      await wait(1200)
      expect(writes).toEqual([
        { terminal: 't2', path: join(repo, 'src', 'b.ts') },
        { terminal: 't1', path: join(repo, 'src', 'a.ts') },
      ])
    })

    it('are nobody’s while commands of two sessions run in the folder', async () => {
      service.watch([{ root: repo, dirs: ['', 'src'] }])
      await wait(300)
      shell('t1', false)
      shell('t2', false)
      await writeFile(join(repo, 'src', 'a.ts'), 'changed')
      await wait(800)
      shell('t1', true)
      shell('t2', true)
      await wait(1200)
      expect(writes).toEqual([])
    })

    it('are found in git’s status once a command ended that no tree watched', async () => {
      // Changed before the command: not its write.
      await writeFile(join(repo, 'src', 'old.ts'), 'changed before')
      await utimes(join(repo, 'src', 'old.ts'), new Date(Date.now() - 3_600_000), new Date(Date.now() - 3_600_000))
      shell('t1', false)
      await writeFile(join(repo, 'src', 'a.ts'), 'changed')
      await writeFile(join(repo, 'src', 'new.ts'), 'new')
      await mkdir(join(repo, 'dist'))
      await writeFile(join(repo, 'dist', 'out.js'), 'x')
      shell('t1', true)
      await expect.poll(() => writes.length, { timeout: 3000 }).toBe(2)
      await wait(300)
      expect(new Set(writes.map((w) => w.path))).toEqual(new Set([join(repo, 'src', 'a.ts'), join(repo, 'src', 'new.ts')]))
    })
  })

  it('shows the commit a submodule is at, and no repository inside as a file to find', async () => {
    const lib = join(dir, 'lib-origin')
    await mkdir(lib)
    git(lib, 'init', '-q')
    await writeFile(join(lib, 'x.txt'), 'x')
    git(lib, 'add', '-A')
    git(lib, 'commit', '-qm', 'lib')
    const repo = join(dir, 'repo')
    await mkdir(repo)
    git(repo, 'init', '-q')
    git(repo, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', lib, 'lib')
    git(repo, 'commit', '-qm', 'with lib')
    // A new commit in the submodule.
    await writeFile(join(repo, 'lib', 'y.txt'), 'y')
    git(join(repo, 'lib'), 'add', '-A')
    git(join(repo, 'lib'), 'commit', '-qm', 'more')
    const sub = await service.diff(repo, 'lib', false)
    expect(sub.patch).toMatch(/^-Subproject commit /m)
    expect(sub.patch).toMatch(/^\+Subproject commit /m)

    // A repository of its own inside, no submodule: git lists it as its folder.
    await mkdir(join(repo, 'vendor', 'other'), { recursive: true })
    git(join(repo, 'vendor', 'other'), 'init', '-q')
    await writeFile(join(repo, 'vendor', 'other', 'z.txt'), 'z')
    await writeFile(join(repo, 'new.txt'), 'n')
    const { paths } = await service.searchList(repo)
    expect(paths).toContain('new.txt')
    expect(paths.filter((path) => path.endsWith('/'))).toEqual([])
  })

  it('lights up a commit’s files where the session works, through a link too', async () => {
    const real = join(dir, 'real')
    await mkdir(join(real, 'src'), { recursive: true })
    git(real, 'init', '-q')
    await writeFile(join(real, 'src', 'a.ts'), 'a')
    git(real, 'add', '-A')
    git(real, 'commit', '-qm', 'init')
    const link = join(dir, 'link')
    await symlink(real, link, 'junction')
    try {
      const touched: string[] = []
      service.on('touched', (_terminal, touches) => touched.push(...touches.filter((t) => t.kind === 'commit').map((t) => t.path)))
      service.activity('t1', { commit: join(link, 'src') })
      await expect.poll(() => touched, { timeout: 3000 }).toEqual([join(link, 'src', 'a.ts')])
    } finally {
      await unlink(link).catch(() => rm(link, { recursive: true, force: true }))
    }
  })

  it('follows a push in a tree of a subfolder: ahead and behind come from the refs', async () => {
    const remote = join(dir, 'remote.git')
    await mkdir(remote)
    git(remote, 'init', '-q', '--bare')
    const repo = join(dir, 'repo')
    await mkdir(join(repo, 'sub'), { recursive: true })
    git(repo, 'init', '-q')
    await writeFile(join(repo, 'sub', 'a.txt'), 'a')
    git(repo, 'add', '-A')
    git(repo, 'commit', '-qm', 'init')
    git(repo, 'remote', 'add', 'origin', remote)
    git(repo, 'push', '-q', '-u', 'origin', 'main')
    await writeFile(join(repo, 'sub', 'a.txt'), 'b')
    git(repo, 'commit', '-qam', 'second')
    const sub = join(repo, 'sub')
    expect(await service.status(sub)).toMatchObject({ ahead: 1 })
    const told: boolean[] = []
    service.on('changed', (_root, _dirs, _git, repoChanged) => told.push(repoChanged))
    service.watch([{ root: sub, dirs: [''] }])
    await new Promise((resolve) => setTimeout(resolve, 500))
    told.length = 0
    git(repo, 'push', '-q')
    await expect.poll(() => told.includes(true), { timeout: 3000 }).toBe(true)
    expect(await service.status(sub)).toMatchObject({ ahead: 0 })
  })

  it('reads a file whose mode alone changed', async () => {
    const repo = join(dir, 'repo')
    await mkdir(repo)
    git(repo, 'init', '-q')
    await writeFile(join(repo, 'run.sh'), 'echo hi\n')
    git(repo, 'add', '-A')
    git(repo, 'commit', '-qm', 'init')
    // On disk for Linux, in the index for Windows (it has no executable bit).
    await chmod(join(repo, 'run.sh'), 0o755)
    git(repo, 'update-index', '--chmod=+x', 'run.sh')
    const result = await service.diff(repo, 'run.sh', false)
    expect(result.patch).toContain('new mode 100755')
    expect(result.text).toBe('echo hi\n')
  })

  /** As `>` writes it in Windows PowerShell 5.1: UTF-16 with byte order mark and CRLF. */
  const utf16 = (text: string) => Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')])

  it('shows the changes of a UTF-16 file instead of calling it binary', async () => {
    const repo = join(dir, 'repo')
    await mkdir(repo)
    git(repo, 'init', '-q')
    await writeFile(join(repo, 'out.txt'), utf16('Größe\r\nalt\r\nEnde\r\n'))
    git(repo, 'add', '-A')
    git(repo, 'commit', '-qm', 'init')
    await writeFile(join(repo, 'out.txt'), utf16('Größe\r\nneu\r\nEnde\r\n'))
    // git itself takes it for binary.
    expect(git(repo, 'diff', 'HEAD')).toContain('Binary files')

    const result = await service.diff(repo, 'out.txt', false)
    expect(result.binary).toBe(false)
    expect(result.patch).toContain('diff --git a/out.txt b/out.txt')
    expect(result.patch).not.toContain('Binary files')
    expect(result.patch).toContain(' Größe\r\n-alt\r\n+neu\r\n Ende\r\n')
  })

  it('reads a new UTF-16 file as text', async () => {
    const repo = join(dir, 'repo')
    await mkdir(repo)
    git(repo, 'init', '-q')
    await writeFile(join(repo, 'a.txt'), 'a\n')
    git(repo, 'add', '-A')
    git(repo, 'commit', '-qm', 'init')
    await writeFile(join(repo, 'new.txt'), utf16('Grüße\r\n'))
    expect(await service.diff(repo, 'new.txt', false)).toMatchObject({ binary: false, text: 'Grüße\r\n' })
  })

  it('reads a file saved as Latin-1 without replacement characters', async () => {
    const repo = join(dir, 'repo')
    await mkdir(repo)
    git(repo, 'init', '-q')
    await writeFile(join(repo, 'alt.txt'), Buffer.from('Gr\xfc\xdfe\nalt\n', 'latin1'))
    git(repo, 'add', '-A')
    git(repo, 'commit', '-qm', 'init')
    await writeFile(join(repo, 'alt.txt'), Buffer.from('Gr\xfc\xdfe\nneu \xe4\n', 'latin1'))
    const result = await service.diff(repo, 'alt.txt', false)
    expect(result.patch).toContain(' Grüße\n-alt\n+neu ä\n')
    expect(result.patch).not.toContain('�')
    await writeFile(join(repo, 'alt.txt'), Buffer.from('Gr\xfc\xdfe\nalt\n', 'latin1'))
    expect((await service.diff(repo, 'alt.txt', false)).text).toBe('Grüße\nalt\n')
  })

  it('shows an image as it was and as it is', async () => {
    const red = Buffer.from('\x89PNG\r\n\x1a\nred', 'latin1')
    const blue = Buffer.from('\x89PNG\r\n\x1a\nblue', 'latin1')
    const url = (bytes: Buffer) => `data:image/png;base64,${bytes.toString('base64')}`
    const repo = join(dir, 'repo')
    await mkdir(repo)
    git(repo, 'init', '-q')
    await writeFile(join(repo, 'logo.PNG'), red)
    git(repo, 'add', '-A')
    git(repo, 'commit', '-qm', 'init')
    // Unchanged: as it is.
    expect(await service.diff(repo, 'logo.PNG', false)).toMatchObject({ binary: true, image: { before: null, after: url(red) } })
    await writeFile(join(repo, 'logo.PNG'), blue)
    expect(await service.diff(repo, 'logo.PNG', false)).toMatchObject({ binary: true, image: { before: url(red), after: url(blue) } })
    // New: only now.
    await writeFile(join(repo, 'new.png'), blue)
    expect((await service.diff(repo, 'new.png', false)).image).toEqual({ before: null, after: url(blue) })
    // Deleted: only before.
    await rm(join(repo, 'logo.PNG'))
    expect(await service.diff(repo, 'logo.PNG', false)).toMatchObject({ missing: true, image: { before: url(red), after: null } })
  })

  describe('a review of the branch', () => {
    /** A repository with a pushed `main` and the branch `feat` off it, pushed too, with work of its own. */
    async function branched(): Promise<string> {
      const remote = join(dir, 'remote.git')
      await mkdir(remote)
      git(remote, 'init', '-q', '--bare')
      const repo = join(dir, 'repo')
      await mkdir(join(repo, 'sub'), { recursive: true })
      git(repo, 'init', '-q')
      await writeFile(join(repo, 'a.txt'), 'one\nold\nthree\n')
      await writeFile(join(repo, 'b.txt'), 'kept\n'.repeat(10))
      await writeFile(join(repo, 'sub', 's.txt'), 's\n')
      git(repo, 'add', '-A')
      git(repo, 'commit', '-qm', 'init')
      git(repo, 'remote', 'add', 'origin', remote)
      git(repo, 'push', '-q', '-u', 'origin', 'main')
      git(repo, 'checkout', '-q', '-b', 'feat')
      await writeFile(join(repo, 'a.txt'), 'one\nnew\nthree\n')
      git(repo, 'commit', '-qam', 'first')
      await writeFile(join(repo, 'c.txt'), 'c\n')
      git(repo, 'add', 'c.txt')
      git(repo, 'commit', '-qm', 'second')
      git(repo, 'mv', 'b.txt', 'd.txt')
      git(repo, 'commit', '-qm', 'third: Größe')
      git(repo, 'push', '-q', '-u', 'origin', 'feat')
      // The main branch goes on meanwhile: its new file is none of the branch's.
      git(repo, 'checkout', '-q', 'main')
      await writeFile(join(repo, 'x.txt'), 'x\n')
      git(repo, 'add', 'x.txt')
      git(repo, 'commit', '-qm', 'elsewhere')
      git(repo, 'push', '-q')
      git(repo, 'checkout', '-q', 'feat')
      // Not committed yet: a change and a file git doesn't know.
      await writeFile(join(repo, 'c.txt'), 'c\nmore\n')
      await writeFile(join(repo, 'e.txt'), 'e\n')
      return repo
    }

    it('shows the commits and files since the branch left the main branch, and where to open its pull request', async () => {
      const repo = await branched()
      git(repo, 'remote', 'set-url', 'origin', 'git@github.com:me/app.git')
      const review = await service.reviewBase(repo)
      expect(review).toMatchObject({ base: 'origin/main', branch: 'feat', commitsTruncated: false, truncated: false })
      expect(review!.mergeBase).toBe(git(repo, 'rev-parse', 'main~1').trim())
      expect(review!.commits.map((c) => c.subject)).toEqual(['third: Größe', 'second', 'first'])
      expect(review!.commits[0]).toMatchObject({ author: 'Test', short: git(repo, 'rev-parse', '--short', 'HEAD').trim() })
      expect(review!.commits[0]!.sha).toBe(git(repo, 'rev-parse', 'HEAD').trim())
      expect(review!.commits[0]!.date).toMatch(/^\d{4}-\d\d-\d\dT/)
      expect(review!.files).toEqual({
        'a.txt': { status: 'modified', staged: false, added: 1, removed: 1 },
        // Committed and changed since: both together.
        'c.txt': { status: 'added', staged: false, added: 2, removed: 0 },
        'd.txt': { status: 'renamed', staged: false, added: 0, removed: 0 },
      })
      expect(review!.pullRequestUrl).toBe('https://github.com/me/app/compare/main...feat?expand=1')

      // The diffs against where it started.
      const a = await service.diff(repo, 'a.txt', false, review!.mergeBase)
      expect(a.patch).toMatch(/^-old$/m)
      expect(a.patch).toMatch(/^\+new$/m)
      expect((await service.diff(repo, 'a.txt', false)).patch).toBe('')
      const c = await service.diff(repo, 'c.txt', false, review!.mergeBase)
      expect(c.patch).toContain('new file mode')
      expect(c.patch).toMatch(/^\+more$/m)
      const d = await service.diff(repo, 'd.txt', false, review!.mergeBase)
      expect(d.patch).toContain('rename from b.txt')
      expect(d.text).toBe('kept\n'.repeat(10))
      // Only a commit's hash: nothing git could take for an option or another revision.
      for (const base of ['HEAD', '--output=x', 'main', `${review!.mergeBase} x`]) {
        await expect(service.diff(repo, 'a.txt', false, base)).rejects.toThrow('Ungültiger Commit.')
      }
    }, 30_000)

    it('names the files of a subfolder relative to it, and follows the main branch the remote names', async () => {
      const repo = await branched()
      const sub = join(repo, 'sub')
      await writeFile(join(sub, 's.txt'), 's\nchanged\n')
      git(repo, 'commit', '-qam', 'sub')
      expect((await service.reviewBase(sub))?.files).toEqual({ 's.txt': { status: 'modified', staged: false, added: 1, removed: 0 } })
      // A remote without a host the app knows: no pull request.
      expect((await service.reviewBase(sub))?.pullRequestUrl).toBeNull()

      git(repo, 'branch', '-q', 'develop', 'feat~1')
      git(repo, 'push', '-q', 'origin', 'develop')
      git(repo, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/develop')
      const review = await service.reviewBase(repo)
      expect(review).toMatchObject({ base: 'origin/develop' })
      expect(review!.commits.map((c) => c.subject)).toEqual(['sub'])
    }, 30_000)

    it('on the main branch shows what isn’t pushed yet, without a pull request', async () => {
      const repo = await branched()
      git(repo, 'stash', '-q', '-u')
      git(repo, 'checkout', '-q', 'main')
      expect(await service.reviewBase(repo)).toBeNull()
      await writeFile(join(repo, 'x.txt'), 'x\ny\n')
      git(repo, 'remote', 'set-url', 'origin', 'https://github.com/me/app.git')
      git(repo, 'commit', '-qam', 'local')
      const review = await service.reviewBase(repo)
      expect(review).toMatchObject({ base: 'origin/main', branch: 'main', pullRequestUrl: null })
      expect(review!.commits.map((c) => c.subject)).toEqual(['local'])
      // Detached: the commits, no branch to open a pull request of.
      git(repo, 'checkout', '-q', '--detach')
      expect(await service.reviewBase(repo)).toMatchObject({ base: 'origin/main', branch: null, pullRequestUrl: null })
    }, 30_000)

    it('starts from the main branch of the branch’s own remote, a pull request only within it', async () => {
      const repo = await branched()
      // The branch goes to another remote that has a main branch of its own.
      const gitlab = join(dir, 'gitlab.git')
      await mkdir(gitlab)
      git(gitlab, 'init', '-q', '--bare')
      git(repo, 'remote', 'add', 'lab', gitlab)
      git(repo, 'push', '-q', 'lab', 'main~1:refs/heads/main')
      git(repo, 'push', '-q', '-u', 'lab', 'feat')
      git(repo, 'remote', 'set-url', 'lab', 'https://gitlab.example.com/me/app.git')
      git(repo, 'remote', 'set-url', 'origin', 'https://github.com/me/app.git')
      expect(await service.reviewBase(repo)).toMatchObject({
        base: 'lab/main',
        pullRequestUrl:
          'https://gitlab.example.com/me/app/-/merge_requests/new?merge_request%5Bsource_branch%5D=feat&merge_request%5Btarget_branch%5D=main',
      })
      // A fork without the main branch: compared with origin's, no pull request across the two.
      git(repo, 'update-ref', '-d', 'refs/remotes/lab/main')
      expect(await service.reviewBase(repo)).toMatchObject({ base: 'origin/main', branch: 'feat', pullRequestUrl: null })
    }, 30_000)

    it('compares images and UTF-16 files with where the branch started', async () => {
      const red = Buffer.from('\x89PNG\r\n\x1a\nred', 'latin1')
      const blue = Buffer.from('\x89PNG\r\n\x1a\nblue', 'latin1')
      const url = (bytes: Buffer) => `data:image/png;base64,${bytes.toString('base64')}`
      const repo = join(dir, 'repo')
      await mkdir(repo)
      git(repo, 'init', '-q')
      await writeFile(join(repo, 'logo.png'), red)
      await writeFile(join(repo, 'out.txt'), utf16('Größe\r\nalt\r\n'))
      git(repo, 'add', '-A')
      git(repo, 'commit', '-qm', 'init')
      git(repo, 'checkout', '-q', '-b', 'feat')
      await writeFile(join(repo, 'logo.png'), blue)
      await writeFile(join(repo, 'out.txt'), utf16('Größe\r\nneu\r\n'))
      git(repo, 'commit', '-qam', 'work')
      const base = (await service.reviewBase(repo))!.mergeBase
      expect((await service.diff(repo, 'logo.png', false, base)).image).toEqual({ before: url(red), after: url(blue) })
      expect((await service.diff(repo, 'logo.png', false)).image).toEqual({ before: null, after: url(blue) })
      const text = await service.diff(repo, 'out.txt', false, base)
      expect(text.binary).toBe(false)
      expect(text.patch).toContain(' Größe\r\n-alt\r\n+neu\r\n')
    }, 30_000)

    it('sends the latest 200 commits and says there are more', async () => {
      const repo = join(dir, 'repo')
      await mkdir(repo)
      git(repo, 'init', '-q')
      await writeFile(join(repo, 'a.txt'), 'a\n')
      git(repo, 'add', '-A')
      git(repo, 'commit', '-qm', 'init')
      // 201 commits at once, faster than one `git commit` each.
      const commit = (n: number) =>
        `commit refs/heads/feat\ncommitter Test <test@example.com> ${1_700_000_000 + n} +0000\ndata ${`c${n}`.length}\nc${n}\n` +
        `${n === 1 ? 'from refs/heads/main\n' : ''}M 644 inline a.txt\ndata ${`${n}\n`.length}\n${n}\n\n`
      execFileSync('git', ['fast-import', '--quiet'], { cwd: repo, input: Array.from({ length: 201 }, (_, i) => commit(i + 1)).join('') })
      git(repo, 'checkout', '-q', 'feat')
      const review = await service.reviewBase(repo)
      expect(review!.commits).toHaveLength(200)
      expect(review!.commits[0]!.subject).toBe('c201')
      expect(review!.commitsTruncated).toBe(true)
      git(repo, 'reset', '-q', '--hard', 'HEAD~1')
      expect(await service.reviewBase(repo)).toMatchObject({ commitsTruncated: false })
    }, 30_000)

    it('is null without a main branch, without commits since and outside a repository', async () => {
      const plain = join(dir, 'plain')
      await mkdir(plain)
      expect(await service.reviewBase(plain)).toBeNull()
      const repo = join(dir, 'repo')
      await mkdir(repo)
      git(repo, 'init', '-q')
      expect(await service.reviewBase(repo)).toBeNull()
      await writeFile(join(repo, 'a.txt'), 'a\n')
      git(repo, 'add', '-A')
      git(repo, 'commit', '-qm', 'init')
      // A local main branch only, checked out: nothing since.
      expect(await service.reviewBase(repo)).toBeNull()
      git(repo, 'checkout', '-q', '-b', 'feat')
      await writeFile(join(repo, 'a.txt'), 'b\n')
      git(repo, 'commit', '-qam', 'work')
      expect(await service.reviewBase(repo)).toMatchObject({
        base: 'main',
        branch: 'feat',
        pullRequestUrl: null,
        files: { 'a.txt': { status: 'modified' } },
      })
      git(repo, 'branch', '-q', '-m', 'main', 'trunk')
      expect(await service.reviewBase(repo)).toBeNull()
    }, 30_000)
  })
})

describe('parseReviewFiles', () => {
  it('reads changed, renamed and copied files with their lines, relative to the folder', () => {
    const nameStatus = [
      ...['M', 'sub/a.txt', 'A', 'sub/new file.txt', 'D', 'sub/gone.txt'],
      ...['R087', 'old.txt', 'sub/moved.txt', 'C100', 'sub/a.txt', 'sub/copy.txt'],
      ...['T', 'sub/link', 'M', 'other/x.txt', ''],
    ].join('\0')
    const numstat = ['3\t1\tsub/a.txt', '-\t-\tsub/new file.txt', '0\t4\tsub/gone.txt', '1\t1\t', 'old.txt', 'sub/moved.txt', '2\t2\tother/x.txt', ''].join(
      '\0',
    )
    expect(parseReviewFiles(nameStatus, numstat, 'sub/')).toEqual({
      files: {
        'a.txt': { status: 'modified', staged: false, added: 3, removed: 1 },
        'new file.txt': { status: 'added', staged: false, added: null, removed: null },
        'gone.txt': { status: 'deleted', staged: false, added: 0, removed: 4 },
        'moved.txt': { status: 'renamed', staged: false, added: 1, removed: 1 },
        'copy.txt': { status: 'added', staged: false, added: null, removed: null },
        link: { status: 'modified', staged: false, added: null, removed: null },
      },
      truncated: false,
    })
    expect(parseReviewFiles('U\0a.txt\0', '', '').files).toEqual({ 'a.txt': { status: 'conflict', staged: false, added: null, removed: null } })
    expect(parseReviewFiles('', '', '')).toEqual({ files: {}, truncated: false })
  })
})

describe('parseCommits', () => {
  it('reads hash, subject, author and date of each commit', () => {
    const sha = 'a'.repeat(40)
    const out = `${sha}\x1faaaaaaa\x1ffix: a | b\x1fJane Doe\x1f2026-11-12T10:00:00+01:00\x1e\n${'b'.repeat(40)}\x1fbbbbbbb\x1f\x1fX\x1f2026-11-11T09:00:00Z\x1e\n`
    expect(parseCommits(out)).toEqual([
      { sha, short: 'aaaaaaa', subject: 'fix: a | b', author: 'Jane Doe', date: '2026-11-12T10:00:00+01:00' },
      { sha: 'b'.repeat(40), short: 'bbbbbbb', subject: '', author: 'X', date: '2026-11-11T09:00:00Z' },
    ])
    expect(parseCommits('')).toEqual([])
    expect(parseCommits('not a commit\x1fx\x1e')).toEqual([])
  })
})

describe('isCommitHash', () => {
  it('takes a commit’s hash, nothing else', () => {
    expect(isCommitHash('0123abc')).toBe(true)
    expect(isCommitHash('a'.repeat(40))).toBe(true)
    expect(isCommitHash('a'.repeat(64))).toBe(true)
    for (const value of ['012345', 'a'.repeat(65), 'HEAD', 'ABCDEF0', '-0123abc', '0123abc~1', '0123abc\n', null, 7]) {
      expect(isCommitHash(value)).toBe(false)
    }
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

describe('FileTreeService.searchList without git', () => {
  let dir: string
  const service = new FileTreeService()

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'file-tree-walk-'))
  })
  afterEach(async () => {
    service.dispose()
    await rm(dir, { recursive: true, force: true })
  })

  it('walks the folder and leaves out node_modules and what the tree hides', async () => {
    await mkdir(join(dir, 'src', 'lib'), { recursive: true })
    await mkdir(join(dir, 'node_modules', 'pkg'), { recursive: true })
    await mkdir(join(dir, '.svn'))
    await writeFile(join(dir, 'README.md'), '')
    await writeFile(join(dir, 'src', 'main.ts'), '')
    await writeFile(join(dir, 'src', 'lib', 'util.ts'), '')
    await writeFile(join(dir, 'node_modules', 'pkg', 'index.js'), '')
    await writeFile(join(dir, '.svn', 'entries'), '')
    await writeFile(join(dir, 'Thumbs.db'), '')
    const { paths, truncated } = await service.searchList(dir)
    expect(paths.sort()).toEqual(['README.md', 'src/lib/util.ts', 'src/main.ts'])
    expect(truncated).toBe(false)
  })

  it('stops 16 folders deep and says the list is cut', async () => {
    let deep = dir
    for (let depth = 1; depth <= 18; depth++) {
      deep = join(deep, `d${depth}`)
      await mkdir(deep)
      await writeFile(join(deep, `at${depth}.txt`), '')
    }
    const { paths, truncated } = await service.searchList(dir)
    expect(paths.some((path) => path.endsWith('/at16.txt'))).toBe(true)
    expect(paths.some((path) => path.endsWith('/at17.txt'))).toBe(false)
    expect(truncated).toBe(true)
  })

  it('does not follow a link back up, so it can’t go round in a circle', async () => {
    await mkdir(join(dir, 'sub'))
    await writeFile(join(dir, 'sub', 'file.txt'), '')
    try {
      await symlink(dir, join(dir, 'sub', 'up'), 'junction')
    } catch {
      return
    }
    const { paths } = await service.searchList(dir)
    expect(paths.filter((path) => path.endsWith('file.txt'))).toEqual(['sub/file.txt'])
  })
})

describe('FileTreeService.watch', () => {
  let dir: string
  let service: FileTreeService

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'file-tree-watch-'))
    service = new FileTreeService()
  })
  afterEach(async () => {
    service.dispose()
    await rm(dir, { recursive: true, force: true })
  })

  it.skipIf(process.platform !== 'win32')('watches a folder spelled two ways once and tells both', async () => {
    const other = `${dir.toUpperCase()}\\`
    const told: string[] = []
    service.on('changed', (root) => told.push(root))
    service.watch([
      { root: dir, dirs: [] },
      { root: other, dirs: [] },
    ])
    await writeFile(join(dir, 'neu.txt'), 'x')
    await expect.poll(() => told.length, { timeout: 3000 }).toBeGreaterThanOrEqual(2)
    expect(new Set(told)).toEqual(new Set([dir, other]))
    expect(told).toHaveLength(2)
  })
})

describe('FileTreeService file operations', () => {
  let dir: string
  let service: FileTreeService
  const trashed: string[] = []

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'file-tree-ops-'))
    trashed.length = 0
    service = new FileTreeService(async (path) => {
      trashed.push(path)
    })
    service.watch([{ root: dir, dirs: [''] }])
  })
  afterEach(async () => {
    service.dispose()
    // The git the watch asks still runs in the folder for a moment (EBUSY on Windows).
    await rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
  })

  it('makes an empty file and a folder, with the folders on their way', async () => {
    await service.create(dir, 'src/lib/new.ts', false)
    await service.create(dir, 'docs/guides', true)
    expect(await readFile(join(dir, 'src', 'lib', 'new.ts'), 'utf8')).toBe('')
    expect((await stat(join(dir, 'docs', 'guides'))).isDirectory()).toBe(true)
  })

  it('never makes an entry over one that is there', async () => {
    await writeFile(join(dir, 'notes.md'), 'keep')
    await mkdir(join(dir, 'src'))
    await expect(service.create(dir, 'notes.md', false)).rejects.toThrow('„notes.md“ gibt es dort schon.')
    await expect(service.create(dir, 'src', true)).rejects.toThrow('„src“ gibt es dort schon.')
    expect(await readFile(join(dir, 'notes.md'), 'utf8')).toBe('keep')
  })

  it('renames, but never over another entry', async () => {
    await writeFile(join(dir, 'a.txt'), 'a')
    await writeFile(join(dir, 'b.txt'), 'b')
    await expect(service.rename(dir, 'a.txt', 'b.txt')).rejects.toThrow('„b.txt“ gibt es dort schon.')
    expect(await readFile(join(dir, 'b.txt'), 'utf8')).toBe('b')
    await service.rename(dir, 'a.txt', 'c.txt')
    expect(await readFile(join(dir, 'c.txt'), 'utf8')).toBe('a')
    await expect(service.rename(dir, 'a.txt', 'd.txt')).rejects.toThrow('„a.txt“ gibt es nicht mehr.')
  })

  it('renames a file to the same name in another case', async () => {
    await writeFile(join(dir, 'readme.md'), 'x')
    await service.rename(dir, 'readme.md', 'README.md')
    expect(await readdir(dir)).toEqual(['README.md'])
  })

  it('moves an entry to the recycle bin', async () => {
    await mkdir(join(dir, 'old'))
    await service.trash(dir, 'old')
    expect(trashed).toEqual([join(dir, 'old')])
    await expect(service.trash(dir, 'gone.txt')).rejects.toThrow('„gone.txt“ gibt es nicht mehr.')
  })

  it('says so in German when the recycle bin refuses', async () => {
    const refusing = new FileTreeService(() => Promise.reject(new Error('Failed to move item to trash')))
    refusing.watch([{ root: dir, dirs: [''] }])
    await writeFile(join(dir, 'x.txt'), '')
    await expect(refusing.trash(dir, 'x.txt')).rejects.toThrow('„x.txt“ ließ sich nicht in den Papierkorb verschieben (Failed to move item to trash).')
    refusing.dispose()
  })

  it('touches nothing outside an open tree, in .git or by a bad name', async () => {
    const other = await mkdtemp(join(tmpdir(), 'file-tree-other-'))
    try {
      await expect(service.create(other, 'x.txt', false)).rejects.toThrow('in keinem offenen Dateibaum')
      await expect(service.trash(other, 'x.txt')).rejects.toThrow('in keinem offenen Dateibaum')
    } finally {
      await rm(other, { recursive: true, force: true })
    }
    await expect(service.create(dir, '../x.txt', false)).rejects.toThrow('Ungültiger Pfad.')
    await expect(service.rename(dir, 'a', '../b')).rejects.toThrow('Ungültiger Pfad.')
    await expect(service.trash(dir, '')).rejects.toThrow('Ungültiger Pfad.')
    await expect(service.create(dir, '.git/hooks/pre-commit', false)).rejects.toThrow('„.git“ gehört Git.')
    await expect(service.trash(dir, '.git')).rejects.toThrow('„.git“ gehört Git.')
    await expect(service.create(dir, 'a//b', false)).rejects.toThrow('Ungültiger Pfad.')
    expect(trashed).toEqual([])
  })
})

describe('parseGrep', () => {
  it('reads the lines by file, without their indent and line ending, with where the hits are', () => {
    const files = parseGrep('src/a.ts\x002\x00  const Total = total\r\nsrc/a.ts\x009\x00total()\nb.md\x001\x00# Total\n', 'total')
    expect(files).toEqual([
      {
        path: 'src/a.ts',
        matches: [
          { line: 2, text: 'const Total = total', ranges: [[6, 11], [14, 19]] },
          { line: 9, text: 'total()', ranges: [[0, 5]] },
        ],
      },
      { path: 'b.md', matches: [{ line: 1, text: '# Total', ranges: [[2, 7]] }] },
    ])
  })

  it('keeps a colon in a path and in the text, and skips what is not a line', () => {
    expect(parseGrep('a:b.txt\x003\x00x: y\ngarbage\n\n', 'y')).toEqual([{ path: 'a:b.txt', matches: [{ line: 3, text: 'x: y', ranges: [[3, 4]] }] }])
  })

  it('shows of a long line the part around its first hit', () => {
    const line = `${'a'.repeat(500)}needle${'b'.repeat(500)}`
    const [match] = parseGrep(`min.js\x001\x00${line}\n`, 'NEEDLE')[0]!.matches
    expect(match!.text.startsWith('…a')).toBe(true)
    expect(match!.text.endsWith('b…')).toBe(true)
    expect(match!.text.length).toBeLessThanOrEqual(242)
    const [start, end] = match!.ranges[0]!
    expect(match!.text.slice(start, end)).toBe('needle')
  })
})

describe('FileTreeService.grep', () => {
  let dir: string
  let service: FileTreeService

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'file-tree-grep-'))
    vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1')
    vi.stubEnv('GIT_CONFIG_GLOBAL', join(dir, 'no-gitconfig'))
    vi.stubEnv('GIT_CEILING_DIRECTORIES', tmpdir())
    vi.stubEnv('GIT_DIR', undefined)
    vi.stubEnv('GIT_WORK_TREE', undefined)
    service = new FileTreeService()
  })
  afterEach(async () => {
    vi.unstubAllEnvs()
    service.dispose()
    await rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
  })

  const git = (...args: string[]) =>
    execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'init.defaultBranch=main', ...args], {
      cwd: dir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })

  it('finds the text in known and new files, not in ignored or binary ones', async () => {
    git('init', '-q')
    await mkdir(join(dir, 'src'))
    await writeFile(join(dir, 'src', 'known.ts'), 'const total = 1\nconst other = 2\n')
    await writeFile(join(dir, '.gitignore'), 'build/\n')
    git('add', '.')
    git('commit', '-qm', 'init')
    await writeFile(join(dir, 'new.md'), '# Total\n')
    await mkdir(join(dir, 'build'))
    await writeFile(join(dir, 'build', 'out.js'), 'total\n')
    await writeFile(join(dir, 'data.bin'), Buffer.from([0, 1, 2, ...Buffer.from('total')]))
    service.watch([{ root: dir, dirs: [''] }])
    const result = await service.grep(dir, 'TOTAL')
    expect(result.files.map((f) => f.path).sort()).toEqual(['new.md', 'src/known.ts'])
    expect(result).toMatchObject({ matches: 2, truncated: false })
  })

  it('finds it outside a repository too', async () => {
    await writeFile(join(dir, 'notes.txt'), 'one\ntotal two\n')
    service.watch([{ root: dir, dirs: [''] }])
    expect(await service.grep(dir, 'total')).toEqual({
      files: [{ path: 'notes.txt', matches: [{ line: 2, text: 'total two', ranges: [[0, 5]] }] }],
      matches: 1,
      truncated: false,
    })
  })

  it('stops at the most lines it reads', async () => {
    await writeFile(join(dir, 'many.txt'), 'hit\n'.repeat(MAX_GREP_MATCHES + 50))
    service.watch([{ root: dir, dirs: [''] }])
    expect(await service.grep(dir, 'hit')).toMatchObject({ matches: MAX_GREP_MATCHES, truncated: true })
  })

  it('searches only open trees', async () => {
    await expect(service.grep(dir, 'x')).rejects.toThrow('in keinem offenen Dateibaum')
  })
})

describe('hunkPatch', () => {
  const patch = Buffer.from(
    'diff --git a/x b/x\nindex 1..2 100644\n--- a/x\n+++ b/x\n@@ -1,2 +1,2 @@\n-a\r\n+b\r\n c\n@@ -9 +9 @@\n-ü\n+ö\n',
  )

  it('keeps the head of the patch and the one section, byte for byte', () => {
    expect(hunkPatch(patch, 0)?.toString()).toBe('diff --git a/x b/x\nindex 1..2 100644\n--- a/x\n+++ b/x\n@@ -1,2 +1,2 @@\n-a\r\n+b\r\n c\n')
    expect(hunkPatch(patch, 1)?.toString()).toBe('diff --git a/x b/x\nindex 1..2 100644\n--- a/x\n+++ b/x\n@@ -9 +9 @@\n-ü\n+ö\n')
  })

  it('has no section it does not have', () => {
    expect(hunkPatch(patch, 2)).toBeNull()
    expect(hunkPatch(patch, -1)).toBeNull()
  })
})

describe('FileTreeService staging and discarding', () => {
  let dir: string
  let service: FileTreeService
  /** What went to the recycle bin: the file's name and what it held. */
  let trashed: { name: string; content: string }[]

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'file-tree-stage-'))
    vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1')
    vi.stubEnv('GIT_CONFIG_GLOBAL', join(dir, 'no-gitconfig'))
    vi.stubEnv('GIT_CEILING_DIRECTORIES', tmpdir())
    vi.stubEnv('GIT_DIR', undefined)
    vi.stubEnv('GIT_WORK_TREE', undefined)
    trashed = []
    service = new FileTreeService(async (path) => {
      trashed.push({ name: path.split(/[\\/]/).pop()!, content: await readFile(path, 'utf8') })
      await rm(path)
    })
  })
  afterEach(async () => {
    vi.unstubAllEnvs()
    service.dispose()
    await rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
  })

  const git = (...args: string[]) =>
    execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'init.defaultBranch=main', ...args], {
      cwd: dir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
  const lines = (count: number, change: Record<number, string> = {}) =>
    Array.from({ length: count }, (_, i) => change[i + 1] ?? `line ${i + 1}`).join('\n') + '\n'

  async function repo(files: Record<string, string | Buffer>) {
    git('init', '-q')
    for (const [name, content] of Object.entries(files)) await writeFile(join(dir, name), content)
    git('add', '.')
    git('commit', '-qm', 'init')
    service.watch([{ root: dir, dirs: [''] }])
  }

  it('stages a file and takes it out again', async () => {
    await repo({ 'a.txt': 'one\n' })
    await writeFile(join(dir, 'a.txt'), 'two\n')
    await service.stage(dir, 'a.txt')
    expect(git('diff', '--cached', '--name-only')).toBe('a.txt\n')
    await service.unstage(dir, 'a.txt')
    expect(git('diff', '--cached', '--name-only')).toBe('')
    expect(await readFile(join(dir, 'a.txt'), 'utf8')).toBe('two\n')
  })

  it('takes a file out of the index before the first commit', async () => {
    git('init', '-q')
    service.watch([{ root: dir, dirs: [''] }])
    await writeFile(join(dir, 'new.txt'), 'x\n')
    await service.stage(dir, 'new.txt')
    expect(git('ls-files')).toBe('new.txt\n')
    await service.unstage(dir, 'new.txt')
    expect(git('ls-files')).toBe('')
  })

  it('discards the changes of a file, staged ones too, keeping the file as it was in the recycle bin', async () => {
    await repo({ 'a.txt': 'one\n' })
    await writeFile(join(dir, 'a.txt'), 'two\n')
    git('add', 'a.txt')
    await writeFile(join(dir, 'a.txt'), 'three\n')
    await service.discard(dir, 'a.txt')
    expect(await readFile(join(dir, 'a.txt'), 'utf8')).toBe('one\n')
    expect(git('status', '--porcelain')).toBe('')
    expect(trashed).toEqual([{ name: 'a.txt', content: 'three\n' }])
  })

  it('puts a file git did not have in the last commit into the recycle bin', async () => {
    await repo({ 'a.txt': 'one\n' })
    await writeFile(join(dir, 'new.txt'), 'new\n')
    await writeFile(join(dir, 'added.txt'), 'added\n')
    git('add', 'added.txt')
    await service.discard(dir, 'new.txt')
    await service.discard(dir, 'added.txt')
    expect(trashed).toEqual([
      { name: 'new.txt', content: 'new\n' },
      { name: 'added.txt', content: 'added\n' },
    ])
    expect(git('status', '--porcelain')).toBe('')
  })

  it('moves a file git mv moved back to its place', async () => {
    await repo({ 'old.txt': 'x\n' })
    git('mv', 'old.txt', 'new.txt')
    await service.discard(dir, 'new.txt')
    expect(await readFile(join(dir, 'old.txt'), 'utf8')).toBe('x\n')
    expect(git('status', '--porcelain')).toBe('')
  })

  it('stages one section of the changes and discards another', async () => {
    await repo({ 'f.txt': lines(30) })
    await writeFile(join(dir, 'f.txt'), lines(30, { 2: 'first change', 25: 'second change' }))
    const { patch } = await service.diff(dir, 'f.txt', false)
    await service.applyHunk(dir, 'f.txt', patch, 0, false)
    expect(git('diff', '--cached')).toContain('+first change')
    expect(git('diff', '--cached')).not.toContain('second change')

    const now = (await service.diff(dir, 'f.txt', false)).patch
    await service.applyHunk(dir, 'f.txt', now, 1, true)
    expect(await readFile(join(dir, 'f.txt'), 'utf8')).toBe(lines(30, { 2: 'first change' }))
    expect(trashed.map((t) => t.name)).toEqual(['f.txt'])
  })

  it('touches nothing when the file changed since it was shown, or is new', async () => {
    await repo({ 'f.txt': lines(5) })
    await writeFile(join(dir, 'f.txt'), lines(5, { 1: 'shown' }))
    const { patch } = await service.diff(dir, 'f.txt', false)
    await writeFile(join(dir, 'f.txt'), lines(5, { 1: 'changed since' }))
    await expect(service.applyHunk(dir, 'f.txt', patch, 0, true)).rejects.toThrow('hat sich inzwischen geändert')
    expect(await readFile(join(dir, 'f.txt'), 'utf8')).toBe(lines(5, { 1: 'changed since' }))

    await writeFile(join(dir, 'n.txt'), 'n\n')
    git('add', 'n.txt')
    const added = (await service.diff(dir, 'n.txt', false)).patch
    await expect(service.applyHunk(dir, 'n.txt', added, 0, true)).rejects.toThrow('nur als Ganzes')
    expect(trashed).toEqual([])
  })

  it('takes sections only of files in UTF-8, as the view shows others converted', async () => {
    await repo({ 'alt.txt': Buffer.from('Größe\n', 'latin1') })
    await writeFile(join(dir, 'alt.txt'), Buffer.from('Größer\n', 'latin1'))
    const { patch } = await service.diff(dir, 'alt.txt', false)
    expect(patch).toContain('+Größer')
    await expect(service.applyHunk(dir, 'alt.txt', patch, 0, false)).rejects.toThrow('nur bei Dateien in UTF-8')
  })

  it('works only in a repository', async () => {
    service.watch([{ root: dir, dirs: [''] }])
    await writeFile(join(dir, 'a.txt'), 'x')
    await expect(service.stage(dir, 'a.txt')).rejects.toThrow('in keinem Git-Repository')
  })
})
