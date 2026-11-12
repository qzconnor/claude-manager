import { answerCost } from '@shared/model-prices'
import { weightedTokens } from '@shared/token-stats'
import type { SessionTokenRow, TokenStatsResult, TokenTuple } from './indexer-protocol'
import type { ParsedSummary, UsageEntry } from './transcript-parser'

/** The requests of one transcript: a session's own or one of its subagents'. */
export interface UsageSource {
  projectKey: string
  sessionId: string
  usage: UsageEntry[]
}

/** How many sessions `aggregateTokenStats` names, the most expensive. */
export const TOP_SESSIONS = 20

const emptyTuple = (): TokenTuple => [0, 0, 0, 0, 0, 0]

function getOrAdd(map: Map<string, TokenTuple>, key: string): TokenTuple {
  let acc = map.get(key)
  if (!acc) {
    acc = emptyTuple()
    map.set(key, acc)
  }
  return acc
}

const weight = (t: TokenTuple) => weightedTokens({ input: t[0], output: t[1], cacheCreation: t[2], cacheRead: t[3] })

/** Most expensive first, at the same cost (e.g. models without a price) the one with more tokens. */
const byCost = (a: TokenTuple, b: TokenTuple) => b[5] - a[5] || weight(b) - weight(a)

/**
 * Adds up the requests since `sinceDay` (local, YYYY-MM-DD) by day, model, folder and session, each
 * request once even when several transcripts record it, with what it costs at the API's prices.
 * `summaryOf` gives the summary of a session's own transcript: the folder, title and model, also for
 * the usage of its subagents.
 */
export function aggregateTokenStats(
  sources: Iterable<UsageSource>,
  sinceDay: string,
  summaryOf: (projectKey: string, sessionId: string) => ParsedSummary | null | undefined,
): TokenStatsResult {
  const seen = new Set<string>()
  const byDay = new Map<string, TokenTuple>()
  const byModel = new Map<string, TokenTuple>()
  const bySession = new Map<string, { projectKey: string; sessionId: string; tokens: TokenTuple }>()
  let unpriced = 0

  for (const { projectKey, sessionId, usage } of sources) {
    const sessionKey = `${projectKey}\n${sessionId}`
    for (const [key, day, model, input, output, cacheCreation, cacheRead, cacheCreation1h, fast] of usage) {
      if (day < sinceDay || seen.has(key)) continue
      seen.add(key)
      let session = bySession.get(sessionKey)
      if (!session) {
        session = { projectKey, sessionId, tokens: emptyTuple() }
        bySession.set(sessionKey, session)
      }
      const cost = answerCost(model, { input, output, cacheCreation, cacheCreation1h, cacheRead, fast: fast === 1 })
      if (cost === null) unpriced += 1
      for (const acc of [getOrAdd(byDay, day), getOrAdd(byModel, model), session.tokens]) {
        acc[0] += input
        acc[1] += output
        acc[2] += cacheCreation
        acc[3] += cacheRead
        acc[4] += 1
        acc[5] += cost ?? 0
      }
    }
  }

  const byFolder = new Map<string, { path: string | null; projectKey: string; tokens: TokenTuple; sessions: number }>()
  const sessions: SessionTokenRow[] = []
  for (const { projectKey, sessionId, tokens } of bySession.values()) {
    const summary = summaryOf(projectKey, sessionId)
    const path = summary?.worktree?.originalCwd ?? summary?.cwd ?? null
    const key = path ?? `#${projectKey}`
    const folder = byFolder.get(key) ?? { path, projectKey, tokens: emptyTuple(), sessions: 0 }
    for (let i = 0; i < tokens.length; i++) folder.tokens[i]! += tokens[i]!
    folder.sessions += 1
    byFolder.set(key, folder)
    sessions.push({ projectKey, sessionId, path, title: summary?.title ?? null, model: summary?.model ?? null, tokens })
  }

  return {
    days: [...byDay.entries()].sort(([a], [b]) => a.localeCompare(b)),
    models: [...byModel.entries()].sort(([, a], [, b]) => byCost(a, b)),
    folders: [...byFolder.values()].map((f) => [f.path, f.projectKey, f.tokens, f.sessions]),
    sessions: sessions.sort((a, b) => byCost(a.tokens, b.tokens)).slice(0, TOP_SESSIONS),
    sessionCount: new Set([...bySession.values()].map((s) => s.sessionId)).size,
    unpriced,
  }
}
