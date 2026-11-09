import { computed, onScopeDispose, toValue, watch, type ComputedRef, type MaybeRefOrGetter } from 'vue'
import { useGitStore, type GitRepo } from '@/stores/git'

/**
 * Branch and web page of the repository `dir` lies in, kept current while the component lives:
 * checkouts show up right away. Null without a folder, outside a repository and while loading.
 */
export function useGitBranch(dir: MaybeRefOrGetter<string | null | undefined>): ComputedRef<GitRepo | null> {
  const git = useGitStore()
  let held: string | null = null

  watch(
    () => toValue(dir) || null,
    (next) => {
      if (next === held) return
      if (next) git.hold(next)
      if (held) git.release(held)
      held = next
    },
    { immediate: true },
  )
  onScopeDispose(() => {
    if (held) git.release(held)
    held = null
  })

  // While another folder loads, the last answer stays: switching between two repositories doesn't
  // blink through "no branch".
  let last: GitRepo | null = null
  return computed(() => {
    const current = toValue(dir)
    if (!current) return (last = null)
    const repo = git.repos.get(current)
    if (repo) last = repo.branch ? repo : null
    return last
  })
}
