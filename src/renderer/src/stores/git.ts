import { defineStore } from 'pinia'
import { reactive, watch } from 'vue'
import type { GitBranch } from '@shared/types'
import { useAppStore } from './app'

export interface GitRepo {
  /** Null outside a repository or without git. */
  branch: GitBranch | null
  /** Page of the repository on GitHub, GitLab …; null without a remote that has one. */
  webUrl: string | null
}

/**
 * Branch and web page of the repositories the shown tabs work in, by folder. Components hold the
 * folders they show (`useGitBranch`); main watches their repositories for checkouts while one does.
 */
export const useGitStore = defineStore('git', () => {
  const app = useAppStore()
  /** Missing while the folder is loaded for the first time. */
  const repos = reactive(new Map<string, GitRepo>())
  /** How many components hold each folder. */
  const holders = new Map<string, number>()
  /** The latest load of each folder; an older answer is dropped. */
  const pending = new Map<string, number>()
  let loads = 0
  let flushQueued = false
  let watching = ''

  async function load(dir: string): Promise<void> {
    const id = ++loads
    pending.set(dir, id)
    const [branch, webUrl] = await Promise.all([
      window.api.git.branch(dir).catch(() => null),
      window.api.git.webUrl(dir).catch(() => null),
    ])
    if (pending.get(dir) !== id) return
    pending.delete(dir)
    if (holders.has(dir)) repos.set(dir, { branch, webUrl })
  }

  /**
   * Once per tick: a tab moved to another group lets go of its folder and takes it again, which
   * neither drops the branch nor loads it anew.
   */
  function queueFlush(): void {
    if (flushQueued) return
    flushQueued = true
    queueMicrotask(() => {
      flushQueued = false
      for (const dir of repos.keys()) {
        if (!holders.has(dir)) repos.delete(dir)
      }
      sendWatch()
    })
  }

  function sendWatch(force = false): void {
    const dirs = [...holders.keys()]
    const key = JSON.stringify(dirs)
    if (!force && key === watching) return
    watching = key
    void window.api.git.watch(dirs).catch(() => {})
  }

  function hold(dir: string): void {
    holders.set(dir, (holders.get(dir) ?? 0) + 1)
    if (!repos.has(dir) && !pending.has(dir)) void load(dir)
    queueFlush()
  }

  function release(dir: string): void {
    const count = (holders.get(dir) ?? 0) - 1
    if (count > 0) holders.set(dir, count)
    else holders.delete(dir)
    queueFlush()
  }

  // Main watches the repositories for checkouts; this also catches a folder that became one or got a remote.
  watch(
    () => app.windowState.focused,
    (focused) => {
      if (!focused) return
      for (const dir of holders.keys()) void load(dir)
      sendWatch(true)
    },
  )

  window.api.git.onBranchChanged((dir, branch) => {
    const repo = repos.get(dir)
    if (repo) repo.branch = branch
  })

  return { repos, hold, release }
})
