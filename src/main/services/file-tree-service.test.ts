import { execFileSync } from 'node:child_process'
import { chmod, mkdtemp, mkdir, readFile, rm, symlink, unlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FileTreeService, filterGuard, gitStateChange, isTreePath, parseGitStatus } from './file-tree-service'

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
  })

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
