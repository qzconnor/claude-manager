import { describe, expect, it, vi } from 'vitest'
import type { PageDriver } from './page-driver'
import { answerHeaders, answerRequest, fetchPattern, findRoute, guessContentType, matchesPattern, preflightMethod, type Route, routedText } from './page-routes'

function route(change: Partial<Route>): Route {
  return {
    id: 1,
    pattern: '/api/users',
    method: null,
    action: 'fulfill',
    status: 200,
    delayMs: 0,
    hits: 0,
    timesLeft: null,
    body: '',
    headers: {},
    error: null,
    ...change,
  }
}

describe('matchesPattern with many *', () => {
  it('takes no time for a pattern a regular expression would backtrack on', () => {
    const started = Date.now()
    expect(matchesPattern(`${'*a'.repeat(12)}b`, 'a'.repeat(2000))).toBe(false)
    expect(matchesPattern(`${'*a'.repeat(12)}*`, 'a'.repeat(2000))).toBe(true)
    expect(Date.now() - started).toBeLessThan(500)
  })

  it('matches like the regular expression did', () => {
    expect(matchesPattern('*', '')).toBe(true)
    expect(matchesPattern('a**b', 'ab')).toBe(true)
    expect(matchesPattern('a*b*c', 'axxbyyc')).toBe(true)
    expect(matchesPattern('a*b*c', 'axxbyy')).toBe(false)
    expect(matchesPattern('*.js', 'https://x.dev/app.json')).toBe(false)
    expect(matchesPattern('*a*', 'bbb')).toBe(false)
  })
})

describe('matchesPattern', () => {
  it('takes * for anything and a pattern without * as a part of the address', () => {
    expect(matchesPattern('/api/users', 'http://localhost:3000/api/users?page=2')).toBe(true)
    expect(matchesPattern('/api/users', 'http://localhost:3000/api/orders')).toBe(false)
    expect(matchesPattern('*/api/*/items', 'https://x.dev/api/v2/items')).toBe(true)
    expect(matchesPattern('*/api/*/items', 'https://x.dev/api/v2/items/3')).toBe(false)
    expect(matchesPattern('https://cdn.example.com/*.js', 'https://cdn.example.com/app.js')).toBe(true)
  })

  it('takes the other characters of a pattern as they are', () => {
    expect(matchesPattern('*/search?q=*', 'https://x.dev/search?q=cats')).toBe(true)
    expect(matchesPattern('*/a.b*', 'https://x.dev/aXb')).toBe(false)
    expect(matchesPattern('*(1)*', 'https://x.dev/file(1).txt')).toBe(true)
  })
})

describe('fetchPattern', () => {
  it('escapes the protocol’s wildcards and wraps a part of an address in *', () => {
    expect(fetchPattern('/api/users')).toBe('*/api/users*')
    expect(fetchPattern('*/search?q=*')).toBe('*/search\\?q=*')
    expect(fetchPattern('a\\b')).toBe('*a\\\\b*')
  })
})

describe('findRoute', () => {
  it('takes the newest route that matches, by method', () => {
    const routes = [route({ id: 1 }), route({ id: 2, method: 'POST' }), route({ id: 3, pattern: '/other' })]
    expect(findRoute(routes, 'http://x/api/users', 'GET')?.id).toBe(1)
    expect(findRoute(routes, 'http://x/api/users', 'POST')?.id).toBe(2)
    expect(findRoute(routes, 'http://x/nothing', 'GET')).toBeUndefined()
  })

  it('finds the route of the request a preflight asks for', () => {
    const routes = [route({ id: 4, method: 'PUT' })]
    expect(findRoute(routes, 'http://x/api/users', 'OPTIONS')).toBeUndefined()
    expect(findRoute(routes, 'http://x/api/users', 'OPTIONS', 'PUT')?.id).toBe(4)
  })
})

describe('preflightMethod', () => {
  it('tells a CORS preflight from another OPTIONS request', () => {
    expect(preflightMethod({ url: 'x', method: 'OPTIONS', headers: { 'Access-Control-Request-Method': 'DELETE' } })).toBe('DELETE')
    expect(preflightMethod({ url: 'x', method: 'OPTIONS', headers: {} })).toBeNull()
    expect(preflightMethod({ url: 'x', method: 'GET', headers: { 'access-control-request-method': 'GET' } })).toBeNull()
  })
})

describe('guessContentType', () => {
  it('knows JSON, HTML and plain text', () => {
    expect(guessContentType('{"a":1}')).toMatch(/^application\/json/)
    expect(guessContentType('[1,2]')).toMatch(/^application\/json/)
    expect(guessContentType('{not json')).toMatch(/^text\/plain/)
    expect(guessContentType('<!doctype html><p>x')).toMatch(/^text\/html/)
    expect(guessContentType('<svg></svg>')).toMatch(/^application\/xml/)
    expect(guessContentType('')).toMatch(/^text\/plain/)
  })
})

describe('answerHeaders', () => {
  it('lets a page of another origin read the answer, unless the route says otherwise', () => {
    const headers = answerHeaders(route({ headers: { 'Content-Type': 'application/json' } }), { Origin: 'http://localhost:5173' })
    expect(headers).toContainEqual({ name: 'Access-Control-Allow-Origin', value: 'http://localhost:5173' })
    expect(headers).toContainEqual({ name: 'Content-Type', value: 'application/json' })
    const own = answerHeaders(route({ headers: { 'access-control-allow-origin': '*' } }), { origin: 'http://a' })
    expect(own).toEqual([{ name: 'access-control-allow-origin', value: '*' }])
    expect(answerHeaders(route({}), {})).toEqual([])
  })
})

describe('routedText', () => {
  it('says what the route did, for the network log', () => {
    expect(routedText(route({ id: 2, status: 500 }))).toBe('answered with 500 by route 2')
    expect(routedText(route({ id: 3, action: 'fail', error: 'offline', delayMs: 100 }))).toBe('failed (offline) by route 3 after 100 ms')
    expect(routedText(route({ id: 4, action: 'delay', delayMs: 2000 }))).toBe('delayed 2000 ms by route 4')
  })
})

describe('answerRequest', () => {
  function page(fail?: string) {
    const calls: [string, Record<string, unknown>][] = []
    const driver = {
      cdpIn: vi.fn(async (_session: string | undefined, method: string, params: Record<string, unknown>) => {
        calls.push([method, params])
        if (method === fail) throw new Error('gone')
        return {}
      }),
    }
    return { driver: driver as unknown as PageDriver, calls }
  }
  const paused = { requestId: 'F1', request: { url: 'http://x/api/users', method: 'GET', headers: {} } }

  it('answers with the route’s status, headers and body', async () => {
    const { driver, calls } = page()
    const taken = await answerRequest(driver, undefined, paused, route({ status: 404, body: '{"error":"none"}', headers: { 'Content-Type': 'application/json' } }))
    expect(taken).toBe(true)
    expect(calls).toEqual([
      [
        'Fetch.fulfillRequest',
        {
          requestId: 'F1',
          responseCode: 404,
          responseHeaders: [{ name: 'Content-Type', value: 'application/json' }],
          body: Buffer.from('{"error":"none"}').toString('base64'),
        },
      ],
    ])
  })

  it('lets the request fail, or go on unchanged without a route', async () => {
    const failing = page()
    await answerRequest(failing.driver, 'S', paused, route({ action: 'fail', error: 'blocked' }))
    expect(failing.calls).toEqual([['Fetch.failRequest', { requestId: 'F1', errorReason: 'BlockedByClient' }]])
    const free = page()
    expect(await answerRequest(free.driver, undefined, paused, null)).toBe(false)
    expect(free.calls).toEqual([['Fetch.continueRequest', { requestId: 'F1' }]])
  })

  it('answers a preflight for the route itself', async () => {
    const { driver, calls } = page()
    const preflight = { requestId: 'F2', request: { url: 'http://x/api/users', method: 'OPTIONS', headers: { Origin: 'http://app', 'Access-Control-Request-Method': 'POST' } } }
    expect(await answerRequest(driver, undefined, preflight, route({ method: 'POST' }))).toBe(false)
    expect(calls[0][0]).toBe('Fetch.fulfillRequest')
    expect(calls[0][1].responseCode).toBe(204)
    expect(calls[0][1].responseHeaders).toContainEqual({ name: 'Access-Control-Allow-Methods', value: 'POST' })
  })

  it('lets the request go on when the answer fails, so the page doesn’t hang', async () => {
    const { driver, calls } = page('Fetch.fulfillRequest')
    expect(await answerRequest(driver, undefined, paused, route({}))).toBe(false)
    expect(calls.map(([method]) => method)).toEqual(['Fetch.fulfillRequest', 'Fetch.continueRequest'])
  })
})
