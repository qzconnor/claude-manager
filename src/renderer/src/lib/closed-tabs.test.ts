import { describe, expect, it } from 'vitest'
import type { TerminalInfo, TerminalMode } from '@shared/types'
import { closedTabOf, MAX_CLOSED_TABS, rememberClosed, reopenOptions, type ClosedTab } from './closed-tabs'

function terminal(id: string, mode: TerminalMode = 'session', extra: Partial<TerminalInfo> = {}): TerminalInfo {
  return {
    id,
    accountId: 'a',
    authAccountId: 'a',
    sessionId: `s-${id}`,
    limit: null,
    context: null,
    busy: false,
    attention: null,
    muted: false,
    title: id,
    fixedTitle: false,
    autoTitle: id,
    cwd: 'C:\\dev',
    mode,
    url: null,
    resumeSessionId: null,
    args: [],
    status: 'running',
    exitCode: null,
    pid: 0,
    createdAt: '',
    commandLine: '',
    worktree: null,
    hooks: false,
    activity: null,
    subagents: 0,
    compacting: false,
    turn: null,
    prompt: null,
    ...extra,
  }
}

const context = { tokens: 1000, window: 200_000 } as unknown as TerminalInfo['context']

describe('closedTabOf', () => {
  it('keeps what it takes to open a session again, with its conversation once it has one', () => {
    const entry = closedTabOf(
      terminal('t', 'session', { context, title: 'Fix', fixedTitle: true, muted: true, args: ['--model', 'opus', 'Hallo'] }),
      5,
    )
    expect(entry).toEqual({
      id: 't',
      mode: 'session',
      accountId: 'a',
      authAccountId: 'a',
      cwd: 'C:\\dev',
      sessionId: 's-t',
      title: 'Fix',
      fixedTitle: true,
      muted: true,
      // The prompt was the start's, not the session's.
      args: ['--model', 'opus'],
      closedAt: 5,
    })
  })

  it('has no conversation for a session without a message yet, unless it went on with one', () => {
    expect(closedTabOf(terminal('t'))?.sessionId).toBeNull()
    expect(closedTabOf(terminal('t', 'session', { resumeSessionId: 'old' }))?.sessionId).toBe('s-t')
  })

  it('keeps a shell without a conversation, and nothing of a browser or a login', () => {
    expect(closedTabOf(terminal('t', 'shell', { context }))).toMatchObject({ mode: 'shell', sessionId: null })
    expect(closedTabOf(terminal('t', 'browser'))).toBeNull()
    expect(closedTabOf(terminal('t', 'login'))).toBeNull()
  })
})

const entry = (id: string, sessionId: string | null = null): ClosedTab => ({ ...closedTabOf(terminal(id))!, sessionId })

describe('rememberClosed', () => {
  it('puts the newest first and forgets the oldest beyond the limit', () => {
    let list: ClosedTab[] = []
    for (let i = 0; i <= MAX_CLOSED_TABS; i++) list = rememberClosed(list, entry(`t${i}`))
    expect(list).toHaveLength(MAX_CLOSED_TABS)
    expect(list[0].id).toBe(`t${MAX_CLOSED_TABS}`)
    expect(list.map((e) => e.id)).not.toContain('t0')
  })

  it('keeps one entry per session and per tab', () => {
    const list = rememberClosed([entry('old', 's'), entry('t'), entry('other')], entry('new', 's'))
    expect(list.map((e) => e.id)).toEqual(['new', 't', 'other'])
    expect(rememberClosed(list, entry('t')).map((e) => e.id)).toEqual(['t', 'new', 'other'])
  })
})

describe('reopenOptions', () => {
  it('goes on with the session in its folder, with its args, title and muting', () => {
    const closed = closedTabOf(
      terminal('t', 'session', { context, authAccountId: 'b', title: 'Fix', fixedTitle: true, muted: true, args: ['--model', 'opus'] }),
    )!
    expect(reopenOptions(closed, new Set(['a', 'b']))).toEqual({
      accountId: 'a',
      authAccountId: 'b',
      cwd: 'C:\\dev',
      mode: 'session',
      resumeSessionId: 's-t',
      args: ['--model', 'opus'],
      title: 'Fix',
      muted: true,
    })
  })

  it('lets the title follow the session again unless it was set by hand', () => {
    expect(reopenOptions(closedTabOf(terminal('t', 'session', { context }))!, new Set(['a']))?.title).toBeNull()
  })

  it('runs with its own login once the lending account is gone, and not at all once its own is', () => {
    const closed = closedTabOf(terminal('t', 'session', { authAccountId: 'b' }))!
    expect(reopenOptions(closed, new Set(['a']))?.authAccountId).toBeNull()
    expect(reopenOptions(closed, new Set(['b']))).toBeNull()
  })

  it('opens a shell without args', () => {
    const options = reopenOptions(closedTabOf(terminal('t', 'shell', { args: ['x'] }))!, new Set(['a']))
    expect(options).toMatchObject({ mode: 'shell', resumeSessionId: null, args: undefined })
  })
})
