import type { MakeDirectoryOptions, Mode, PathLike } from 'node:fs'
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const fetchMock = vi.hoisted(() => vi.fn<(url: string, init?: RequestInit) => Promise<Response>>())
vi.mock('electron', () => ({ net: { fetch: fetchMock } }))

/**
 * What other processes do at a given moment: something right before a folder is created (Claude Code
 * finishing its own renewal while the lock is taken), and renames that fail (a virus scanner holds the file).
 */
const hooks = vi.hoisted(() => ({
  beforeMkdir: null as ((path: string) => Promise<void> | void) | null,
  failingRenames: 0,
}))
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    mkdir: async (path: PathLike, options?: MakeDirectoryOptions | Mode | null) => {
      await hooks.beforeMkdir?.(String(path))
      return actual.mkdir(path, options as MakeDirectoryOptions)
    },
    rename: async (from: PathLike, to: PathLike) => {
      if (hooks.failingRenames > 0) {
        hooks.failingRenames--
        throw Object.assign(new Error(`EBUSY: resource busy or locked, rename '${String(from)}'`), { code: 'EBUSY' })
      }
      return actual.rename(from, to)
    },
  }
})

import { canRenew, renewOAuthLogin } from './oauth-renewal'

const TOKEN_URL = 'https://platform.claude.com/v1/oauth/token'
const CLAUDE_CODE_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e'
const UA = 'claude-manager/1.0'
const HOUR = 3_600_000

/** The answer of the token endpoint to a successful renewal. */
const TOKENS = {
  token_type: 'Bearer',
  access_token: 'sk-ant-oat01-new',
  refresh_token: 'sk-ant-ort01-new',
  expires_in: 28_800,
  refresh_token_expires_in: 30 * 24 * 3600,
  scope: 'user:inference user:profile user:sessions:claude_code',
}

/**
 * A login whose access token expired a minute ago. Every login gets refresh and access tokens of its
 * own: the module remembers refused refresh tokens for as long as it is loaded.
 */
let serial = 0
function expiredLogin(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  serial++
  return {
    accessToken: `sk-ant-oat01-old-${serial}`,
    refreshToken: `sk-ant-ort01-old-${serial}`,
    expiresAt: Date.now() - 60_000,
    scopes: ['user:inference', 'user:profile'],
    subscriptionType: 'max',
    ...overrides,
  }
}

function respond(status: number, body: unknown = {}): Response {
  const text = typeof body === 'string' ? body : JSON.stringify(body)
  return new Response(text, { status, headers: { 'Content-Type': typeof body === 'string' ? 'text/html' : 'application/json' } })
}

/** A request that stays open until the test answers it. */
function holdRequest(): { answer: (response: Response) => void } {
  let answer: (response: Response) => void = () => undefined
  fetchMock.mockImplementation(
    () =>
      new Promise<Response>((resolve) => {
        answer = resolve
      }),
  )
  return { answer: (response) => answer(response) }
}

let root: string
let configDir: string
let credentialsFile: string
/** Claude Code's lock for renewing a login, and the one older versions take next to the folder. */
let currentLock: string
let legacyLock: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'cm-oauth-'))
  configDir = join(root, 'config')
  await mkdir(configDir)
  credentialsFile = join(configDir, '.credentials.json')
  currentLock = join(configDir, '.oauth_refresh.lock')
  legacyLock = `${await realpath(configDir)}.lock`
  fetchMock.mockReset()
})

afterEach(async () => {
  hooks.beforeMkdir = null
  hooks.failingRenames = 0
  vi.useRealTimers()
  vi.restoreAllMocks()
  await rm(root, { recursive: true, force: true, maxRetries: 3 })
})

async function store(data: unknown, prefix = ''): Promise<string> {
  const text = prefix + JSON.stringify(data)
  await writeFile(credentialsFile, text, 'utf8')
  return text
}

async function stored(): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(credentialsFile, 'utf8')) as Record<string, unknown>
}

const exists = (path: string) => stat(path).then(() => true, () => false)

async function expectNoLocks(): Promise<void> {
  expect(await exists(currentLock)).toBe(false)
  expect(await exists(legacyLock)).toBe(false)
}

function requestBody(call = 0): Record<string, unknown> {
  return JSON.parse(String(fetchMock.mock.calls[call][1]?.body)) as Record<string, unknown>
}

function quietErrors(): void {
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
}

describe('renewOAuthLogin', () => {
  it('renews an expired login and writes the new tokens over the old ones, keeping everything else', async () => {
    const now = Date.now()
    vi.spyOn(Date, 'now').mockReturnValue(now)
    const login = expiredLogin()
    await store({ claudeAiOauth: login, mcpOAuth: { github: { accessToken: 'mcp-token' } } })
    fetchMock.mockResolvedValue(respond(200, TOKENS))

    expect(await renewOAuthLogin(configDir, credentialsFile, UA)).toBe('renewed')

    expect(fetchMock).toHaveBeenCalledOnce()
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe(TOKEN_URL)
    expect(init?.method).toBe('POST')
    expect(init?.headers).toMatchObject({ 'Content-Type': 'application/json', 'User-Agent': UA })
    expect(init?.signal).toBeInstanceOf(AbortSignal)
    expect(requestBody()).toEqual({
      grant_type: 'refresh_token',
      refresh_token: login.refreshToken,
      client_id: CLAUDE_CODE_CLIENT_ID,
      scope: 'user:inference user:profile',
    })

    expect(await stored()).toEqual({
      claudeAiOauth: {
        accessToken: 'sk-ant-oat01-new',
        refreshToken: 'sk-ant-ort01-new',
        expiresAt: now + 8 * HOUR,
        refreshTokenExpiresAt: now + 30 * 24 * HOUR,
        scopes: ['user:inference', 'user:profile', 'user:sessions:claude_code'],
        subscriptionType: 'max',
      },
      mcpOAuth: { github: { accessToken: 'mcp-token' } },
    })
    // No temporary file and no lock is left behind.
    expect(await readdir(configDir)).toEqual(['.credentials.json'])
    await expectNoLocks()
  })

  it('keeps the refresh token, the scopes and their expiry when the answer brings no new ones', async () => {
    const now = Date.now()
    vi.spyOn(Date, 'now').mockReturnValue(now)
    const login = expiredLogin({ refreshTokenExpiresAt: now + 10 * 24 * HOUR })
    await store({ claudeAiOauth: login })
    fetchMock.mockResolvedValue(respond(200, { access_token: 'sk-ant-oat01-new', expires_in: 3600, scope: '  ' }))

    expect(await renewOAuthLogin(configDir, credentialsFile, UA)).toBe('renewed')
    expect(await stored()).toEqual({
      claudeAiOauth: { ...login, accessToken: 'sk-ant-oat01-new', expiresAt: now + HOUR },
    })
  })

  it('asks with the client id stored with the login', async () => {
    await store({ claudeAiOauth: expiredLogin({ clientId: 'other-client' }) })
    fetchMock.mockResolvedValue(respond(200, TOKENS))

    expect(await renewOAuthLogin(configDir, credentialsFile, UA)).toBe('renewed')
    expect(requestBody().client_id).toBe('other-client')
  })

  it('reads a credentials file that starts with a byte order mark', async () => {
    await store({ claudeAiOauth: expiredLogin() }, '﻿')
    fetchMock.mockResolvedValue(respond(200, TOKENS))

    expect(await renewOAuthLogin(configDir, credentialsFile, UA)).toBe('renewed')
    expect((await stored()).claudeAiOauth).toMatchObject({ accessToken: 'sk-ant-oat01-new' })
  })

  it.each([
    { state: 'has not expired yet', expiresAt: () => Date.now() + HOUR },
    { state: 'has no expiry', expiresAt: () => undefined },
  ])('neither asks nor waits for a lock when the access token $state', async ({ expiresAt }) => {
    const text = await store({ claudeAiOauth: expiredLogin({ expiresAt: expiresAt() }) })
    // Even while Claude Code holds its lock: a token that still works needs no renewal.
    await mkdir(currentLock)

    expect(await renewOAuthLogin(configDir, credentialsFile, UA)).toBe('renewed')
    expect(fetchMock).not.toHaveBeenCalled()
    expect(await readFile(credentialsFile, 'utf8')).toBe(text)
    expect(await exists(currentLock)).toBe(true)
    expect(await exists(legacyLock)).toBe(false)
  })

  it.each([
    { state: 'is missing', content: null },
    { state: 'is broken', content: '{"claudeAiOauth": {' },
    { state: 'holds no browser login', content: '{"other": true}' },
  ])('neither asks nor takes a lock when the credentials file $state', async ({ content }) => {
    if (content !== null) await writeFile(credentialsFile, content)

    await renewOAuthLogin(configDir, credentialsFile, UA)
    expect(fetchMock).not.toHaveBeenCalled()
    await expectNoLocks()
  })

  it.each([
    { login: 'without a refresh token', overrides: { refreshToken: undefined } },
    { login: 'with an empty refresh token', overrides: { refreshToken: '' } },
    { login: 'without scopes', overrides: { scopes: undefined } },
    { login: 'without the inference scope', overrides: { scopes: ['user:profile'] } },
    { login: 'with scopes that are not text', overrides: { scopes: ['user:inference', 42] } },
    { login: 'whose refresh token expired', overrides: { refreshTokenExpiresAt: Date.now() - 1000 } },
  ])('rejects a login $login without asking', async ({ overrides }) => {
    const text = await store({ claudeAiOauth: expiredLogin(overrides) })

    expect(await renewOAuthLogin(configDir, credentialsFile, UA)).toBe('rejected')
    expect(fetchMock).not.toHaveBeenCalled()
    expect(await readFile(credentialsFile, 'utf8')).toBe(text)
    await expectNoLocks()
  })

  it('answers busy without asking while Claude Code holds its lock, also one touched 50 seconds ago', async () => {
    const text = await store({ claudeAiOauth: expiredLogin() })
    await mkdir(currentLock)
    const touched = new Date(Date.now() - 50_000)
    await utimes(currentLock, touched, touched)

    expect(await renewOAuthLogin(configDir, credentialsFile, UA)).toBe('busy')
    expect(fetchMock).not.toHaveBeenCalled()
    expect(await readFile(credentialsFile, 'utf8')).toBe(text)
    // Claude Code's lock stays, and the older one is not taken either.
    expect(await exists(currentLock)).toBe(true)
    expect(await exists(legacyLock)).toBe(false)
  })

  it('answers busy while an older Claude Code holds the lock next to the folder, and gives its own back', async () => {
    await store({ claudeAiOauth: expiredLogin() })
    await mkdir(legacyLock)

    expect(await renewOAuthLogin(configDir, credentialsFile, UA)).toBe('busy')
    expect(fetchMock).not.toHaveBeenCalled()
    expect(await exists(currentLock)).toBe(false)
    expect(await exists(legacyLock)).toBe(true)
  })

  it('takes over locks nobody touched for over a minute', async () => {
    await store({ claudeAiOauth: expiredLogin() })
    const abandoned = new Date(Date.now() - 61_000)
    for (const lock of [currentLock, legacyLock]) {
      await mkdir(lock)
      await utimes(lock, abandoned, abandoned)
    }
    fetchMock.mockResolvedValue(respond(200, TOKENS))

    expect(await renewOAuthLogin(configDir, credentialsFile, UA)).toBe('renewed')
    expect(fetchMock).toHaveBeenCalledOnce()
    await expectNoLocks()
  })

  it('goes on without the older lock when it cannot be created next to the folder', async () => {
    await store({ claudeAiOauth: expiredLogin() })
    hooks.beforeMkdir = (path) => {
      if (path === legacyLock) throw Object.assign(new Error(`EPERM: operation not permitted, mkdir '${path}'`), { code: 'EPERM' })
    }
    fetchMock.mockResolvedValue(respond(200, TOKENS))

    expect(await renewOAuthLogin(configDir, credentialsFile, UA)).toBe('renewed')
    expect(fetchMock).toHaveBeenCalledOnce()
    await expectNoLocks()
  })

  it('lets only one of two renewals at the same time use the refresh token', async () => {
    await store({ claudeAiOauth: expiredLogin() })
    const request = holdRequest()

    const first = renewOAuthLogin(configDir, credentialsFile, UA)
    const second = renewOAuthLogin(configDir, credentialsFile, UA)
    // The one without the lock gives up while the other one's request is still open.
    expect(await Promise.race([first, second])).toBe('busy')
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled())
    request.answer(respond(200, TOKENS))

    expect((await Promise.all([first, second])).sort()).toEqual(['busy', 'renewed'])
    expect(fetchMock).toHaveBeenCalledOnce()
    expect((await stored()).claudeAiOauth).toMatchObject({ accessToken: 'sk-ant-oat01-new' })
    await expectNoLocks()
  })

  it('keeps its locks fresh while the request runs and stops when done', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    await store({ claudeAiOauth: expiredLogin() })
    const request = holdRequest()

    const renewal = renewOAuthLogin(configDir, credentialsFile, UA)
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled())
    const earlier = new Date(Date.now() - 30_000)
    for (const lock of [currentLock, legacyLock]) await utimes(lock, earlier, earlier)

    vi.advanceTimersByTime(5000)
    await vi.waitFor(async () => {
      for (const lock of [currentLock, legacyLock]) expect(Date.now() - (await stat(lock)).mtimeMs).toBeLessThan(10_000)
    })

    request.answer(respond(200, TOKENS))
    expect(await renewal).toBe('renewed')
    expect(vi.getTimerCount()).toBe(0)
    await expectNoLocks()
  })

  it('takes the token Claude Code renewed while the lock was being taken, without asking', async () => {
    const login = expiredLogin()
    await store({ claudeAiOauth: login })
    const renewedByClaudeCode = {
      claudeAiOauth: { ...login, accessToken: 'sk-ant-oat01-claude-code', refreshToken: 'sk-ant-ort01-claude-code', expiresAt: Date.now() + HOUR },
    }
    hooks.beforeMkdir = async (path) => {
      if (path !== currentLock) return
      hooks.beforeMkdir = null
      await writeFile(credentialsFile, JSON.stringify(renewedByClaudeCode))
    }

    expect(await renewOAuthLogin(configDir, credentialsFile, UA)).toBe('renewed')
    expect(fetchMock).not.toHaveBeenCalled()
    expect(await stored()).toEqual(renewedByClaudeCode)
    await expectNoLocks()
  })

  it('rejects without asking when the login is gone once the lock is taken', async () => {
    await store({ claudeAiOauth: expiredLogin() })
    hooks.beforeMkdir = async (path) => {
      if (path !== currentLock) return
      hooks.beforeMkdir = null
      await rm(credentialsFile)
    }

    expect(await renewOAuthLogin(configDir, credentialsFile, UA)).toBe('rejected')
    expect(fetchMock).not.toHaveBeenCalled()
    await expectNoLocks()
  })

  it('keeps a new sign-in that replaced the login during the request', async () => {
    await store({ claudeAiOauth: expiredLogin() })
    const signedIn = { claudeAiOauth: expiredLogin({ expiresAt: Date.now() + 8 * HOUR }) }
    fetchMock.mockImplementation(async () => {
      await writeFile(credentialsFile, JSON.stringify(signedIn))
      return respond(200, TOKENS)
    })

    expect(await renewOAuthLogin(configDir, credentialsFile, UA)).toBe('busy')
    expect(await stored()).toEqual(signedIn)
    await expectNoLocks()
  })

  it('does not bring back credentials deleted during the request', async () => {
    await store({ claudeAiOauth: expiredLogin() })
    fetchMock.mockImplementation(async () => {
      await rm(credentialsFile)
      return respond(200, TOKENS)
    })

    expect(await renewOAuthLogin(configDir, credentialsFile, UA)).toBe('busy')
    expect(await exists(credentialsFile)).toBe(false)
    await expectNoLocks()
  })

  it('writes the new tokens onto what another process changed during the request, for the same login', async () => {
    const login = expiredLogin()
    await store({ claudeAiOauth: login })
    fetchMock.mockImplementation(async () => {
      await writeFile(credentialsFile, JSON.stringify({ claudeAiOauth: { ...login, subscriptionType: 'pro' }, mcpOAuth: { added: true } }))
      return respond(200, TOKENS)
    })

    expect(await renewOAuthLogin(configDir, credentialsFile, UA)).toBe('renewed')
    expect(await stored()).toEqual({
      claudeAiOauth: expect.objectContaining({ accessToken: 'sk-ant-oat01-new', refreshToken: 'sk-ant-ort01-new', subscriptionType: 'pro' }),
      mcpOAuth: { added: true },
    })
  })

  it.each([400, 401])('rejects a refresh token refused as invalid_grant (%s) and never sends it again', async (status) => {
    const login = expiredLogin()
    const text = await store({ claudeAiOauth: login })
    fetchMock.mockResolvedValue(respond(status, { error: 'invalid_grant', error_description: 'Refresh token not found or invalid' }))

    expect(await renewOAuthLogin(configDir, credentialsFile, UA)).toBe('rejected')
    expect(await readFile(credentialsFile, 'utf8')).toBe(text)
    await expectNoLocks()

    expect(await renewOAuthLogin(configDir, credentialsFile, UA)).toBe('rejected')
    expect(fetchMock).toHaveBeenCalledOnce()

    // A new sign-in brings a refresh token that is asked about again.
    await store({ claudeAiOauth: expiredLogin() })
    fetchMock.mockResolvedValue(respond(200, TOKENS))
    expect(await renewOAuthLogin(configDir, credentialsFile, UA)).toBe('renewed')
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(requestBody(1).refresh_token).not.toBe(login.refreshToken)
  })

  it.each([
    { answer: 'a 400 for another reason', status: 400, body: { error: 'invalid_request' } },
    { answer: 'a 403 even with invalid_grant', status: 403, body: { error: 'invalid_grant' } },
    { answer: 'a rate limit', status: 429, body: { error: 'rate_limit_error' } },
    { answer: 'a server error without a body', status: 500, body: '' },
    { answer: 'a proxy error page', status: 502, body: '<html>Bad Gateway</html>' },
  ])('fails on $answer, without writing, and asks again next time', async ({ status, body }) => {
    quietErrors()
    const text = await store({ claudeAiOauth: expiredLogin() })
    fetchMock.mockResolvedValue(respond(status, body))

    expect(await renewOAuthLogin(configDir, credentialsFile, UA)).toBe('failed')
    expect(await readFile(credentialsFile, 'utf8')).toBe(text)
    await expectNoLocks()

    fetchMock.mockResolvedValue(respond(200, TOKENS))
    expect(await renewOAuthLogin(configDir, credentialsFile, UA)).toBe('renewed')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('fails without writing when the network is down, and asks again next time', async () => {
    quietErrors()
    const text = await store({ claudeAiOauth: expiredLogin() })
    fetchMock.mockRejectedValue(new TypeError('fetch failed'))

    expect(await renewOAuthLogin(configDir, credentialsFile, UA)).toBe('failed')
    expect(await readFile(credentialsFile, 'utf8')).toBe(text)
    await expectNoLocks()

    fetchMock.mockResolvedValue(respond(200, TOKENS))
    expect(await renewOAuthLogin(configDir, credentialsFile, UA)).toBe('renewed')
  })

  it.each([
    { answer: 'no JSON', body: 'ok' },
    { answer: 'no access token', body: { expires_in: 3600 } },
    { answer: 'an empty access token', body: { access_token: '', expires_in: 3600 } },
    { answer: 'no lifetime', body: { access_token: 'sk-ant-oat01-new' } },
    { answer: 'a lifetime of zero', body: { access_token: 'sk-ant-oat01-new', expires_in: 0 } },
    { answer: 'a lifetime as text', body: { access_token: 'sk-ant-oat01-new', expires_in: '3600' } },
  ])('fails without writing when a successful answer has $answer', async ({ body }) => {
    quietErrors()
    const text = await store({ claudeAiOauth: expiredLogin() })
    fetchMock.mockResolvedValue(respond(200, body))

    expect(await renewOAuthLogin(configDir, credentialsFile, UA)).toBe('failed')
    expect(await readFile(credentialsFile, 'utf8')).toBe(text)
    await expectNoLocks()
  })

  it('retries replacing a credentials file Windows holds for a moment', async () => {
    await store({ claudeAiOauth: expiredLogin() })
    fetchMock.mockResolvedValue(respond(200, TOKENS))
    hooks.failingRenames = 2

    expect(await renewOAuthLogin(configDir, credentialsFile, UA)).toBe('renewed')
    expect((await stored()).claudeAiOauth).toMatchObject({ accessToken: 'sk-ant-oat01-new' })
    expect(await readdir(configDir)).toEqual(['.credentials.json'])
  })

  it('gives its locks back and cleans up when the new tokens cannot be written', async () => {
    const text = await store({ claudeAiOauth: expiredLogin() })
    fetchMock.mockResolvedValue(respond(200, TOKENS))
    hooks.failingRenames = Infinity

    await expect(renewOAuthLogin(configDir, credentialsFile, UA)).rejects.toMatchObject({ code: 'EBUSY' })
    expect(await readFile(credentialsFile, 'utf8')).toBe(text)
    expect(await readdir(configDir)).toEqual(['.credentials.json'])
    await expectNoLocks()
  })
})

describe('renewOAuthLogin with force', () => {
  it('renews a token that still works, under the lock', async () => {
    const login = expiredLogin({ expiresAt: Date.now() + HOUR })
    await store({ claudeAiOauth: login })
    fetchMock.mockResolvedValue(respond(200, TOKENS))

    expect(await renewOAuthLogin(configDir, credentialsFile, UA, { force: true })).toBe('renewed')
    expect(requestBody()).toMatchObject({ grant_type: 'refresh_token', refresh_token: login.refreshToken })
    expect((await stored()).claudeAiOauth).toMatchObject({ accessToken: 'sk-ant-oat01-new', refreshToken: 'sk-ant-ort01-new' })
    await expectNoLocks()
  })

  it('waits for Claude Code renewing it right now', async () => {
    await store({ claudeAiOauth: expiredLogin({ expiresAt: Date.now() + HOUR }) })
    await mkdir(currentLock)

    expect(await renewOAuthLogin(configDir, credentialsFile, UA, { force: true })).toBe('busy')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('takes a token Claude Code renewed while the lock was being taken, without asking', async () => {
    const login = expiredLogin({ expiresAt: Date.now() + HOUR })
    await store({ claudeAiOauth: login })
    hooks.beforeMkdir = async (path) => {
      if (path !== currentLock) return
      hooks.beforeMkdir = null
      await store({ claudeAiOauth: { ...login, accessToken: 'sk-ant-oat01-by-claude-code' } })
    }

    expect(await renewOAuthLogin(configDir, credentialsFile, UA, { force: true })).toBe('renewed')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('rejects without a login or without a refresh token, and when Anthropic refuses it', async () => {
    expect(await renewOAuthLogin(configDir, credentialsFile, UA, { force: true })).toBe('rejected')
    await store({ claudeAiOauth: expiredLogin({ expiresAt: Date.now() + HOUR, refreshToken: undefined }) })
    expect(await renewOAuthLogin(configDir, credentialsFile, UA, { force: true })).toBe('rejected')
    expect(fetchMock).not.toHaveBeenCalled()

    const login = expiredLogin({ expiresAt: Date.now() + HOUR })
    await store({ claudeAiOauth: login })
    fetchMock.mockResolvedValue(respond(400, { error: 'invalid_grant' }))
    expect(await renewOAuthLogin(configDir, credentialsFile, UA, { force: true })).toBe('rejected')
    expect(canRenew(login)).toBe(false)
  })
})

describe('canRenew', () => {
  it('knows logins with a refresh token that may still work', () => {
    expect(canRenew(expiredLogin())).toBe(true)
    expect(canRenew(expiredLogin({ refreshToken: undefined }))).toBe(false)
    expect(canRenew(expiredLogin({ scopes: ['user:profile'] }))).toBe(false)
    expect(canRenew(expiredLogin({ refreshTokenExpiresAt: Date.now() - 1000 }))).toBe(false)
    expect(canRenew(expiredLogin({ refreshTokenExpiresAt: Date.now() + HOUR }))).toBe(true)
  })
})
