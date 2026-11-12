import { describe, expect, it } from 'vitest'
import type { FolderTokenStats } from './types'
import { mergeFolderStats, weightedTokens } from './token-stats'

function folder(path: string | null, patch: Partial<FolderTokenStats> = {}): FolderTokenStats {
  return {
    path,
    projectKey: path ? path.replace(/[^a-zA-Z0-9]/g, '-') : 'unknown',
    input: 0,
    output: 0,
    cacheCreation: 0,
    cacheRead: 0,
    messages: 1,
    cost: 0,
    sessionCount: 1,
    ...patch,
  }
}

describe('weightedTokens', () => {
  it('weighs the tokens as the API prices them', () => {
    expect(weightedTokens({ input: 10, output: 10, cacheCreation: 100, cacheRead: 1000 })).toBe(10 + 50 + 125 + 100)
  })
})

describe('mergeFolderStats', () => {
  it('adds up spellings of the same folder and names it by the larger one', () => {
    const merged = mergeFolderStats([
      folder('F:\\Code\\app', { output: 10, messages: 2 }),
      folder('f:/code/app/', { output: 100, messages: 3, sessionCount: 2, cost: 1.5 }),
    ])
    expect(merged).toEqual([
      folder('f:/code/app/', { output: 110, messages: 5, sessionCount: 3, cost: 1.5, projectKey: 'f--code-app-' }),
    ])
  })

  it('keeps folders without a path apart by their project key and sorts the largest first', () => {
    const merged = mergeFolderStats([
      folder(null, { projectKey: 'a', cacheRead: 1000 }),
      folder(null, { projectKey: 'b', output: 30 }),
      folder('C:\\x', { input: 50 }),
    ])
    expect(merged.map((f) => f.path ?? f.projectKey)).toEqual(['b', 'a', 'C:\\x'])
  })

  it('sorts the most expensive first, before more tokens', () => {
    const merged = mergeFolderStats([
      folder('C:\\a', { output: 1000 }),
      folder('C:\\b', { output: 1, cost: 0.02 }),
      folder('C:\\c', { output: 1, cost: 0.5 }),
    ])
    expect(merged.map((f) => f.path)).toEqual(['C:\\c', 'C:\\b', 'C:\\a'])
  })
})
