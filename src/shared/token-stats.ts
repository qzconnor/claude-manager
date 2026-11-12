import { folderKey } from './folders'
import type { FolderTokenStats, TokenCounts } from './types'

/**
 * What a token costs compared with an input token in the API's price list, the same for every
 * model: output five times as much, writing the cache a quarter more, reading it a tenth. A folder's
 * share of the usage is reckoned with these, so the cheap cache reads don't outweigh everything.
 */
export const TOKEN_WEIGHTS = { input: 1, output: 5, cacheCreation: 1.25, cacheRead: 0.1 } as const

type Tokens = Pick<TokenCounts, 'input' | 'output' | 'cacheCreation' | 'cacheRead'>

/** The tokens in input-token equivalents (see `TOKEN_WEIGHTS`). */
export function weightedTokens(tokens: Tokens): number {
  return (
    tokens.input * TOKEN_WEIGHTS.input +
    tokens.output * TOKEN_WEIGHTS.output +
    tokens.cacheCreation * TOKEN_WEIGHTS.cacheCreation +
    tokens.cacheRead * TOKEN_WEIGHTS.cacheRead
  )
}

/** Most expensive first, at the same cost (e.g. models without a price) the one with more tokens. */
export function byCost(a: TokenCounts, b: TokenCounts): number {
  return b.cost - a.cost || weightedTokens(b) - weightedTokens(a)
}

/**
 * Adds up folders that are one by `folderKey` (`F:\Code` and `f:\code\`), those without a path by
 * Claude's project key. The spelling with the most usage names the folder. Most expensive first.
 */
export function mergeFolderStats(folders: FolderTokenStats[]): FolderTokenStats[] {
  const merged = new Map<string, { stats: FolderTokenStats; lead: number }>()
  for (const folder of folders) {
    const key = folder.path?.trim() ? folderKey(folder.path) : `#${folder.projectKey}`
    const weight = weightedTokens(folder)
    const entry = merged.get(key)
    if (!entry) {
      merged.set(key, { stats: { ...folder }, lead: weight })
      continue
    }
    const { stats } = entry
    if (weight > entry.lead) {
      stats.path = folder.path
      stats.projectKey = folder.projectKey
      entry.lead = weight
    }
    stats.input += folder.input
    stats.output += folder.output
    stats.cacheCreation += folder.cacheCreation
    stats.cacheRead += folder.cacheRead
    stats.messages += folder.messages
    stats.cost += folder.cost
    stats.sessionCount += folder.sessionCount
  }
  return [...merged.values()].map((e) => e.stats).sort(byCost)
}
