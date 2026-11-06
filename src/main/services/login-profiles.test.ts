import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const fetchMock = vi.hoisted(() => vi.fn<(url: string, init?: RequestInit) => Promise<Response>>())
vi.mock('electron', () => ({ net: { fetch: fetchMock } }))

import { writeJsonAtomic } from '../lib/json-file'
import { fingerprintOf, LoginProfiles, type LoginProfile } from './login-profiles'

const PROFILE_BODY = {
  account: { uuid: 'acc-uuid', email: 'ada@example.com', full_name: 'Ada Lovelace' },
  organization: { uuid: 'org-uuid', name: "ada@example.com's Organization", organization_type: 'claude_max' },
}

const PROFILE: LoginProfile = {
  accountUuid: 'acc-uuid',
  email: 'ada@example.com',
  displayName: 'Ada Lovelace',
  organizationUuid: 'org-uuid',
  organizationName: "ada@example.com's Organization",
  organizationType: 'claude_max',
}

function respond(status: number, body: unknown = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

let dir: string
const cacheFile = () => join(dir, 'cache', 'login-profiles.json')

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'cm-test-'))
  fetchMock.mockReset()
})

afterEach(async () => {
  vi.restoreAllMocks()
  // Writes to one file are queued: this one ends after any the service started.
  await writeJsonAtomic(cacheFile(), null)
  await rm(dir, { recursive: true, force: true, maxRetries: 3 })
})

async function readCache(): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(cacheFile(), 'utf8')) as Record<string, unknown>
}

describe('fingerprintOf', () => {
  it('is a stable 32 character hex hash that does not contain the token', () => {
    const token = 'sk-ant-oat01-secret-token'
    const fingerprint = fingerprintOf(token)
    expect(fingerprint).toMatch(/^[0-9a-f]{32}$/)
    expect(fingerprintOf(token)).toBe(fingerprint)
    expect(fingerprint).not.toContain('secret')
  })

  it('differs between tokens', () => {
    expect(fingerprintOf('token-a')).not.toBe(fingerprintOf('token-b'))
    expect(fingerprintOf('')).toMatch(/^[0-9a-f]{32}$/)
  })
})

describe('LoginProfiles', () => {
  it('looks a token up once, remembers the answer and announces it', async () => {
    fetchMock.mockImplementation(async () => respond(200, PROFILE_BODY))
    const profiles = new LoginProfiles(dir, 'claude-manager/1.0')
    const resolved = vi.fn()
    profiles.on('resolved', resolved)

    expect(await profiles.resolve('a', 'token-1')).toEqual(PROFILE)
    expect(resolved).toHaveBeenCalledWith('a')
    expect(await profiles.resolve('a', 'token-1')).toEqual(PROFILE)
    expect(profiles.peek('a', 'token-1', false)).toEqual(PROFILE)
    expect(fetchMock).toHaveBeenCalledOnce()

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://api.anthropic.com/api/oauth/profile')
    expect(init?.headers).toMatchObject({ Authorization: 'Bearer token-1', 'User-Agent': 'claude-manager/1.0' })
  })

  it('persists only a fingerprint of the token', async () => {
    fetchMock.mockImplementation(async () => respond(200, PROFILE_BODY))
    await new LoginProfiles(dir, 'ua').resolve('a', 'token-1')
    await vi.waitFor(async () => {
      expect(await readCache()).toEqual({ a: { fingerprint: fingerprintOf('token-1'), profile: PROFILE } })
    })
    expect(await readFile(cacheFile(), 'utf8')).not.toContain('token-1')
  })

  it('loads the persisted answers, ignoring broken entries', async () => {
    await mkdir(join(dir, 'cache'), { recursive: true })
    await writeFile(
      cacheFile(),
      JSON.stringify({
        a: { fingerprint: fingerprintOf('token-1'), profile: PROFILE },
        b: { profile: PROFILE },
        c: null,
      }),
    )
    const profiles = new LoginProfiles(dir, 'ua')
    await profiles.init()
    expect(profiles.peek('a', 'token-1', false)).toEqual(PROFILE)
    expect(profiles.peek('b', 'token-1', false)).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('looks a new token of the same account up again', async () => {
    fetchMock.mockResolvedValueOnce(respond(200, PROFILE_BODY))
    fetchMock.mockResolvedValueOnce(
      respond(200, { account: { uuid: 'other', email: 'bob@example.com', display_name: 'Bob' }, organization: null }),
    )
    const profiles = new LoginProfiles(dir, 'ua')
    await profiles.resolve('a', 'token-1')
    expect(await profiles.resolve('a', 'token-2')).toEqual({
      accountUuid: 'other',
      email: 'bob@example.com',
      displayName: 'Bob',
      organizationUuid: null,
      organizationName: null,
      organizationType: null,
    })
    expect(profiles.peek('a', 'token-1', false)).toBeNull()
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('shares one request between callers asking at the same time', async () => {
    fetchMock.mockImplementation(async () => respond(200, PROFILE_BODY))
    const profiles = new LoginProfiles(dir, 'ua')
    const [first, second] = await Promise.all([profiles.resolve('a', 'token-1'), profiles.resolve('a', 'token-1')])
    expect(first).toEqual(PROFILE)
    expect(second).toEqual(PROFILE)
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it('peek starts a lookup in the background only when asked to', async () => {
    fetchMock.mockImplementation(async () => respond(200, PROFILE_BODY))
    const profiles = new LoginProfiles(dir, 'ua')
    expect(profiles.peek('a', 'token-1', false)).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
    const resolved = new Promise((resolve) => profiles.on('resolved', resolve))
    expect(profiles.peek('a', 'token-1', true)).toBeNull()
    expect(await resolved).toBe('a')
    expect(profiles.peek('a', 'token-1', false)).toEqual(PROFILE)
  })

  it.each([401, 403])('remembers a rejected token (%s) without asking again', async (status) => {
    fetchMock.mockImplementation(async () => respond(status))
    const profiles = new LoginProfiles(dir, 'ua')
    expect(await profiles.resolve('a', 'token-1')).toBeNull()
    expect(await profiles.resolve('a', 'token-1')).toBeNull()
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it('asks again only after a pause when the server failed', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000_000)
    fetchMock.mockResolvedValueOnce(respond(500))
    fetchMock.mockResolvedValueOnce(respond(200, PROFILE_BODY))
    const profiles = new LoginProfiles(dir, 'ua')
    const resolved = vi.fn()
    profiles.on('resolved', resolved)

    expect(await profiles.resolve('a', 'token-1')).toBeNull()
    now.mockReturnValue(1_000_000 + 4 * 60_000)
    expect(await profiles.resolve('a', 'token-1')).toBeNull()
    expect(fetchMock).toHaveBeenCalledOnce()
    expect(resolved).not.toHaveBeenCalled()

    now.mockReturnValue(1_000_000 + 5 * 60_000 + 1)
    expect(await profiles.resolve('a', 'token-1')).toEqual(PROFILE)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('treats a network error or an answer without account as a reason to retry', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000_000)
    fetchMock.mockRejectedValueOnce(new Error('offline'))
    fetchMock.mockResolvedValueOnce(respond(200, { account: { email: 'no-uuid@example.com' } }))
    const profiles = new LoginProfiles(dir, 'ua')

    expect(await profiles.resolve('a', 'token-1')).toBeNull()
    now.mockReturnValue(2_000_000)
    expect(await profiles.resolve('a', 'token-1')).toBeNull()
    now.mockReturnValue(3_000_000)
    fetchMock.mockResolvedValueOnce(respond(200, PROFILE_BODY))
    expect(await profiles.resolve('a', 'token-1')).toEqual(PROFILE)
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('keeps the pause per account and token', async () => {
    fetchMock.mockResolvedValueOnce(respond(503))
    fetchMock.mockImplementation(async () => respond(200, PROFILE_BODY))
    const profiles = new LoginProfiles(dir, 'ua')
    expect(await profiles.resolve('a', 'token-1')).toBeNull()
    expect(await profiles.resolve('b', 'token-1')).toEqual(PROFILE)
    expect(await profiles.resolve('a', 'token-2')).toEqual(PROFILE)
  })

  it('forgets an account', async () => {
    fetchMock.mockImplementation(async () => respond(200, PROFILE_BODY))
    const profiles = new LoginProfiles(dir, 'ua')
    await profiles.resolve('a', 'token-1')
    await profiles.resolve('b', 'token-2')
    profiles.forget('a')
    expect(profiles.peek('a', 'token-1', false)).toBeNull()
    await vi.waitFor(async () => {
      expect(Object.keys(await readCache())).toEqual(['b'])
    })
  })
})
