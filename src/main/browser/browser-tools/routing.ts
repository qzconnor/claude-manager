import { routeLabel } from '@shared/browser'
import type { BrowserRoute } from '@shared/types'
import { guessContentType, ROUTE_ERRORS, type Route, type RouteError } from '../page-routes'
import { type Args, cut, oneOf, optionalBoolean, optionalNumber, optionalString, ToolError } from '../tool-args'
import { routeCode } from './test-code'
import { tool, type ToolDefinition } from './tool'

/** browser_route: Claude answers the page's requests itself, lets them fail or slows them down. */

const MAX_BODY_CHARS = 1_000_000
const MAX_DELAY_MS = 60_000
const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'] as const

type RouteSpec = Omit<Route, 'id' | 'hits'>
type RouteParams = { kind: 'add'; route: RouteSpec } | { kind: 'remove'; ids: number[] | null } | { kind: 'list' }

export const routingTools: ToolDefinition<never>[] = [
  tool({
    name: 'browser_route',
    title: 'Mock or block requests',
    description:
      "Answers the page's requests to matching addresses yourself instead of the server (status, body, headers), lets them fail with a network error, or slows them down: to test error states, empty lists, slow APIs, or a backend that isn't there yet. url: * matches anything (\"*/api/users*\"), without * a part of the address (\"/api/users\"). The newest matching route wins. Routes stay until removed or the session ends; the user sees them over the page. Requests answered by a route say so in browser_network_requests. Without url, remove or clear: lists the routes.",
    properties: {
      url: { type: 'string', description: 'The addresses to take: * matches anything; without * a part of the address.' },
      method: { type: 'string', enum: [...METHODS], description: 'Only requests with this method; default: all.' },
      status: { type: 'number', description: 'Answer with this HTTP status (default 200 when a body is given).' },
      json: { description: 'Answer with this JSON value (content-type application/json).' },
      body: { type: 'string', description: 'Answer with this text (content-type guessed: JSON, HTML or plain text).' },
      contentType: { type: 'string', description: 'The content-type of the answer.' },
      headers: { type: 'object', additionalProperties: { type: 'string' }, description: 'More headers of the answer.' },
      fail: {
        type: 'string',
        enum: Object.keys(ROUTE_ERRORS),
        description: 'Let the requests fail with this network error instead (blocked: like an ad blocker; offline: no connection).',
      },
      delayMs: { type: 'number', description: `Wait this long first (up to ${MAX_DELAY_MS}); alone: the real answer, late.` },
      times: { type: 'number', description: 'Only the next this many requests; then the route ends.' },
      remove: { type: 'number', description: 'Remove the route with this id.' },
      clear: { type: 'boolean', description: 'Remove all routes.' },
    },
    kind: 'route',
    whileDialog: true,
    parse: (args): RouteParams => {
      if (optionalBoolean(args, 'clear')) return { kind: 'remove', ids: null }
      const remove = optionalNumber(args, 'remove', 1, 1_000_000)
      if (remove !== undefined) return { kind: 'remove', ids: [Math.floor(remove)] }
      if (args.url === undefined || args.url === null) {
        if (Object.keys(args).some((key) => args[key] !== undefined && args[key] !== null)) throw new ToolError('url is required for a route.')
        return { kind: 'list' }
      }
      return { kind: 'add', route: parseRoute(args) }
    },
    label: (p) => (p.kind === 'list' ? 'Listet die Routen' : p.kind === 'remove' ? (p.ids ? `Entfernt Route ${p.ids[0]}` : 'Entfernt alle Routen') : `Route ${cut(routeLabel({ ...p.route, id: 0, hits: 0 }), 80)}`),
    run: async (ctx, p) => {
      if (p.kind === 'list') {
        const routes = ctx.routes()
        ctx.note(`${routes.length} Routen`)
        return { text: routes.length ? `Routes (newest wins):\n${listRoutes(routes)}` : 'No routes: all requests go to the network.' }
      }
      if (p.kind === 'remove') {
        if (p.ids && !ctx.routes().some((route) => route.id === p.ids![0])) throw new ToolError(`There is no route ${p.ids[0]}. List them with browser_route (no arguments).`)
        const removed = await ctx.removeRoutes(p.ids)
        const left = ctx.routes()
        ctx.highlight(p.ids ? `Entfernt Route ${p.ids[0]}` : 'Entfernt alle Routen')
        if (removed) ctx.record([p.ids ? `// Claude removed route ${p.ids[0]} here.` : 'await page.unrouteAll()'])
        return { text: `Removed ${removed} route(s).${left.length ? `\nStill there:\n${listRoutes(left)}` : ' All requests go to the network again.'}` }
      }
      const route = await ctx.addRoute(p.route)
      const label = `Route ${route.id}: ${routeLabel(route)}`
      ctx.highlight(label)
      ctx.label(label)
      ctx.record(routeCode(p.route))
      return {
        text: `Added route ${route.id}: ${describeRoute(route)}. It takes requests from now on (reload the page for those of its load).\n\nRoutes (newest wins):\n${listRoutes(ctx.routes())}`,
      }
    },
  }),
]

function parseRoute(args: Args): RouteSpec {
  const pattern = optionalString(args, 'url', 2000)?.trim()
  if (!pattern) throw new ToolError('url must be a pattern like "*/api/users*" or a part of an address.')
  if (/^\*+$/.test(pattern)) throw new ToolError('url "*" would take every request of the page, its own files too; name the addresses.')
  const method = args.method === undefined || args.method === null ? null : oneOf(args, 'method', METHODS)
  const status = optionalNumber(args, 'status', 100, 599)
  const delayMs = Math.round(optionalNumber(args, 'delayMs', 0, MAX_DELAY_MS) ?? 0)
  const times = optionalNumber(args, 'times', 1, 10_000)
  const fail = args.fail === undefined || args.fail === null ? null : oneOf(args, 'fail', Object.keys(ROUTE_ERRORS) as RouteError[])
  const hasJson = args.json !== undefined
  const text = optionalString(args, 'body', MAX_BODY_CHARS)
  if (hasJson && text !== undefined) throw new ToolError('Give json or body, not both.')
  const headers = parseHeaders(args)
  const contentType = optionalString(args, 'contentType', 200)?.trim()
  const answers = status !== undefined || hasJson || text !== undefined || contentType !== undefined || Object.keys(headers).length > 0
  if (fail && answers) throw new ToolError('A route either answers (status, json, body, headers) or fails, not both.')
  if (!fail && !answers && !delayMs) throw new ToolError('Say what the route does: status, json or body to answer; fail to let requests fail; delayMs to slow them down.')
  let body = ''
  if (hasJson) {
    body = JSON.stringify(args.json)
    if (body === undefined) throw new ToolError('json must be a JSON value.')
    if (body.length > MAX_BODY_CHARS) throw new ToolError('json is too long.')
  } else if (text !== undefined) body = text
  if (answers && !Object.keys(headers).some((name) => name.toLowerCase() === 'content-type')) {
    headers['Content-Type'] = contentType || (hasJson ? 'application/json; charset=utf-8' : guessContentType(body))
  }
  return {
    pattern,
    method,
    action: fail ? 'fail' : answers ? 'fulfill' : 'delay',
    status: fail || !answers ? null : (status ?? 200),
    body,
    headers,
    error: fail,
    delayMs,
    timesLeft: times === undefined ? null : Math.floor(times),
  }
}

function parseHeaders(args: Args): Record<string, string> {
  const value = args.headers
  if (value === undefined || value === null) return {}
  if (typeof value !== 'object' || Array.isArray(value)) throw new ToolError('headers must be an object of names and values.')
  const out: Record<string, string> = {}
  for (const [name, header] of Object.entries(value)) {
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name)) throw new ToolError(`${JSON.stringify(name)} is no header name.`)
    if (typeof header !== 'string' || /[\r\n]/.test(header)) throw new ToolError(`headers.${name} must be a string on one line.`)
    out[name] = header
  }
  return out
}

/** A route for Claude. */
function describeRoute(route: BrowserRoute): string {
  const target = `${route.method ? `${route.method} ` : ''}${route.pattern}`
  const delay = route.delayMs ? `after ${route.delayMs} ms, ` : ''
  const what =
    route.action === 'fail' ? `${delay}fails` : route.action === 'delay' ? `goes on after ${route.delayMs} ms` : `${delay}answered with ${route.status}`
  const times = route.timesLeft !== null ? ` (${route.timesLeft} more time(s))` : ''
  return `${target} → ${what}${times}`
}

function listRoutes(routes: BrowserRoute[]): string {
  return routes.map((route) => `- ${route.id}: ${describeRoute(route)}; took ${route.hits} request(s)`).join('\n')
}
