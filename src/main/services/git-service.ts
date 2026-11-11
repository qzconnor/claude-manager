import { execFile } from 'node:child_process'
import { existsSync, watch, type FSWatcher } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import type { GitBranch, WorktreeCheck } from '@shared/types'
import { TypedEmitter } from '../lib/typed-emitter'

interface Watched {
  /** The working directories asked for that lie in this repository. */
  cwds: Set<string>
  watcher: FSWatcher
  timer: NodeJS.Timeout | null
}

/**
 * The checked-out branch of the repository a terminal works in. git itself only locates the
 * repository (worktrees and submodules included), so nothing shows without git. The branch comes
 * from the HEAD file, which is watched, so a checkout in the terminal shows up right away.
 */
export class GitService extends TypedEmitter<{ changed: [cwd: string, branch: GitBranch | null] }> {
  /** Only hits are kept: a folder can still become a repository later. */
  private readonly gitDirs = new Map<string, string>()
  /** By git directory: tabs in the same repository share one watcher. */
  private readonly watched = new Map<string, Watched>()
  /** Counts the calls of `watch`; an older one that finishes late changes nothing. */
  private generation = 0

  /** Null without git, outside a repository or with an unreadable HEAD. */
  async branch(cwd: string): Promise<GitBranch | null> {
    const gitDir = await this.gitDir(cwd)
    return gitDir ? readBranch(gitDir) : null
  }

  /**
   * Folder of the main checkout when `cwd` lies in a linked worktree of its repository (`git worktree add`,
   * `claude --worktree`, EnterWorktree); null in the main checkout itself, outside a repository and without git.
   */
  async mainWorktree(cwd: string): Promise<string | null> {
    const gitDir = await this.gitDir(cwd)
    return gitDir ? readMainWorktree(gitDir) : null
  }

  /**
   * Watches the repositories these folders lie in for checkouts, reported as `changed` for each folder.
   * Replaces the folders of the previous call; a folder that is no repository yet is picked up by a later one.
   */
  async watch(cwds: readonly string[]): Promise<void> {
    const generation = ++this.generation
    const found = await Promise.all([...new Set(cwds)].map(async (cwd) => [cwd, await this.gitDir(cwd)] as const))
    if (generation !== this.generation) return
    const wanted = new Map<string, Set<string>>()
    for (const [cwd, gitDir] of found) {
      if (gitDir) wanted.set(gitDir, (wanted.get(gitDir) ?? new Set()).add(cwd))
    }
    for (const gitDir of [...this.watched.keys()]) {
      if (!wanted.has(gitDir)) this.unwatch(gitDir)
    }
    for (const [gitDir, dirs] of wanted) {
      const watched = this.watched.get(gitDir)
      if (watched) watched.cwds = dirs
      else this.startWatching(gitDir, dirs)
    }
  }

  dispose(): void {
    this.generation++
    for (const gitDir of [...this.watched.keys()]) this.unwatch(gitDir)
  }

  /**
   * Whether Claude Code can make a worktree for a session in `cwd` (`claude --worktree`): that
   * takes a repository with at least one commit. Also names the worktrees it made there before.
   */
  async worktreeCheck(cwd: string): Promise<WorktreeCheck> {
    const root = await runGit(cwd, ['rev-parse', '--show-toplevel'])
    if (!root.ok) {
      return {
        ok: false,
        reason: root.missing ? 'Git ist nicht installiert oder nicht im PATH.' : 'Der Ordner liegt in keinem Git-Repository.',
      }
    }
    const head = await runGit(cwd, ['rev-parse', '--verify', '--quiet', 'HEAD'])
    if (!head.ok) return { ok: false, reason: 'Das Repository hat noch keinen Commit, von dem ein Worktree abzweigen kann.' }
    const list = await runGit(cwd, ['worktree', 'list', '--porcelain'])
    return { ok: true, root: root.out, existing: list.ok ? claudeWorktrees(list.out) : [] }
  }

  /**
   * Web page of the repository `cwd` lies in, from its remote: the upstream of the checked-out branch,
   * else `origin`, else the only remote (git picks it, with `url.*.insteadOf` applied). Null without one
   * or for a remote that has no web page (a local path, for example).
   */
  async webUrl(cwd: string): Promise<string | null> {
    const remote = await runGit(cwd, ['ls-remote', '--get-url'])
    return remote.ok ? repoWebUrl(remote.out) : null
  }

  private async gitDir(cwd: string): Promise<string | null> {
    const known = this.gitDirs.get(cwd)
    if (known) return known
    const gitDir = await new Promise<string | null>((resolve) => {
      execFile(
        'git',
        ['rev-parse', '--absolute-git-dir'],
        { cwd, windowsHide: true, timeout: 5000, encoding: 'utf8' },
        // Also fails if git is missing (ENOENT) or the folder doesn't exist.
        (error, stdout) => resolve(error ? null : stdout.trim() || null),
      )
    })
    if (gitDir) this.gitDirs.set(cwd, gitDir)
    return gitDir
  }

  private startWatching(gitDir: string, cwds: Set<string>): void {
    try {
      // git replaces HEAD through HEAD.lock, so the folder is watched, not the file.
      const watcher = watch(gitDir, (_event, file) => {
        if (file === 'HEAD') this.scheduleRead(gitDir)
      })
      watcher.on('error', () => this.unwatch(gitDir))
      this.watched.set(gitDir, { cwds, watcher, timer: null })
    } catch {
      // Not watchable: the window still asks again when it gets the focus.
    }
  }

  private scheduleRead(gitDir: string): void {
    const watched = this.watched.get(gitDir)
    if (!watched) return
    if (watched.timer) clearTimeout(watched.timer)
    watched.timer = setTimeout(() => {
      watched.timer = null
      void readBranch(gitDir).then((branch) => {
        if (this.watched.get(gitDir) !== watched) return
        for (const cwd of watched.cwds) this.emit('changed', cwd, branch)
      })
    }, 150)
  }

  private unwatch(gitDir: string): void {
    const watched = this.watched.get(gitDir)
    if (!watched) return
    if (watched.timer) clearTimeout(watched.timer)
    watched.watcher.close()
    this.watched.delete(gitDir)
  }
}

type GitResult = { ok: true; out: string } | { ok: false; missing: boolean }

function runGit(cwd: string, args: string[]): Promise<GitResult> {
  return new Promise((resolve) => {
    execFile('git', args, { cwd, windowsHide: true, timeout: 5000, encoding: 'utf8' }, (error, stdout) => {
      if (error) resolve({ ok: false, missing: (error as NodeJS.ErrnoException).code === 'ENOENT' && existsSync(cwd) })
      else resolve({ ok: true, out: stdout.trim() })
    })
  })
}

/** Names of the worktrees in `git worktree list --porcelain` that Claude Code made (`.claude/worktrees/<name>`). */
export function claudeWorktrees(porcelain: string): string[] {
  const names: string[] = []
  for (const line of porcelain.split(/\r?\n/)) {
    const match = /^worktree .*[\\/]\.claude[\\/]worktrees[\\/]([^\\/]+)[\\/]?$/.exec(line)
    if (match) names.push(match[1]!)
  }
  return names
}

/**
 * The web page behind a remote URL: `https://`, `ssh://`, `git://` and the scp-like `git@host:owner/repo`
 * all become `https://host/owner/repo`, without user, `.git` and the SSH port. Null for local paths.
 */
export function repoWebUrl(remote: string): string | null {
  const url = remote.trim()
  let origin: string
  let path: string
  const full = /^(https?|ssh|git|git\+ssh|ssh\+git):\/\/(?:[^@/]*@)?([^/:]+)(?::(\d*))?(\/.*)?$/i.exec(url)
  if (full) {
    const [, scheme, host, port, rest] = full
    // An http(s) remote is the page itself, port included; the port of SSH or git is not the web's.
    origin = /^https?$/i.test(scheme!) ? `${scheme!.toLowerCase()}://${host}${port ? `:${port}` : ''}` : `https://${host}`
    path = rest ?? ''
  } else {
    // scp-like syntax; a single letter before the colon is a Windows drive (`C:/repo`), not a host.
    const scp = /^(?:[^@/:]+@)?([^/:]{2,}):(?!\/\/)(.+)$/.exec(url)
    if (!scp) return null
    origin = `https://${scp[1]}`
    path = `/${scp[2]!.replace(/^\/+/, '')}`
  }
  path = path.replace(/\/+$/, '').replace(/\.git$/i, '').replace(/\/+$/, '')
  if (!path) return null
  // Azure DevOps names its repositories differently over SSH than on the web.
  const azure = /^https:\/\/ssh\.dev\.azure\.com$/i.test(origin) && /^\/v3\/([^/]+)\/([^/]+)\/([^/]+)$/.exec(path)
  if (azure) return `https://dev.azure.com/${azure[1]}/${azure[2]}/_git/${azure[3]}`
  return origin + path
}

/**
 * Only the git directory of a linked worktree (`<repository>/.git/worktrees/<name>`) has a `commondir` file:
 * it leads to the repository's own git directory, whose folder is the main checkout. A bare repository has
 * no checkout of its own; then its folder stands in. Submodules have no `commondir` either.
 */
async function readMainWorktree(gitDir: string): Promise<string | null> {
  try {
    const common = resolve(gitDir, (await readFile(join(gitDir, 'commondir'), 'utf8')).trim())
    return basename(common).toLowerCase() === '.git' ? dirname(common) : common
  } catch {
    return null
  }
}

/** `ref: refs/heads/<name>` names the branch; a bare commit hash means a detached HEAD. */
async function readBranch(gitDir: string): Promise<GitBranch | null> {
  try {
    const head = (await readFile(join(gitDir, 'HEAD'), 'utf8')).trim()
    const ref = /^ref:\s*(?:refs\/heads\/)?(.+)$/.exec(head)
    if (ref) return { name: ref[1], detached: false }
    return /^[0-9a-f]{40,64}$/i.test(head) ? { name: head.slice(0, 7), detached: true } : null
  } catch {
    return null
  }
}
