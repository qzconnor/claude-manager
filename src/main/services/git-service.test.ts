import { execFileSync } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GitBranch } from '@shared/types'
import { claudeWorktrees, GitService } from './git-service'

const HASH = '0123456789abcdef0123456789abcdef01234567'

let dir: string
let service: GitService

/** Runs git without the user's configuration getting in the way (templates, hooks, default branch). */
function git(cwd: string, ...args: string[]): void {
  execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'init.defaultBranch=main', ...args], {
    cwd,
    stdio: 'ignore',
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(dir, 'no-gitconfig') },
  })
}

async function repo(name = 'repo'): Promise<string> {
  const path = join(dir, name)
  await mkdir(path, { recursive: true })
  git(path, 'init', '-q')
  return path
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'cm-test-'))
  // GitService runs git with this environment: no repository above the temp folder, none set by a git hook.
  vi.stubEnv('GIT_CEILING_DIRECTORIES', tmpdir())
  vi.stubEnv('GIT_DIR', undefined)
  vi.stubEnv('GIT_WORK_TREE', undefined)
  service = new GitService()
})

afterEach(async () => {
  service.dispose()
  vi.unstubAllEnvs()
  await rm(dir, { recursive: true, force: true, maxRetries: 3 })
})

describe('GitService.branch', () => {
  it('reads the checked-out branch', async () => {
    const path = await repo()
    expect(await service.branch(path)).toEqual({ name: 'main', detached: false })
  })

  it('keeps slashes in branch names', async () => {
    const path = await repo()
    git(path, 'symbolic-ref', 'HEAD', 'refs/heads/feature/login-flow')
    expect(await service.branch(path)).toEqual({ name: 'feature/login-flow', detached: false })
  })

  it('finds the repository from a subfolder', async () => {
    const path = await repo()
    const sub = join(path, 'src', 'deep')
    await mkdir(sub, { recursive: true })
    expect(await service.branch(sub)).toEqual({ name: 'main', detached: false })
  })

  it('shows a detached HEAD as the short commit hash', async () => {
    const path = await repo()
    await writeFile(join(path, '.git', 'HEAD'), `${HASH}\n`)
    expect(await service.branch(path)).toEqual({ name: '0123456', detached: true })
  })

  it('follows a .git file to the repository elsewhere', async () => {
    const path = join(dir, 'work')
    await mkdir(path)
    git(path, 'init', '-q', '--separate-git-dir', join(dir, 'store.git'))
    git(path, 'symbolic-ref', 'HEAD', 'refs/heads/separate')
    expect(await service.branch(path)).toEqual({ name: 'separate', detached: false })
  })

  it('reads the branch of a worktree, not the one of the main checkout', async () => {
    const main = await repo('main')
    git(main, 'commit', '-q', '--allow-empty', '-m', 'init')
    git(main, 'worktree', 'add', '-q', '-b', 'side', join(dir, 'side'))
    expect(await service.branch(join(dir, 'side'))).toEqual({ name: 'side', detached: false })
    expect(await service.branch(main)).toEqual({ name: 'main', detached: false })
  })

  it('is null outside a repository and for a missing folder', async () => {
    expect(await service.branch(dir)).toBeNull()
    expect(await service.branch(join(dir, 'missing'))).toBeNull()
  })

  it('notices a folder that became a repository later', async () => {
    const path = join(dir, 'later')
    await mkdir(path)
    expect(await service.branch(path)).toBeNull()
    git(path, 'init', '-q')
    expect(await service.branch(path)).toEqual({ name: 'main', detached: false })
  })

  it('is null for a HEAD it cannot read', async () => {
    const path = await repo()
    expect(await service.branch(path)).not.toBeNull()
    // The repository is known now; its HEAD goes missing.
    await rm(join(path, '.git', 'HEAD'))
    expect(await service.branch(path)).toBeNull()
  })

  it('reports a checkout in the watched repository', async () => {
    const path = await repo()
    const changes: [string, GitBranch | null][] = []
    service.on('changed', (cwd, branch) => changes.push([cwd, branch]))
    await service.branch(path)
    await writeFile(join(path, '.git', 'HEAD'), 'ref: refs/heads/next\n')
    await expect.poll(() => changes.at(-1), { timeout: 5000 }).toEqual([path, { name: 'next', detached: false }])
  })

  it('stops reporting after dispose', async () => {
    const path = await repo()
    const changes: unknown[] = []
    service.on('changed', (...args) => changes.push(args))
    await service.branch(path)
    service.dispose()
    await writeFile(join(path, '.git', 'HEAD'), 'ref: refs/heads/next\n')
    await new Promise((resolve) => setTimeout(resolve, 400))
    expect(changes).toEqual([])
  })
})

describe('worktreeCheck', () => {
  it('needs a repository', async () => {
    const plain = join(dir, 'plain')
    await mkdir(plain)
    expect(await service.worktreeCheck(plain)).toEqual({ ok: false, reason: 'Der Ordner liegt in keinem Git-Repository.' })
  })

  it('needs a commit to branch from', async () => {
    const path = await repo()
    expect(await service.worktreeCheck(path)).toMatchObject({ ok: false, reason: expect.stringContaining('keinen Commit') })
  })

  it("names the root and the worktrees Claude Code made there", async () => {
    const path = await repo()
    await writeFile(join(path, 'a.txt'), 'a')
    git(path, 'add', '.')
    git(path, 'commit', '-qm', 'init')
    git(path, 'worktree', 'add', '-q', '-b', 'worktree-login', join(path, '.claude', 'worktrees', 'login'))
    git(path, 'worktree', 'add', '-q', '-b', 'elsewhere', join(dir, 'elsewhere'))
    const check = await service.worktreeCheck(join(path, '.claude'))
    expect(check).toMatchObject({ ok: true, existing: ['login'] })
    // Git names the real path: on CI runners the temp folder comes as a short name (`RUNNER~1`).
    const same = (p: string) => realpathSync.native(p).replaceAll('\\', '/').toLowerCase()
    expect(check.ok && same(check.root)).toBe(same(path))
  })
})

describe('claudeWorktrees', () => {
  it('picks the worktrees under .claude/worktrees', () => {
    const porcelain = [
      'worktree F:/Code/app',
      'HEAD 0123',
      'branch refs/heads/main',
      '',
      'worktree F:/Code/app/.claude/worktrees/login-fix',
      'HEAD 4567',
      'branch refs/heads/worktree-login-fix',
      'locked',
      '',
      'worktree F:/Code/other',
    ].join('\n')
    expect(claudeWorktrees(porcelain)).toEqual(['login-fix'])
  })
})
