import { describe, expect, it } from 'vitest'
import type { TerminalInfo } from '@shared/types'
import { nextWaiting, overviewGroups, overviewState } from './overview'

function terminal(id: string, patch: Partial<TerminalInfo> = {}): TerminalInfo {
  return {
    id,
    accountId: 'a',
    authAccountId: 'a',
    sessionId: null,
    limit: null,
    resume: null,
    context: null,
    busy: false,
    attention: null,
    muted: false,
    title: id,
    fixedTitle: false,
    autoTitle: id,
    cwd: 'C:/work',
    mode: 'session',
    url: null,
    resumeSessionId: null,
    args: [],
    status: 'running',
    exitCode: null,
    pid: 1,
    createdAt: '2026-11-12T08:00:00Z',
    commandLine: 'claude',
    worktree: null,
    hooks: true,
    activity: null,
    subagents: 0,
    compacting: false,
    turn: null,
    prompt: null,
    ...patch,
  }
}

const ended = (kind: 'done' | 'input' | 'limit', at: string) => ({ kind, tool: kind === 'input' ? 'Bash' : null, detail: null, at })

describe('overviewState', () => {
  it('puts a wait for the user and a limit before work', () => {
    expect(overviewState(terminal('t', { busy: true, turn: ended('input', '2026-11-12T09:00:00Z') }))).toBe('waiting')
    expect(overviewState(terminal('t', { limit: { type: 'five_hour', resetsAt: null, message: 'Limit' } }))).toBe('waiting')
    expect(overviewState(terminal('t', { busy: true }))).toBe('working')
    expect(overviewState(terminal('t', { turn: ended('done', '2026-11-12T09:00:00Z') }))).toBe('ready')
    expect(overviewState(terminal('t', { turn: ended('input', '2026-11-12T09:00:00Z'), status: 'exited' }))).toBe('ended')
  })

  it('takes a limit that reset as ready', () => {
    expect(overviewState(terminal('t', { turn: ended('limit', '2026-11-12T09:00:00Z') }))).toBe('ready')
  })
})

describe('overviewGroups', () => {
  it('sorts the longest waiting first and the latest finished first, without browsers', () => {
    const groups = overviewGroups([
      terminal('r1', { turn: ended('done', '2026-11-12T09:00:00Z') }),
      terminal('w1', { turn: ended('input', '2026-11-12T09:30:00Z') }),
      terminal('r2', { turn: ended('done', '2026-11-12T09:10:00Z') }),
      terminal('r3'),
      terminal('w2', { limit: { type: null, resetsAt: null, message: 'Limit' } }),
      terminal('b', { mode: 'browser' }),
      terminal('k', { busy: true }),
      terminal('s', { mode: 'shell', status: 'exited' }),
    ])
    expect(Object.fromEntries(Object.entries(groups).map(([state, list]) => [state, list.map((t) => t.id)]))).toEqual({
      waiting: ['w2', 'w1'],
      working: ['k'],
      ready: ['r2', 'r1', 'r3'],
      ended: ['s'],
    })
  })
})

describe('nextWaiting', () => {
  const list = [
    terminal('w1', { turn: ended('input', '2026-11-12T09:00:00Z') }),
    terminal('x', { busy: true }),
    terminal('w2', { turn: ended('input', '2026-11-12T09:05:00Z') }),
  ]

  it('goes to the longest waiting tab, then on to the next, and round again', () => {
    expect(nextWaiting(list, 'x')).toBe('w1')
    expect(nextWaiting(list, null)).toBe('w1')
    expect(nextWaiting(list, 'w1')).toBe('w2')
    expect(nextWaiting(list, 'w2')).toBe('w1')
  })

  it('has nothing when no tab waits', () => {
    expect(nextWaiting([terminal('x', { busy: true })], 'x')).toBeNull()
  })
})
