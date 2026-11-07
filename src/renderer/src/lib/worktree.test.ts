import { describe, expect, it } from 'vitest'
import { worktreeArgs, worktreeNameError } from './worktree'

describe('worktreeNameError', () => {
  it('accepts an empty name and names that suit a folder and a branch', () => {
    for (const name of ['', '  ', 'login-fix', 'v2.1', 'Feature_42']) expect(worktreeNameError(name)).toBeNull()
  })

  it('refuses spaces, slashes, umlauts and what git refuses', () => {
    for (const name of ['login fix', 'a/b', 'grüße', '-x', '.hidden', 'a..b', 'end.', 'main.lock', 'x'.repeat(65)]) {
      expect(worktreeNameError(name), name).not.toBeNull()
    }
  })
})

describe('worktreeArgs', () => {
  it('passes the name, or lets Claude Code pick one', () => {
    expect(worktreeArgs(' login ')).toEqual(['--worktree', 'login'])
    expect(worktreeArgs('')).toEqual(['--worktree'])
  })
})
