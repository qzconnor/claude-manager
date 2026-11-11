import type { BrowserRoute } from '@shared/types'
import { delay, type PageDriver } from './page-driver'

/**
 * Claude's routes for the page's requests (browser_route): answer them itself (status, body),
 * let them fail, or slow them down. The DevTools protocol holds the requests that match one
 * (`Fetch.enable` with their patterns) and hands them over in `Fetch.requestPaused`.
 */

/** The network errors a route can let requests fail with, by the protocol's names. */
export const ROUTE_ERRORS = {
  failed: 'Failed',
  blocked: 'BlockedByClient',
  timedout: 'TimedOut',
  refused: 'ConnectionRefused',
  offline: 'InternetDisconnected',
} as const
export type RouteError = keyof typeof ROUTE_ERRORS

/** A route with what it answers. */
export interface Route extends BrowserRoute {
  /** fulfill: the body of the answer. */
  body: string
  /** fulfill: headers of the answer, content-type included. */
  headers: Record<string, string>
  /** fail: the error. */
  error: RouteError | null
}

export const MAX_ROUTES = 30

/** Whether an address matches a route's pattern: `*` stands for anything; without `*` it is a part of the address. */
export function matchesPattern(pattern: string, url: string): boolean {
  if (!pattern.includes('*')) return url.includes(pattern)
  return wildcardMatch(pattern, url)
}

/**
 * Whether `text` is `pattern` with each `*` standing for anything. Not as a regular expression: `.*`
 * after `.*` backtracks, a pattern with ten `*` took seconds per request (and the app's main process
 * with it); this goes back only to the last `*`, at most length × length steps.
 */
export function wildcardMatch(pattern: string, text: string): boolean {
  let p = 0
  let t = 0
  let star = -1
  let resume = 0
  while (t < text.length) {
    if (p < pattern.length && pattern[p] === '*') {
      star = p++
      resume = t
    } else if (p < pattern.length && pattern[p] === text[t]) {
      p++
      t++
    } else if (star >= 0) {
      // The last `*` takes one character more.
      p = star + 1
      t = ++resume
    } else {
      return false
    }
  }
  while (p < pattern.length && pattern[p] === '*') p++
  return p === pattern.length
}

/** A pattern with `*` as a regular expression for the whole address, for the code of a test. */
export function patternRegExp(pattern: string): RegExp {
  const source = pattern
    .split('*')
    .map((part) => part.replace(/[.+?^${}()|[\]\\/]/g, '\\$&'))
    .join('.*')
  return new RegExp(`^${source}$`)
}

/**
 * The pattern for `Fetch.enable`: the protocol takes `*` and `?` as wildcards and `\` to escape
 * them. It may hold more requests than the route matches (they go on unchanged), never fewer.
 */
export function fetchPattern(pattern: string): string {
  const escaped = pattern.replace(/[\\?]/g, '\\$&')
  return pattern.includes('*') ? escaped : `*${escaped}*`
}

/** The route for a request, the newest first (as in Playwright); a preflight goes with the request it asks for. */
export function findRoute(routes: Route[], url: string, method: string, preflightFor: string | null = null): Route | undefined {
  const wanted = (preflightFor ?? method).toUpperCase()
  for (let i = routes.length - 1; i >= 0; i--) {
    const route = routes[i]
    if (route.method && route.method !== wanted) continue
    if (matchesPattern(route.pattern, url)) return route
  }
  return undefined
}

/** A guess of the content type of a body Claude gives without one. */
export function guessContentType(body: string): string {
  const text = body.trim()
  if (!text) return 'text/plain; charset=utf-8'
  if (/^[[{]/.test(text)) {
    try {
      JSON.parse(text)
      return 'application/json; charset=utf-8'
    } catch {
      // not JSON after all
    }
  }
  if (/^<(!doctype html|html|head|body|div|p|span|h\d)\b/i.test(text)) return 'text/html; charset=utf-8'
  if (/^<\?xml|^<svg\b/i.test(text)) return 'application/xml; charset=utf-8'
  return 'text/plain; charset=utf-8'
}

/** What a route did with a request, for the request in the network log. */
export function routedText(route: Route): string {
  const delayed = route.delayMs ? ` after ${route.delayMs} ms` : ''
  if (route.action === 'fail') return `failed (${route.error ?? 'failed'}) by route ${route.id}${delayed}`
  if (route.action === 'delay') return `delayed ${route.delayMs} ms by route ${route.id}`
  return `answered with ${route.status ?? 200} by route ${route.id}${delayed}`
}

export interface PausedRequest {
  requestId: string
  request: { url: string; method: string; headers?: Record<string, string> }
}

/** Headers of a request, by lower-case name. */
function lowerHeaders(headers: Record<string, string> | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [name, value] of Object.entries(headers ?? {})) out[name.toLowerCase()] = value
  return out
}

/** For a CORS preflight (OPTIONS before a request to another origin): the method of the request it asks for. */
export function preflightMethod(request: PausedRequest['request']): string | null {
  if (request.method !== 'OPTIONS') return null
  return lowerHeaders(request.headers)['access-control-request-method'] ?? null
}

/**
 * The headers of a route's answer: its own, and for a request of another origin those the page
 * needs to read it (CORS), unless the route set them.
 */
export function answerHeaders(route: Route, requestHeaders: Record<string, string> | undefined): { name: string; value: string }[] {
  const headers: Record<string, string> = { ...route.headers }
  const own = new Set(Object.keys(headers).map((name) => name.toLowerCase()))
  const origin = lowerHeaders(requestHeaders).origin
  if (origin && !own.has('access-control-allow-origin')) {
    headers['Access-Control-Allow-Origin'] = origin
    headers['Access-Control-Allow-Credentials'] = 'true'
    headers['Access-Control-Expose-Headers'] = '*'
  }
  return Object.entries(headers).map(([name, value]) => ({ name, value }))
}

/**
 * Answers a request the protocol holds: by its route (null: it goes on unchanged). Never throws: a
 * request left held would hang the page. Returns whether the route took it.
 */
export async function answerRequest(page: PageDriver, session: string | undefined, paused: PausedRequest, route: Route | null): Promise<boolean> {
  const send = (method: string, params: Record<string, unknown>) => page.cdpIn(session, method, { requestId: paused.requestId, ...params })
  try {
    if (!route) {
      await send('Fetch.continueRequest', {})
      return false
    }
    const headers = lowerHeaders(paused.request.headers)
    // A preflight of another origin for a request the route answers: the page may send it.
    const asked = preflightMethod(paused.request)
    if (asked && route.method !== 'OPTIONS' && route.action !== 'delay') {
      await send('Fetch.fulfillRequest', {
        responseCode: 204,
        responseHeaders: [
          { name: 'Access-Control-Allow-Origin', value: headers.origin ?? '*' },
          { name: 'Access-Control-Allow-Credentials', value: 'true' },
          { name: 'Access-Control-Allow-Methods', value: asked },
          { name: 'Access-Control-Allow-Headers', value: headers['access-control-request-headers'] || '*' },
          { name: 'Access-Control-Max-Age', value: '600' },
        ],
        body: '',
      })
      return false
    }
    if (route.delayMs) await delay(route.delayMs)
    if (route.action === 'delay') await send('Fetch.continueRequest', {})
    else if (route.action === 'fail') await send('Fetch.failRequest', { errorReason: ROUTE_ERRORS[route.error ?? 'failed'] })
    else {
      await send('Fetch.fulfillRequest', {
        responseCode: route.status ?? 200,
        responseHeaders: answerHeaders(route, paused.request.headers),
        body: Buffer.from(route.body, 'utf8').toString('base64'),
      })
    }
    return true
  } catch {
    await send('Fetch.continueRequest', {}).catch(() => undefined)
    return false
  }
}

/** Has the protocol hold the requests of the routes (in the page or a frame's session), or none. */
export async function enableRoutes(page: PageDriver, session: string | undefined, routes: Route[]): Promise<void> {
  if (routes.length === 0) {
    await page.cdpIn(session, 'Fetch.disable').catch(() => undefined)
    return
  }
  const patterns = [...new Set(routes.map((route) => fetchPattern(route.pattern)))].map((urlPattern) => ({ urlPattern, requestStage: 'Request' }))
  await page.cdpIn(session, 'Fetch.enable', { patterns, handleAuthRequests: false })
}

/** A route as the badge over the page and the renderer see it. */
export function routeState(route: Route): BrowserRoute {
  const { id, pattern, method, action, status, delayMs, hits, timesLeft } = route
  return { id, pattern, method, action, status, delayMs, hits, timesLeft }
}
