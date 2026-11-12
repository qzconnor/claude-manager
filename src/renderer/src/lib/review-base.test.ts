import { describe, expect, it } from 'vitest'
import type { GitFileState, GitTreeStatus, ReviewBase } from '@shared/types'
import { commitsLabel, reviewLabel, reviewStatus } from './review-base'

const state = (status: GitFileState['status'], staged = false): GitFileState => ({ status, staged, added: null, removed: null })

const review = (over: Partial<ReviewBase> = {}): ReviewBase => ({
  base: 'origin/main',
  mergeBase: 'a'.repeat(40),
  branch: 'feat',
  commits: [],
  commitsTruncated: false,
  files: { 'a.ts': state('modified'), 'b.ts': state('added') },
  truncated: false,
  pullRequestUrl: null,
  ...over,
})

describe('reviewStatus', () => {
  const git: GitTreeStatus = {
    branch: 'feat',
    commit: 'abc1234',
    upstream: 'origin/feat',
    ahead: 2,
    behind: 0,
    files: { 'a.ts': state('modified', true), 'new.ts': state('untracked'), 'dir/': state('untracked'), 'gone.ts': state('deleted') },
    ignored: ['dist/'],
    truncated: false,
  }

  it('shows the files changed since the branch started and the new ones git doesn’t know yet', () => {
    expect(reviewStatus(git, review())).toEqual({
      ...git,
      files: { 'a.ts': state('modified'), 'b.ts': state('added'), 'new.ts': state('untracked'), 'dir/': state('untracked') },
    })
  })

  it('keeps a file the branch deleted as deleted, though a new one of the name is there', () => {
    const deleted = review({ files: { 'x.ts': state('deleted') } })
    expect(reviewStatus({ ...git, files: { 'x.ts': state('untracked') } }, deleted).files).toEqual({ 'x.ts': state('deleted') })
  })

  it('is cut when either is, and goes without git’s state', () => {
    expect(reviewStatus({ ...git, truncated: true }, review()).truncated).toBe(true)
    expect(reviewStatus(git, review({ truncated: true })).truncated).toBe(true)
    expect(reviewStatus(null, review())).toEqual({
      branch: 'feat',
      commit: null,
      upstream: null,
      ahead: 0,
      behind: 0,
      files: review().files,
      ignored: [],
      truncated: false,
    })
  })
})

describe('reviewLabel', () => {
  it('names the branch it started from, on that branch itself what isn’t pushed', () => {
    expect(reviewLabel(review())).toBe('Seit Abzweig von origin/main')
    expect(reviewLabel(review({ base: 'main' }))).toBe('Seit Abzweig von main')
    expect(reviewLabel(review({ branch: 'main' }))).toBe('Nicht gepusht')
    expect(reviewLabel(review({ base: 'origin/release/1.0', branch: 'release/1.0' }))).toBe('Nicht gepusht')
    expect(reviewLabel(review({ branch: null }))).toBe('Seit Abzweig von origin/main')
  })
})

describe('commitsLabel', () => {
  it('counts the commits, more when not all are there', () => {
    expect([commitsLabel(1), commitsLabel(3), commitsLabel(1200), commitsLabel(200, true)]).toEqual([
      '1 Commit',
      '3 Commits',
      '1.200 Commits',
      'über 200 Commits',
    ])
  })
})
