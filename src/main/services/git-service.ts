import { execFile } from 'node:child_process'
import { existsSync, watch, type FSWatcher } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { GitBranch, WorktreeCheck } from '@shared/types'
import { TypedEmitter } from '../lib/typed-emitter'

interface Watched {
  /** The working directory last asked for; several can share one repository. */
  cwd: string
  gitDir: string
  watcher: FSWatcher
}

/**
 * The checked-out branch of the repository a terminal works in. git itself only locates the
 * repository (worktrees and submodules included), so nothing shows without git. The branch comes
 * from the HEAD file, which is watched, so a checkout in the terminal shows up right away.
 */
export class GitService extends TypedEmitter<{ changed: [cwd: string, branch: GitBranch | null] }> {
  /** Only hits are kept: a folder can still become a repository later. */
  private readonly gitDirs = new Map<string, string>()
  private watched: Watched | null = null
  private timer: NodeJS.Timeout | null = null

  /** Null without git, outside a repository or with an unreadable HEAD. Watches the latest `cwd` only. */
  async branch(cwd: string): Promise<GitBranch | null> {
    const gitDir = await this.gitDir(cwd)
    if (!gitDir) {
      this.unwatch()
      return null
    }
    this.watch(cwd, gitDir)
    return readBranch(gitDir)
  }

  dispose(): void {
    this.unwatch()
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

  private watch(cwd: string, gitDir: string): void {
    if (this.watched?.gitDir === gitDir) {
      this.watched.cwd = cwd
      return
    }
    this.unwatch()
    try {
      // git replaces HEAD through HEAD.lock, so the folder is watched, not the file.
      const watcher = watch(gitDir, (_event, file) => {
        if (file === 'HEAD') this.scheduleRead()
      })
      watcher.on('error', () => this.unwatch())
      this.watched = { cwd, gitDir, watcher }
    } catch {
      // Not watchable: the window still asks again when it gets the focus.
    }
  }

  private scheduleRead(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      this.timer = null
      const watched = this.watched
      if (!watched) return
      void readBranch(watched.gitDir).then((branch) => {
        if (this.watched === watched) this.emit('changed', watched.cwd, branch)
      })
    }, 150)
  }

  private unwatch(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.watched?.watcher.close()
    this.watched = null
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
