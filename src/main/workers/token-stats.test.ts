import { describe, expect, it } from 'vitest'
import { aggregateTokenStats, TOP_SESSIONS, type UsageSource } from './token-stats'
import type { ParsedSummary, UsageEntry } from './transcript-parser'

const OPUS = 'claude-opus-4-6'
const MILLION = 1_000_000

/** An answer of `model` on `day` with `output` tokens only, which cost 25 dollars per million at Opus 4.6. */
const answer = (key: string, day: string, output: number, model = OPUS, extra: Partial<Record<number, number>> = {}): UsageEntry => {
  const entry: UsageEntry = [key, day, model, 0, output, 0, 0, 0, 0]
  for (const [i, v] of Object.entries(extra)) (entry as unknown as number[])[Number(i)] = v!
  return entry
}

const summary = (id: string, cwd: string | null, extra: Partial<ParsedSummary> = {}): ParsedSummary => ({
  id,
  cwd,
  worktree: null,
  title: `Titel ${id}`,
  firstPrompt: null,
  lastPrompt: null,
  gitBranch: null,
  model: OPUS,
  messageCount: 1,
  createdAt: null,
  updatedAt: null,
  version: null,
  continuedIn: null,
  ...extra,
})

const summaries =
  (byId: Record<string, ParsedSummary>) =>
  (_projectKey: string, sessionId: string): ParsedSummary | undefined =>
    byId[sessionId]

describe('aggregateTokenStats', () => {
  it('adds up by day, model, folder and session with the cost of every answer', () => {
    const sources: UsageSource[] = [
      {
        projectKey: 'F--a',
        sessionId: 's1',
        usage: [answer('m1', '2026-11-10', MILLION), answer('m2', '2026-11-11', 2 * MILLION, 'claude-sonnet-4-6')],
      },
      // A subagent of s1: its usage counts for s1 and its folder.
      { projectKey: 'F--a', sessionId: 's1', usage: [answer('m3', '2026-11-11', MILLION)] },
      { projectKey: 'F--b', sessionId: 's2', usage: [answer('m4', '2026-11-11', MILLION, OPUS, { 3: 10, 5: 20, 6: 30 })] },
    ]
    const stats = aggregateTokenStats(sources, '2026-11-01', summaries({ s1: summary('s1', 'F:\\a'), s2: summary('s2', 'F:\\b') }))
    expect(stats.days).toEqual([
      ['2026-11-10', [0, MILLION, 0, 0, 1, 25]],
      // Input 10 at 5, cache writes 20 at 6.25 and reads 30 at 0.5 dollars per million.
      ['2026-11-11', [10, 4 * MILLION, 20, 30, 3, expect.closeTo(30 + 25 + 25 + 0.000_05 + 0.000_125 + 0.000_015, 9)]],
    ])
    expect(stats.models.map(([model, t]) => [model, t[5]])).toEqual([
      [OPUS, expect.closeTo(75.000_19, 5)],
      ['claude-sonnet-4-6', 30],
    ])
    expect(stats.folders).toEqual([
      ['F:\\a', 'F--a', [0, 4 * MILLION, 0, 0, 3, 80], 1],
      ['F:\\b', 'F--b', [10, MILLION, 20, 30, 1, expect.closeTo(25.000_19, 5)], 1],
    ])
    expect(stats.sessions).toEqual([
      { projectKey: 'F--a', sessionId: 's1', path: 'F:\\a', title: 'Titel s1', model: OPUS, tokens: [0, 4 * MILLION, 0, 0, 3, 80] },
      {
        projectKey: 'F--b',
        sessionId: 's2',
        path: 'F:\\b',
        title: 'Titel s2',
        model: OPUS,
        tokens: [10, MILLION, 20, 30, 1, expect.closeTo(25.000_19, 5)],
      },
    ])
    expect(stats.sessionCount).toBe(2)
    expect(stats.unpriced).toBe(0)
  })

  it('counts every request once and skips what is older than the first day', () => {
    const sources: UsageSource[] = [
      { projectKey: 'F--a', sessionId: 's1', usage: [answer('m1', '2026-10-31', MILLION), answer('m2', '2026-11-01', MILLION)] },
      { projectKey: 'F--a', sessionId: 's1', usage: [answer('m2', '2026-11-01', MILLION)] },
    ]
    const stats = aggregateTokenStats(sources, '2026-11-01', summaries({}))
    expect(stats.days).toEqual([['2026-11-01', [0, MILLION, 0, 0, 1, 25]]])
  })

  it('prices fast mode and the cache writes for an hour', () => {
    const fast = answer('m1', '2026-11-11', MILLION, 'claude-opus-5-5', { 8: 1 })
    const hour = answer('m2', '2026-11-11', 0, OPUS, { 5: MILLION, 7: MILLION })
    const stats = aggregateTokenStats([{ projectKey: 'F--a', sessionId: 's1', usage: [fast, hour] }], '2026-11-01', summaries({}))
    expect(stats.models).toEqual([
      ['claude-opus-5-5', [0, MILLION, 0, 0, 1, 40]],
      [OPUS, [0, 0, MILLION, 0, 1, 10]],
    ])
  })

  it('counts answers of models without a price, which add no cost', () => {
    const usage = [answer('m1', '2026-11-11', MILLION, 'gpt-5'), answer('m2', '2026-11-11', MILLION)]
    const stats = aggregateTokenStats([{ projectKey: 'F--a', sessionId: 's1', usage }], '2026-11-01', summaries({}))
    expect(stats.unpriced).toBe(1)
    expect(stats.days[0]![1][5]).toBe(25)
    // The models by cost, those without a price last.
    expect(stats.models.map(([model]) => model)).toEqual([OPUS, 'gpt-5'])
  })

  it('knows the folder a worktree session was started in, and sessions without a transcript of their own', () => {
    const worktree = { name: 'wt', path: 'F:\\a\\.wt', originalCwd: 'F:\\a' } as ParsedSummary['worktree']
    const sources: UsageSource[] = [
      { projectKey: 'F--a', sessionId: 's1', usage: [answer('m1', '2026-11-11', 1)] },
      { projectKey: 'F--a-wt', sessionId: 's2', usage: [answer('m2', '2026-11-11', 1)] },
      { projectKey: 'F--gone', sessionId: 's3', usage: [answer('m3', '2026-11-11', 1)] },
    ]
    const stats = aggregateTokenStats(
      sources,
      '2026-11-01',
      summaries({ s1: summary('s1', 'F:\\a'), s2: summary('s2', 'F:\\a\\.wt', { worktree }) }),
    )
    expect(stats.folders.map(([path, key, , n]) => [path, key, n])).toEqual([
      ['F:\\a', 'F--a', 2],
      [null, 'F--gone', 1],
    ])
    expect(stats.sessions.find((s) => s.sessionId === 's3')).toMatchObject({ path: null, title: null, model: null })
  })

  it('names the most expensive sessions, at the same cost those with more tokens first', () => {
    const sources: UsageSource[] = Array.from({ length: TOP_SESSIONS + 5 }, (_, i) => ({
      projectKey: 'F--a',
      sessionId: `s${i}`,
      usage: [answer(`m${i}`, '2026-11-11', (i + 1) * 1000)],
    }))
    sources.push({ projectKey: 'F--a', sessionId: 'free1', usage: [answer('f1', '2026-11-11', 10 * MILLION, 'gpt-5')] })
    sources.push({ projectKey: 'F--a', sessionId: 'free2', usage: [answer('f2', '2026-11-11', 20 * MILLION, 'gpt-5')] })
    const stats = aggregateTokenStats(sources, '2026-11-01', summaries({}))
    expect(stats.sessions).toHaveLength(TOP_SESSIONS)
    expect(stats.sessions.slice(0, 3).map((s) => s.sessionId)).toEqual(['s24', 's23', 's22'])
    expect(stats.sessions.at(-1)!.sessionId).toBe('s5')
    expect(stats.sessionCount).toBe(TOP_SESSIONS + 7)

    const unpriced = aggregateTokenStats(sources.slice(-2), '2026-11-01', summaries({}))
    expect(unpriced.sessions.map((s) => s.sessionId)).toEqual(['free2', 'free1'])
  })
})
