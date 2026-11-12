import { describe, expect, it, vi } from 'vitest'
import type { TerminalCreateOptions, TerminalInfo } from '@shared/types'
import type { AppContext } from '../context'
import { HttpError } from './http'
import { matchRoute, routes, type RouteContext } from './routes'

const SESSION_ID = '0f8fad5b-d9cb-469f-a165-70867728950e'

describe('matchRoute', () => {
  it('finds a route without parameters', () => {
    const { match, allowed } = matchRoute('GET', '/api/v1/health')
    expect(match?.route.path).toBe('/api/v1/health')
    expect(match?.params).toEqual({})
    expect(allowed).toEqual([])
  })

  it('accepts a trailing slash', () => {
    expect(matchRoute('GET', '/api/v1/accounts/').match?.route.path).toBe('/api/v1/accounts')
  })

  it('extracts and decodes path parameters', () => {
    expect(matchRoute('GET', '/api/v1/accounts/system').match?.params).toEqual({ accountId: 'system' })
    expect(matchRoute('GET', '/api/v1/accounts/Work%20%C3%A4').match?.params).toEqual({ accountId: 'Work ä' })
    expect(matchRoute('GET', `/api/v1/sessions/acc-1/${SESSION_ID}`).match?.params).toEqual({ accountId: 'acc-1', sessionId: SESSION_ID })
  })

  it('does not let a parameter span several segments', () => {
    expect(matchRoute('GET', '/api/v1/accounts/a/b').match).toBeNull()
    expect(matchRoute('GET', '/api/v1/accounts/a/stats').match?.route.path).toBe('/api/v1/accounts/{accountId}/stats')
  })

  it('picks the route of the method among several on one path', () => {
    expect(matchRoute('GET', '/api/v1/terminals/t1').match?.route.method).toBe('GET')
    expect(matchRoute('PATCH', '/api/v1/terminals/t1').match?.route.method).toBe('PATCH')
    expect(matchRoute('DELETE', '/api/v1/terminals/t1').match?.route.method).toBe('DELETE')
    expect(matchRoute('POST', '/api/v1/terminals').match?.route.method).toBe('POST')
  })

  it('lists the allowed methods of a path that exists with another method', () => {
    expect(matchRoute('DELETE', '/api/v1/health')).toEqual({ match: null, allowed: ['GET'] })
    expect(matchRoute('POST', '/api/v1/terminals/t1')).toEqual({ match: null, allowed: ['GET', 'PATCH', 'DELETE'] })
    expect(matchRoute('GET', '/api/v1/usage/refresh')).toEqual({ match: null, allowed: ['POST'] })
  })

  it('finds nothing for unknown paths and methods', () => {
    expect(matchRoute('GET', '/api/v2/health')).toEqual({ match: null, allowed: [] })
    expect(matchRoute('GET', '/api/v1/healthz')).toEqual({ match: null, allowed: [] })
    expect(matchRoute('GET', '/api/v1/accounts//stats')).toEqual({ match: null, allowed: [] })
  })

  it('refuses a parameter with broken percent encoding', () => {
    expect(() => matchRoute('GET', '/api/v1/accounts/%E0%A4%A')).toThrow(HttpError)
    try {
      matchRoute('GET', '/api/v1/accounts/%E0%A4%A')
    } catch (error) {
      expect((error as HttpError).status).toBe(400)
    }
  })

  it('has every method and path only once', () => {
    const keys = routes.map((route) => `${route.method} ${route.path}`)
    expect(new Set(keys).size).toBe(keys.length)
  })
})

// --- handlers ----------------------------------------------------------------

function terminal(overrides: Partial<TerminalInfo> = {}): TerminalInfo {
  return {
    id: 't1',
    accountId: 'system',
    authAccountId: 'system',
    sessionId: null,
    limit: null,
    resume: null,
    context: null,
    busy: false,
    attention: null,
    muted: false,
    title: 'Tab',
    fixedTitle: false,
    autoTitle: 'Tab',
    cwd: '/work',
    mode: 'session',
    url: null,
    resumeSessionId: null,
    args: [],
    status: 'running',
    exitCode: null,
    pid: 1,
    createdAt: '2026-11-06T12:00:00.000Z',
    commandLine: 'claude',
    worktree: null,
    hooks: false,
    activity: null,
    subagents: 0,
    compacting: false,
    turn: null,
    prompt: null,
    ...overrides,
  }
}

function fakeApp(options: { terminals?: TerminalInfo[]; buffer?: { data: string; end: number } } = {}) {
  const terminals = options.terminals ?? [terminal()]
  const app = {
    accounts: { list: () => [{ id: 'system' }, { id: 'token-acc' }] },
    terminals: {
      list: () => terminals,
      get: (id: string) => terminals.find((t) => t.id === id),
      open: vi.fn(async (_options: TerminalCreateOptions): Promise<TerminalInfo | null> => terminal({ id: 'new' })),
      rename: vi.fn(),
      setMuted: vi.fn(),
      write: vi.fn(),
      close: vi.fn(),
      buffer: () => options.buffer ?? { data: '', end: 0 },
    },
    usage: { stats: vi.fn(async () => ({})), refresh: vi.fn(async () => []) },
    sessions: { get: vi.fn(async () => ({})) },
  }
  return app
}

type FakeApp = ReturnType<typeof fakeApp>

async function call(
  app: FakeApp,
  method: string,
  url: string,
  body: Record<string, unknown> = {},
): Promise<{ result: unknown; activated: string[] }> {
  const parsed = new URL(url, 'http://127.0.0.1')
  const { match } = matchRoute(method, parsed.pathname)
  if (!match?.route.handler) throw new Error(`no handler for ${method} ${url}`)
  const activated: string[] = []
  const ctx: RouteContext = {
    app: app as unknown as AppContext,
    params: match.params,
    query: parsed.searchParams,
    body: async () => body,
    activateTerminal: (id) => activated.push(id),
  }
  return { result: await match.route.handler(ctx), activated }
}

async function expectStatus(promise: Promise<unknown>, status: number): Promise<void> {
  await expect(promise).rejects.toBeInstanceOf(HttpError)
  await promise.catch((error: HttpError) => expect(error.status).toBe(status))
}

describe('GET /api/v1/terminals/{id}/output', () => {
  // The buffer holds the stream offsets 100–106.
  const app = fakeApp({ buffer: { data: 'abcdef', end: 106 } })
  const output = async (query = '') => (await call(app, 'GET', `/api/v1/terminals/t1/output${query}`)).result

  it('returns the whole buffer by default', async () => {
    expect(await output()).toEqual({ data: 'abcdef', start: 100, end: 106, truncated: false })
  })

  it('returns what came after since', async () => {
    expect(await output('?since=103')).toEqual({ data: 'def', start: 103, end: 106, truncated: false })
    expect(await output('?since=106')).toEqual({ data: '', start: 106, end: 106, truncated: false })
  })

  it('marks output that is no longer in the buffer', async () => {
    expect(await output('?since=40')).toEqual({ data: 'abcdef', start: 100, end: 106, truncated: true })
  })

  it('returns nothing for an offset in the future', async () => {
    expect(await output('?since=500')).toEqual({ data: '', start: 106, end: 106, truncated: false })
  })

  it('limits the output to the last characters with tail', async () => {
    expect(await output('?tail=2')).toEqual({ data: 'ef', start: 104, end: 106, truncated: false })
    expect(await output('?since=105&tail=4')).toEqual({ data: 'f', start: 105, end: 106, truncated: false })
    expect(await output('?tail=50')).toEqual({ data: 'abcdef', start: 100, end: 106, truncated: false })
  })

  it('refuses invalid offsets and an unknown terminal', async () => {
    await expectStatus(output('?since=-1'), 400)
    await expectStatus(output('?tail=0'), 400)
    await expectStatus(call(app, 'GET', '/api/v1/terminals/nope/output'), 404)
  })
})

describe('POST /api/v1/terminals', () => {
  it('opens a terminal with the defaults filled in', async () => {
    const app = fakeApp()
    const { result, activated } = await call(app, 'POST', '/api/v1/terminals', { accountId: 'system' })
    expect(result).toMatchObject({ id: 'new' })
    expect(activated).toEqual([])
    expect(app.terminals.open).toHaveBeenCalledWith({
      accountId: 'system',
      authAccountId: null,
      mode: 'session',
      cwd: null,
      resumeSessionId: null,
      forkSession: false,
      args: undefined,
      title: null,
      muted: false,
      cols: undefined,
      rows: undefined,
    })
  })

  it('passes the options on and shows the tab when asked to', async () => {
    const app = fakeApp()
    const { activated } = await call(app, 'POST', '/api/v1/terminals', {
      accountId: 'system',
      authAccountId: 'token-acc',
      mode: 'shell',
      cwd: '/work',
      resumeSessionId: SESSION_ID,
      forkSession: true,
      args: ['--model', 'opus'],
      title: 'Demo',
      muted: true,
      cols: 120,
      rows: 40,
      activate: true,
    })
    expect(activated).toEqual(['new'])
    expect(app.terminals.open).toHaveBeenCalledWith({
      accountId: 'system',
      authAccountId: 'token-acc',
      mode: 'shell',
      cwd: '/work',
      resumeSessionId: SESSION_ID,
      forkSession: true,
      args: ['--model', 'opus'],
      title: 'Demo',
      muted: true,
      cols: 120,
      rows: 40,
    })
  })

  it.each([
    ['a missing account id', {}, 400],
    ['an unknown account', { accountId: 'ghost' }, 404],
    ['an unknown lending account', { accountId: 'system', authAccountId: 'ghost' }, 404],
    ['an unknown mode', { accountId: 'system', mode: 'repl' }, 400],
    ['an invalid session id', { accountId: 'system', resumeSessionId: 'latest' }, 400],
    ['too few columns', { accountId: 'system', cols: 10 }, 400],
  ])('refuses %s', async (_name, body, status) => {
    const app = fakeApp()
    await expectStatus(call(app, 'POST', '/api/v1/terminals', body), status)
    expect(app.terminals.open).not.toHaveBeenCalled()
  })

  it('answers 400 when the terminal cannot start and 403 when the folder is not trusted', async () => {
    const app = fakeApp()
    app.terminals.open.mockRejectedValueOnce(new Error('Ordner fehlt'))
    await expect(call(app, 'POST', '/api/v1/terminals', { accountId: 'system' })).rejects.toMatchObject({ status: 400, message: 'Ordner fehlt' })
    app.terminals.open.mockResolvedValueOnce(null)
    await expectStatus(call(app, 'POST', '/api/v1/terminals', { accountId: 'system', activate: true }), 403)
  })
})

describe('other terminal routes', () => {
  it('renames and mutes a tab', async () => {
    const app = fakeApp()
    await call(app, 'PATCH', '/api/v1/terminals/t1', { title: '' })
    expect(app.terminals.rename).toHaveBeenCalledWith('t1', '')
    expect(app.terminals.setMuted).not.toHaveBeenCalled()
    await call(app, 'PATCH', '/api/v1/terminals/t1', { muted: true })
    expect(app.terminals.setMuted).toHaveBeenCalledWith('t1', true)
    expect(app.terminals.rename).toHaveBeenCalledOnce()
  })

  it('refuses a PATCH without title or muted', async () => {
    await expectStatus(call(fakeApp(), 'PATCH', '/api/v1/terminals/t1', { other: 1 }), 400)
  })

  it('writes input only to a running process', async () => {
    const app = fakeApp({ terminals: [terminal(), terminal({ id: 't2', status: 'exited' })] })
    await call(app, 'POST', '/api/v1/terminals/t1/input', { data: 'hi\r' })
    expect(app.terminals.write).toHaveBeenCalledWith('t1', 'hi\r')
    await expectStatus(call(app, 'POST', '/api/v1/terminals/t2/input', { data: 'hi\r' }), 409)
    await expectStatus(call(app, 'POST', '/api/v1/terminals/t1/input', {}), 400)
  })

  it('answers 404 for an unknown terminal', async () => {
    const app = fakeApp()
    await expectStatus(call(app, 'DELETE', '/api/v1/terminals/ghost'), 404)
    await expectStatus(call(app, 'POST', '/api/v1/terminals/ghost/activate'), 404)
    expect(app.terminals.close).not.toHaveBeenCalled()
  })
})

describe('session and usage routes', () => {
  it('checks the session id before asking for the session', async () => {
    const app = fakeApp()
    await expectStatus(call(app, 'GET', '/api/v1/sessions/system/not-a-uuid'), 400)
    await expectStatus(call(app, 'GET', `/api/v1/sessions/ghost/${SESSION_ID}`), 404)
    expect(app.sessions.get).not.toHaveBeenCalled()
  })

  it('passes limit on and refuses one that is not a positive integer', async () => {
    const app = fakeApp()
    await call(app, 'GET', `/api/v1/sessions/system/${SESSION_ID}?limit=1500`)
    expect(app.sessions.get).toHaveBeenLastCalledWith('system', SESSION_ID, 1500)
    await call(app, 'GET', `/api/v1/sessions/system/${SESSION_ID}`)
    expect(app.sessions.get).toHaveBeenLastCalledWith('system', SESSION_ID, undefined)
    app.sessions.get.mockClear()
    await expectStatus(call(app, 'GET', `/api/v1/sessions/system/${SESSION_ID}?limit=0`), 400)
    await expectStatus(call(app, 'GET', `/api/v1/sessions/system/${SESSION_ID}?limit=abc`), 400)
    expect(app.sessions.get).not.toHaveBeenCalled()
  })

  it('turns a missing session into 404', async () => {
    const app = fakeApp()
    app.sessions.get.mockRejectedValueOnce(new Error('Session nicht gefunden.'))
    await expect(call(app, 'GET', `/api/v1/sessions/system/${SESSION_ID}`)).rejects.toMatchObject({ status: 404 })
  })

  it('asks for the statistics of 30 days unless told otherwise', async () => {
    const app = fakeApp()
    await call(app, 'GET', '/api/v1/accounts/system/stats')
    await call(app, 'GET', '/api/v1/accounts/system/stats?days=7')
    expect(app.usage.stats.mock.calls).toEqual([
      ['system', 30],
      ['system', 7],
    ])
    await expectStatus(call(app, 'GET', '/api/v1/accounts/system/stats?days=400'), 400)
  })

  it('refreshes the usage of one known account or all', async () => {
    const app = fakeApp()
    await call(app, 'POST', '/api/v1/usage/refresh')
    await call(app, 'POST', '/api/v1/usage/refresh', { accountId: 'system' })
    expect(app.usage.refresh.mock.calls).toEqual([[undefined], ['system']])
    await expectStatus(call(app, 'POST', '/api/v1/usage/refresh', { accountId: 'ghost' }), 404)
  })
})
