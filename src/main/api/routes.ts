import type { TerminalCreateOptions } from '@shared/types'
import type { AppContext } from '../context'
import {
  HttpError,
  optionalBoolean,
  optionalInteger,
  optionalString,
  optionalStringArray,
  queryInteger,
  requiredString,
} from './http'
import { ref } from './schemas'

export type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'DELETE'

export interface RouteContext {
  app: AppContext
  params: Record<string, string>
  query: URLSearchParams
  body(): Promise<Record<string, unknown>>
  /** Shows the terminal tab in the app window and brings the window to the front. */
  activateTerminal(id: string): void
}

interface Param {
  name: string
  description: string
  schema?: Record<string, unknown>
  required?: boolean
}

export interface RouteDoc {
  tag: string
  summary: string
  description?: string
  pathParams?: Param[]
  queryParams?: Param[]
  requestBody?: { schema: Record<string, unknown>; example?: unknown; required?: boolean }
  /** Omitted = 204 No Content. */
  response?: { description: string; schema?: Record<string, unknown>; contentType?: string }
  /** Endpoints without bearer token. */
  public?: boolean
}

export interface Route {
  method: HttpMethod
  /** OpenAPI path template, e.g. `/api/v1/terminals/{id}`. */
  path: string
  doc: RouteDoc
  /** Return value is sent as JSON; `undefined` becomes 204 No Content. */
  handler?: (ctx: RouteContext) => unknown
}

const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function requireAccount(ctx: RouteContext, id: string) {
  const account = ctx.app.accounts.list().find((a) => a.id === id)
  if (!account) throw new HttpError(404, `Account „${id}“ nicht gefunden.`)
  return account
}

function requireTerminal(ctx: RouteContext, id: string) {
  const terminal = ctx.app.terminals.list().find((t) => t.id === id)
  if (!terminal) throw new HttpError(404, `Terminal „${id}“ nicht gefunden.`)
  return terminal
}

const accountIdParam: Param = { name: 'accountId', description: 'Account-ID (system für den Standard-Login)' }
const terminalIdParam: Param = { name: 'id', description: 'Terminal-ID' }

export const routes: Route[] = [
  // --- meta ------------------------------------------------------------------
  {
    method: 'GET',
    path: '/api/v1/health',
    doc: {
      tag: 'Meta',
      summary: 'Erreichbarkeit prüfen',
      description: 'Benötigt keinen Token.',
      public: true,
      response: {
        description: 'Server läuft',
        schema: { type: 'object', properties: { status: { const: 'ok' }, name: { type: 'string' }, version: { type: 'string' } } },
      },
    },
    handler: async ({ app }) => {
      const info = await app.appInfo()
      return { status: 'ok', name: info.name, version: info.version }
    },
  },
  {
    method: 'GET',
    path: '/api/v1/info',
    doc: {
      tag: 'Meta',
      summary: 'App- und Claude-Code-Version',
      response: { description: 'Versionen und Pfade', schema: { type: 'object' } },
    },
    handler: ({ app }) => app.appInfo(),
  },

  // --- accounts --------------------------------------------------------------
  {
    method: 'GET',
    path: '/api/v1/accounts',
    doc: {
      tag: 'Accounts',
      summary: 'Alle Accounts',
      description: 'Secrets werden nie ausgegeben, nur eine maskierte Vorschau.',
      response: { description: 'Accounts', schema: { type: 'array', items: ref('Account') } },
    },
    handler: ({ app }) => app.accounts.list(),
  },
  {
    method: 'GET',
    path: '/api/v1/accounts/{accountId}',
    doc: {
      tag: 'Accounts',
      summary: 'Einzelner Account',
      pathParams: [accountIdParam],
      response: { description: 'Account', schema: ref('Account') },
    },
    handler: (ctx) => requireAccount(ctx, ctx.params.accountId),
  },

  // --- usage -----------------------------------------------------------------
  {
    method: 'GET',
    path: '/api/v1/usage',
    doc: {
      tag: 'Usage',
      summary: 'Plan-Limits aller Accounts',
      description:
        'Zuletzt bekannte Werte (5-Stunden- und Wochenlimit). Die App fragt die Limits selbst im eingestellten Intervall ab.',
      response: { description: 'Usage je Account', schema: { type: 'array', items: ref('AccountUsage') } },
    },
    handler: ({ app }) => app.usage.getAll(),
  },
  {
    method: 'POST',
    path: '/api/v1/usage/refresh',
    doc: {
      tag: 'Usage',
      summary: 'Limits jetzt abrufen',
      description: 'Höchstens einmal pro Minute und Account; häufigere Aufrufe liefern die zwischengespeicherten Werte.',
      requestBody: {
        required: false,
        schema: { type: 'object', properties: { accountId: { type: 'string', description: 'Leer = alle Accounts' } } },
        example: { accountId: 'system' },
      },
      response: { description: 'Usage je Account', schema: { type: 'array', items: ref('AccountUsage') } },
    },
    handler: async (ctx) => {
      const accountId = optionalString(await ctx.body(), 'accountId', 200)
      if (accountId) requireAccount(ctx, accountId)
      return ctx.app.usage.refresh(accountId)
    },
  },
  {
    method: 'GET',
    path: '/api/v1/accounts/{accountId}/stats',
    doc: {
      tag: 'Usage',
      summary: 'Token-Statistik',
      description: 'Aus den lokalen Session-Transcripts berechnet (inkl. Subagents), Tage in lokaler Zeit.',
      pathParams: [accountIdParam],
      queryParams: [{ name: 'days', description: 'Zeitraum in Tagen (1–365, Standard 30)', schema: { type: 'integer' } }],
      response: { description: 'Statistik', schema: ref('AccountTokenStats') },
    },
    handler: (ctx) => {
      requireAccount(ctx, ctx.params.accountId)
      return ctx.app.usage.stats(ctx.params.accountId, queryInteger(ctx.query, 'days', 1, 365) ?? 30)
    },
  },

  // --- sessions --------------------------------------------------------------
  {
    method: 'GET',
    path: '/api/v1/sessions',
    doc: {
      tag: 'Sessions',
      summary: 'Sessions nach Account gruppiert',
      description: 'Wie /resume in Claude Code, neueste zuerst.',
      queryParams: [{ name: 'accountId', description: 'Nur diesen Account', schema: { type: 'string' } }],
      response: { description: 'Gruppen', schema: { type: 'array', items: ref('SessionGroup') } },
    },
    handler: (ctx) => {
      const accountId = ctx.query.get('accountId') || undefined
      if (accountId) requireAccount(ctx, accountId)
      return ctx.app.sessions.list(accountId)
    },
  },
  {
    method: 'GET',
    path: '/api/v1/sessions/{accountId}/{sessionId}',
    doc: {
      tag: 'Sessions',
      summary: 'Verlauf einer Session',
      description: 'Nachrichten als Markdown; bei sehr langen Sessions nur der neueste Teil.',
      pathParams: [accountIdParam, { name: 'sessionId', description: 'Session-ID (UUID)' }],
      response: { description: 'Session', schema: ref('SessionDetail') },
    },
    handler: async (ctx) => {
      requireAccount(ctx, ctx.params.accountId)
      if (!SESSION_ID_RE.test(ctx.params.sessionId)) throw new HttpError(400, 'Ungültige Session-ID.')
      try {
        return await ctx.app.sessions.get(ctx.params.accountId, ctx.params.sessionId)
      } catch (error) {
        throw new HttpError(404, error instanceof Error ? error.message : 'Session nicht gefunden.')
      }
    },
  },

  // --- terminals -------------------------------------------------------------
  {
    method: 'GET',
    path: '/api/v1/terminals',
    doc: {
      tag: 'Terminals',
      summary: 'Offene Terminals',
      response: { description: 'Terminals', schema: { type: 'array', items: ref('Terminal') } },
    },
    handler: ({ app }) => app.terminals.list(),
  },
  {
    method: 'POST',
    path: '/api/v1/terminals',
    doc: {
      tag: 'Terminals',
      summary: 'Terminal öffnen',
      description:
        'Startet Claude Code (oder `claude auth login` / eine Shell) mit dem Account als neuen Tab in der App.',
      requestBody: {
        required: true,
        schema: ref('TerminalCreate'),
        example: { accountId: 'system', cwd: 'C:\\Projekte\\demo', activate: true },
      },
      response: { description: 'Gestartetes Terminal', schema: ref('Terminal') },
    },
    handler: async (ctx) => {
      const body = await ctx.body()
      const accountId = requiredString(body, 'accountId', 200)
      requireAccount(ctx, accountId)
      const mode = optionalString(body, 'mode', 20) ?? 'session'
      if (mode !== 'session' && mode !== 'login' && mode !== 'shell') {
        throw new HttpError(400, '„mode“ muss session, login oder shell sein.')
      }
      const resumeSessionId = optionalString(body, 'resumeSessionId', 64)
      if (resumeSessionId && !SESSION_ID_RE.test(resumeSessionId)) throw new HttpError(400, 'Ungültige Session-ID.')
      const authAccountId = optionalString(body, 'authAccountId', 200)
      if (authAccountId) requireAccount(ctx, authAccountId)
      const options: TerminalCreateOptions = {
        accountId,
        authAccountId: authAccountId ?? null,
        mode,
        cwd: optionalString(body, 'cwd') ?? null,
        resumeSessionId: resumeSessionId ?? null,
        forkSession: optionalBoolean(body, 'forkSession') ?? false,
        args: optionalStringArray(body, 'args'),
        title: optionalString(body, 'title', 120) ?? null,
        cols: optionalInteger(body, 'cols', 20, 500),
        rows: optionalInteger(body, 'rows', 5, 300),
      }
      let terminal
      try {
        terminal = ctx.app.terminals.create(options)
      } catch (error) {
        throw new HttpError(400, error instanceof Error ? error.message : String(error))
      }
      if (optionalBoolean(body, 'activate')) ctx.activateTerminal(terminal.id)
      return terminal
    },
  },
  {
    method: 'GET',
    path: '/api/v1/terminals/{id}',
    doc: {
      tag: 'Terminals',
      summary: 'Einzelnes Terminal',
      pathParams: [terminalIdParam],
      response: { description: 'Terminal', schema: ref('Terminal') },
    },
    handler: (ctx) => requireTerminal(ctx, ctx.params.id),
  },
  {
    method: 'PATCH',
    path: '/api/v1/terminals/{id}',
    doc: {
      tag: 'Terminals',
      summary: 'Tab umbenennen',
      pathParams: [terminalIdParam],
      requestBody: {
        required: true,
        schema: { type: 'object', properties: { title: { type: 'string', maxLength: 120 } }, required: ['title'] },
        example: { title: 'Refactoring' },
      },
      response: { description: 'Terminal', schema: ref('Terminal') },
    },
    handler: async (ctx) => {
      requireTerminal(ctx, ctx.params.id)
      ctx.app.terminals.rename(ctx.params.id, requiredString(await ctx.body(), 'title', 120))
      return ctx.app.terminals.get(ctx.params.id)
    },
  },
  {
    method: 'DELETE',
    path: '/api/v1/terminals/{id}',
    doc: {
      tag: 'Terminals',
      summary: 'Terminal schließen',
      description: 'Beendet den Prozess (falls er läuft) und entfernt den Tab.',
      pathParams: [terminalIdParam],
    },
    handler: (ctx) => {
      requireTerminal(ctx, ctx.params.id)
      ctx.app.terminals.close(ctx.params.id)
    },
  },
  {
    method: 'POST',
    path: '/api/v1/terminals/{id}/input',
    doc: {
      tag: 'Terminals',
      summary: 'Eingabe senden',
      description:
        'Schreibt Text in das Terminal, als wäre er getippt worden. `\\r` schickt eine Eingabe ab, `\\n` erzeugt in Claude Code einen Zeilenumbruch.',
      pathParams: [terminalIdParam],
      requestBody: {
        required: true,
        schema: { type: 'object', properties: { data: { type: 'string' } }, required: ['data'] },
        example: { data: 'Erkläre mir dieses Projekt\r' },
      },
    },
    handler: async (ctx) => {
      const terminal = requireTerminal(ctx, ctx.params.id)
      const data = requiredString(await ctx.body(), 'data', 256 * 1024)
      if (terminal.status !== 'running') throw new HttpError(409, 'Der Prozess ist bereits beendet.')
      ctx.app.terminals.write(ctx.params.id, data)
    },
  },
  {
    method: 'GET',
    path: '/api/v1/terminals/{id}/output',
    doc: {
      tag: 'Terminals',
      summary: 'Ausgabe lesen',
      description:
        'Rohausgabe mit ANSI-Sequenzen. Mit `since` (= `end` des letzten Abrufs) nur neue Ausgabe; die App hält bis zu 2 Mio. Zeichen pro Terminal.',
      pathParams: [terminalIdParam],
      queryParams: [
        { name: 'since', description: 'Stream-Offset, ab dem geliefert wird', schema: { type: 'integer', minimum: 0 } },
        { name: 'tail', description: 'Höchstens so viele letzte Zeichen', schema: { type: 'integer', minimum: 1 } },
      ],
      response: { description: 'Ausgabe', schema: ref('TerminalOutput') },
    },
    handler: (ctx) => {
      requireTerminal(ctx, ctx.params.id)
      const since = queryInteger(ctx.query, 'since', 0, Number.MAX_SAFE_INTEGER)
      const tail = queryInteger(ctx.query, 'tail', 1, 2_000_000)
      const { data, end } = ctx.app.terminals.buffer(ctx.params.id)
      const bufferStart = end - data.length
      let start = Math.max(bufferStart, Math.min(since ?? bufferStart, end))
      if (tail !== undefined) start = Math.max(start, end - tail)
      return {
        data: data.slice(start - bufferStart),
        start,
        end,
        truncated: since !== undefined && since < bufferStart,
      }
    },
  },
  {
    method: 'POST',
    path: '/api/v1/terminals/{id}/kill',
    doc: {
      tag: 'Terminals',
      summary: 'Prozess beenden',
      description: 'Der Tab bleibt mit Exit-Status offen.',
      pathParams: [terminalIdParam],
    },
    handler: (ctx) => {
      requireTerminal(ctx, ctx.params.id)
      ctx.app.terminals.kill(ctx.params.id)
    },
  },
  {
    method: 'POST',
    path: '/api/v1/terminals/{id}/activate',
    doc: {
      tag: 'Terminals',
      summary: 'Tab anzeigen',
      description: 'Wechselt in der App zu diesem Tab und holt das Fenster in den Vordergrund.',
      pathParams: [terminalIdParam],
    },
    handler: (ctx) => {
      requireTerminal(ctx, ctx.params.id)
      ctx.activateTerminal(ctx.params.id)
    },
  },

  // --- events ----------------------------------------------------------------
  {
    method: 'GET',
    path: '/api/v1/events',
    doc: {
      tag: 'Events',
      summary: 'Live-Ereignisse (Server-Sent Events)',
      description: [
        'Stream mit den Ereignissen `accounts`, `terminals`, `terminal-exit`, `usage`, `sessions` und optional `terminal-output`.',
        'Da EventSource keine Header setzen kann, darf der Token hier auch als Query-Parameter `access_token` übergeben werden.',
      ].join(' '),
      queryParams: [
        {
          name: 'output',
          description: 'Kommagetrennte Terminal-IDs, deren Ausgabe live gestreamt werden soll',
          schema: { type: 'string' },
        },
        { name: 'access_token', description: 'Alternative zum Authorization-Header', schema: { type: 'string' } },
      ],
      response: { description: 'Event-Stream', contentType: 'text/event-stream', schema: { type: 'string' } },
    },
    // handled by the server itself (streaming response)
  },
]

export interface MatchedRoute {
  route: Route
  params: Record<string, string>
}

const compiled = routes.map((route) => {
  const names: string[] = []
  // Paths only contain letters, digits, slashes and {params}, so no regex escaping is needed.
  const pattern = route.path.replace(/\{(\w+)\}/g, (_match, name: string) => {
    names.push(name)
    return '([^/]+)'
  })
  return { route, names, regex: new RegExp(`^${pattern}/?$`) }
})

/** Finds the route for a path; `allowed` lists the methods of a path that exists with another method. */
export function matchRoute(method: string, pathname: string): { match: MatchedRoute | null; allowed: HttpMethod[] } {
  const allowed: HttpMethod[] = []
  for (const { route, names, regex } of compiled) {
    const m = regex.exec(pathname)
    if (!m) continue
    if (route.method !== method) {
      allowed.push(route.method)
      continue
    }
    const params: Record<string, string> = {}
    names.forEach((name, i) => {
      try {
        params[name] = decodeURIComponent(m[i + 1])
      } catch {
        throw new HttpError(400, `Ungültiger Pfad-Parameter „${name}“.`)
      }
    })
    return { match: { route, params }, allowed }
  }
  return { match: null, allowed }
}
