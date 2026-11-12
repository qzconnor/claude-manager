import { mkdtemp, rm } from 'node:fs/promises'
import { createServer, request, type IncomingHttpHeaders, type IncomingMessage } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppContext } from '../context'

// safeStorage that "encrypts" with a version prefix in front of the plain text, as Chromium does.
const electron = vi.hoisted(() => ({
  app: {},
  safeStorage: {
    isAsyncEncryptionAvailable: async () => true,
    encryptStringAsync: async (plain: string) => Buffer.from(`v11${plain}`, 'utf8'),
    decryptStringAsync: async (data: Buffer) => ({ result: data.toString('utf8').slice(3), shouldReEncrypt: false }),
  },
}))
vi.mock('electron', () => electron)

// The real compare, watched: the token has to be compared in constant time.
const timingSafeEqual = vi.hoisted(() => vi.fn<(a: NodeJS.ArrayBufferView, b: NodeJS.ArrayBufferView) => boolean>())
vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>()
  timingSafeEqual.mockImplementation(actual.timingSafeEqual)
  return { ...actual, timingSafeEqual }
})

import { ApiServer } from './api-server'

interface Answer {
  status: number
  headers: IncomingHttpHeaders
  body: string
}

interface RequestOptions {
  method?: string
  headers?: Record<string, string>
  /** The Host header; `null` sends none. Defaults to the server's own `127.0.0.1:<port>`. */
  host?: string | null
}

let dir: string
let port: number
let server: ApiServer
let token: string
let app: ReturnType<typeof fakeApp>

/** A port nothing listens on right now. The API server needs a fixed one: its Host check names it. */
async function freePort(): Promise<number> {
  const probe = createServer()
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve))
  const { port: free } = probe.address() as AddressInfo
  await new Promise<void>((resolve) => probe.close(() => resolve()))
  return free
}

function fakeApp(userDataDir: string, apiPort: number) {
  const off = () => undefined
  return {
    userDataDir,
    settings: { get: () => ({ api: { enabled: true, port: apiPort } }), on: () => off },
    accounts: { list: vi.fn(() => [{ id: 'system' }]), on: () => off },
    terminals: { list: () => [], on: () => off },
    usage: { on: () => off },
    sessions: { on: () => off },
    appInfo: async () => ({ name: 'Claude Manager', version: '1.2.3' }),
  }
}

/** Starts a request to the server on 127.0.0.1 and hands over the response as soon as its head arrived. */
function open(path: string, { method = 'GET', headers = {}, host = `127.0.0.1:${port}` }: RequestOptions = {}): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: '127.0.0.1', port, path, method, agent: false, setHost: false, headers: host === null ? headers : { host, ...headers } },
      resolve,
    )
    req.on('error', reject)
    req.end()
  })
}

async function send(path: string, options: RequestOptions = {}): Promise<Answer> {
  const res = await open(path, options)
  let body = ''
  res.setEncoding('utf8')
  for await (const chunk of res) body += chunk
  return { status: res.statusCode ?? 0, headers: res.headers, body }
}

const bearer = (value: string) => ({ authorization: `Bearer ${value}` })

/** The token with its last character replaced: as long as the real one, but wrong. */
function sameLengthWrongToken(): string {
  return token.slice(0, -1) + (token.endsWith('A') ? 'B' : 'A')
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'cm-api-'))
  port = await freePort()
  app = fakeApp(dir, port)
  server = new ApiServer(app as unknown as AppContext, { version: '1.2.3', activateTerminal: () => undefined })
  await server.init()
  expect(server.status()).toMatchObject({ running: true, port, error: null })
  token = server.status().token
  expect(token.length).toBeGreaterThan(20)
  timingSafeEqual.mockClear()
})

afterEach(async () => {
  server.dispose()
  await rm(dir, { recursive: true, force: true, maxRetries: 3 })
})

describe('ApiServer Host check', () => {
  it('answers requests addressed to 127.0.0.1 or localhost with its port, in any case', async () => {
    for (const host of [`127.0.0.1:${port}`, `localhost:${port}`, `LocalHost:${port}`]) {
      const answer = await send('/api/v1/health', { host })
      expect(answer.status).toBe(200)
      expect(JSON.parse(answer.body)).toEqual({ status: 'ok', name: 'Claude Manager', version: '1.2.3' })
    }
  })

  it.each([
    ['another host name', (p: number) => `rebind.example:${p}`],
    ['another host name without port', () => 'rebind.example'],
    ['a subdomain that starts with localhost', (p: number) => `localhost.rebind.example:${p}`],
    ['the loopback address without port', () => '127.0.0.1'],
    ['the loopback address with another port', (p: number) => `127.0.0.1:${p + 1}`],
    ['another loopback address', (p: number) => `127.0.0.2:${p}`],
    ['the IPv6 loopback address', (p: number) => `[::1]:${p}`],
    ['an empty host', () => ''],
  ])('refuses %s with 403, before the docs, public routes and the token check', async (_name, hostOf) => {
    const host = hostOf(port)
    for (const [path, headers] of [
      ['/api/v1/accounts', bearer(token)],
      ['/api/v1/health', {}],
      ['/', {}],
      ['/openapi.json', {}],
      ['/api/v1/unknown', {}],
    ] as const) {
      const answer = await send(path, { host, headers })
      expect(answer.status, `${path} with Host "${host}"`).toBe(403)
      expect(JSON.parse(answer.body)).toEqual({ error: { status: 403, message: 'Ungültiger Host-Header.' } })
    }
    expect(app.accounts.list).not.toHaveBeenCalled()
  })

  it('refuses a request without Host header and does not run the route', async () => {
    const answer = await send('/api/v1/accounts', { host: null, headers: bearer(token) })
    // Node itself refuses HTTP/1.1 requests without Host with 400; the server's own check answers 403.
    expect([400, 403]).toContain(answer.status)
    expect(app.accounts.list).not.toHaveBeenCalled()
  })
})

describe('ApiServer token check', () => {
  it('serves the docs page, the OpenAPI document and the health check without a token', async () => {
    const docs = await send('/docs')
    expect(docs.status).toBe(200)
    expect(docs.headers['content-type']).toBe('text/html; charset=utf-8')
    // The page may not load or run anything from elsewhere.
    expect(docs.headers['content-security-policy']).toBe("default-src 'none'; style-src 'unsafe-inline'")
    expect((await send('/')).status).toBe(200)
    expect((await send('/openapi.json')).status).toBe(200)
    expect((await send('/api/v1/health')).status).toBe(200)
  })

  it('refuses a route without a token with 401 and does not run it', async () => {
    const answer = await send('/api/v1/accounts')
    expect(answer.status).toBe(401)
    expect(answer.headers['www-authenticate']).toBe('Bearer')
    expect(JSON.parse(answer.body)).toEqual({ error: { status: 401, message: 'Token fehlt oder ist ungültig.' } })
    expect(app.accounts.list).not.toHaveBeenCalled()
  })

  it.each([
    ['a token of the same length that differs in one character', () => bearer(sameLengthWrongToken())],
    ['the token without its last character', () => bearer(token.slice(0, -1))],
    ['the token with a character added', () => bearer(`${token}x`)],
    ['the token followed by another word', () => bearer(`${token} ${token}`)],
    ['an empty bearer token', () => ({ authorization: 'Bearer ' })],
    ['the token without the Bearer scheme', () => ({ authorization: token })],
    ['the token with the Basic scheme', () => ({ authorization: `Basic ${token}` })],
    ['the token in another header', () => ({ 'x-api-token': token })],
  ])('refuses %s with 401 and does not run the route', async (_name, headersOf) => {
    const answer = await send('/api/v1/accounts', { headers: headersOf() })
    expect(answer.status).toBe(401)
    expect(answer.headers['www-authenticate']).toBe('Bearer')
    expect(app.accounts.list).not.toHaveBeenCalled()
  })

  it('runs the route with the right token, the scheme in any case and spaces around it', async () => {
    for (const authorization of [`Bearer ${token}`, `bearer ${token}`, `BEARER   ${token}  `]) {
      const answer = await send('/api/v1/accounts', { headers: { authorization } })
      expect(answer.status, authorization).toBe(200)
      expect(JSON.parse(answer.body)).toEqual([{ id: 'system' }])
    }
    expect(app.accounts.list).toHaveBeenCalledTimes(3)
  })

  it('compares a token of the right length in constant time', async () => {
    const wrong = sameLengthWrongToken()
    expect((await send('/api/v1/accounts', { headers: bearer(wrong) })).status).toBe(401)
    expect(timingSafeEqual).toHaveBeenCalledOnce()
    const [a, b] = timingSafeEqual.mock.calls[0]
    expect(Buffer.from(a.buffer, a.byteOffset, a.byteLength).toString()).toBe(wrong)
    expect(Buffer.from(b.buffer, b.byteOffset, b.byteLength).toString()).toBe(token)
  })

  it('takes the token from the query only for the event stream', async () => {
    expect((await send(`/api/v1/accounts?access_token=${token}`)).status).toBe(401)
    expect(app.accounts.list).not.toHaveBeenCalled()
    expect((await send(`/api/v1/events?access_token=${sameLengthWrongToken()}`)).status).toBe(401)
    expect((await send('/api/v1/events')).status).toBe(401)

    for (const options of [{ path: `/api/v1/events?access_token=${token}` }, { path: '/api/v1/events', headers: bearer(token) }]) {
      const stream = await open(options.path, { headers: options.headers })
      expect(stream.statusCode).toBe(200)
      expect(stream.headers['content-type']).toBe('text/event-stream; charset=utf-8')
      stream.destroy()
    }
  })

  it('refuses the old token after a new one was generated and ends the streams opened with it', async () => {
    const old = token
    const stream = await open('/api/v1/events', { headers: bearer(old) })
    expect(stream.statusCode).toBe(200)
    const ended = new Promise<void>((resolve) => {
      stream.on('end', resolve)
      stream.on('close', resolve)
      stream.resume()
    })

    const next = (await server.regenerateToken()).token
    expect(next).not.toBe(old)
    await ended
    expect((await send('/api/v1/accounts', { headers: bearer(old) })).status).toBe(401)
    expect((await send('/api/v1/accounts', { headers: bearer(next) })).status).toBe(200)
  })
})

describe('ApiServer and other origins', () => {
  it('sends no CORS headers, so pages of other origins can neither send the token nor read the answers', async () => {
    // The preflight a browser sends before a cross-origin request with an Authorization header.
    const preflight = await send('/api/v1/accounts', {
      method: 'OPTIONS',
      headers: { origin: 'https://site.example', 'access-control-request-method': 'GET', 'access-control-request-headers': 'authorization' },
    })
    expect(preflight.status).toBe(405)
    const answer = await send('/api/v1/health', { headers: { origin: 'https://site.example' } })
    expect(answer.status).toBe(200)
    for (const headers of [preflight.headers, answer.headers]) {
      expect(Object.keys(headers).filter((name) => name.startsWith('access-control-'))).toEqual([])
    }
    expect(app.accounts.list).not.toHaveBeenCalled()
  })
})

describe('ApiServer routing before the token check', () => {
  it('answers unknown paths with 404 and other methods with 405, without running a route', async () => {
    expect((await send('/api/v1/nothing')).status).toBe(404)
    const answer = await send('/api/v1/accounts', { method: 'DELETE' })
    expect(answer.status).toBe(405)
    expect(answer.headers.allow).toBe('GET')
    expect(app.accounts.list).not.toHaveBeenCalled()
  })
})
