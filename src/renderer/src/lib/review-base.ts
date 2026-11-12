import type { GitTreeStatus, ReviewBase } from '@shared/types'

/** The changes a review shows: those not committed yet, or all since the branch started (`ReviewBase`). */
export type ReviewMode = 'head' | 'base'

/**
 * The folder's changes since its branch started as git's state of it, so the review shows them like the
 * uncommitted ones: the files changed since (`review`) and the new ones git doesn't know yet (`git`).
 */
export function reviewStatus(git: GitTreeStatus | null, review: ReviewBase): GitTreeStatus {
  const files = { ...review.files }
  for (const [path, state] of Object.entries(git?.files ?? {})) if (state.status === 'untracked' && !(path in files)) files[path] = state
  const truncated = review.truncated || (git?.truncated ?? false)
  if (git) return { ...git, files, truncated }
  return { branch: review.branch, commit: null, upstream: null, ahead: 0, behind: 0, files, ignored: [], truncated }
}

/** What the review since the branch started is called: on the main branch the commits not pushed yet. */
export function reviewLabel(review: ReviewBase): string {
  const base = review.base.slice(review.base.indexOf('/') + 1)
  return base === review.branch ? 'Nicht gepusht' : `Seit Abzweig von ${review.base}`
}

export function commitsLabel(count: number, truncated = false): string {
  return `${truncated ? 'über ' : ''}${count.toLocaleString('de-DE')} ${count === 1 ? 'Commit' : 'Commits'}`
}
