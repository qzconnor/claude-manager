import { randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { join } from 'node:path'
import type { ApiStatus } from '@shared/types'
import type { AppContext } from '../context'
import { readJson, writeJsonAtomic } from '../lib/json-file'
import { decryptSecret, encryptSecret } from '../lib/secrets'
import { TypedEmitter } from '../lib/typed-emitter'
import { renderDocsPage } from './docs-page'
import { HttpError, readJsonBody, sendError, sendJson, sendNoContent, sendText } from './http'
import { buildOpenApi } from './openapi'
import { matchRoute } from './routes'

const HOST = '127.0.0.1'
const HEARTBEAT_MS = 25_000

interface StoredApiConfig {
  version: 1
  /** Bearer token, encrypted with safeStorage. */
  token: string
}

interface EventClient {
  res: ServerResponse
  /** Terminal ids whose output is streamed to this client. */
  output: Set<string>
  heartbeat: NodeJS.Timeout
}

type Events = {
  status: [status: ApiStatus]
}

export interface ApiServerOptions {
  version: string
  /** Shows a terminal tab in the app window. */
  activateTerminal(id: string): void
}

/**
 * Local HTTP API (127.0.0.1 only, bearer token). Started/stopped/re-bound whenever the
 * `api` settings change; the route table lives in routes.ts.
 */
export class ApiServer extends TypedEmitter<Events> {
  private server: Server | null = null
  private port = 0
  private token = ''
  private error: string | null = null
  private readonly clients = new Set<EventClient>()
  private queue: Promise<void> = Promise.resolve()
  private readonly configFile: string
  private readonly unsubscribers: (() => void)[] = []

  constructor(
    private readonly ctx: AppContext,
    private readonly options: ApiServerOptions,
  ) {
    super()
    this.configFile = join(ctx.userDataDir, 'api.json')
  }

  async init(): Promise<void> {
    await this.loadToken()
    const { settings, accounts, terminals, usage, sessions } = this.ctx
    this.unsubscribers.push(
      settings.on('changed', (next, previous) => {
        if (next.api.enabled !== previous.api.enabled || next.api.port !== previous.api.port) void this.sync()
      }),
      accounts.on('changed', (list) => this.broadcast('accounts', list)),
      terminals.on('changed', (list) => this.broadcast('terminals', list)),
      terminals.on('exit', (id, exitCode) => this.broadcast('terminal-exit', { id, exitCode })),
      terminals.on('data', (id, data, offset) => {
        for (const client of this.clients) {
          if (client.output.has(id)) this.send(client, 'terminal-output', { id, data, offset })
        }
      }),
      usage.on('changed', (list) => this.broadcast('usage', list)),
      sessions.on('changed', (accountId) => this.broadcast('sessions', { accountId })),
    )
    await this.sync()
  }

  status(): ApiStatus {
    const { enabled, port } = this.ctx.settings.get().api
    const running = this.server !== null
    return {
      enabled,
      running,
      port: running ? this.port : port,
      url: running ? `http://${HOST}:${this.port}` : null,
      token: this.token,
      error: this.error,
    }
  }

  async regenerateToken(): Promise<ApiStatus> {
    this.token = generateToken()
    await this.saveToken()
    // Event streams were authorized with the old token.
    this.closeClients()
    this.emitStatus()
    return this.status()
  }

  dispose(): void {
    for (const off of this.unsubscribers.splice(0)) off()
    void this.stop()
  }

  /** Applies the current settings; calls are serialized so quick toggles can't race. */
  private sync(): Promise<void> {
    this.queue = this.queue
      .then(async () => {
        const { enabled, port } = this.ctx.settings.get().api
        if (this.server && (!enabled || port !== this.port)) await this.stop()
        if (!enabled) this.error = null
        if (enabled && !this.server) await this.start(port)
        this.emitStatus()
      })
      .catch((error) => console.error('[api] sync failed', error))
    return this.queue
  }

  private start(port: number): Promise<void> {
    return new Promise((resolve) => {
      const server = createServer((req, res) => void this.handle(req, res))
      const onError = (error: NodeJS.ErrnoException) => {
        this.error =
          error.code === 'EADDRINUSE'
            ? `Port ${port} ist bereits belegt. Wähle einen anderen Port.`
            : `Server konnte nicht starten: ${error.message}`
        resolve()
      }
      server.once('error', onError)
      server.listen(port, HOST, () => {
        server.off('error', onError)
        server.on('error', (error) => console.error('[api] server error', error))
        this.server = server
        this.port = port
        this.error = null
        resolve()
      })
    })
  }

  private stop(): Promise<void> {
    const server = this.server
    if (!server) return Promise.resolve()
    this.server = null
    this.closeClients()
    return new Promise((resolve) => {
      server.close(() => resolve())
      server.closeAllConnections()
    })
  }

  private emitStatus(): void {
    this.emit('status', this.status())
  }

  // --- token -------------------------------------------------------------------

  private async loadToken(): Promise<void> {
    const stored = await readJson<StoredApiConfig>(this.configFile)
    const decrypted = stored?.token ? await decryptSecret(stored.token) : null
    if (decrypted) {
      this.token = decrypted.plain
      if (decrypted.reEncrypted) {
        await writeJsonAtomic(this.configFile, { version: 1, token: decrypted.reEncrypted } satisfies StoredApiConfig).catch(
          () => undefined,
        )
      }
      return
    }
    this.token = generateToken()
    await this.saveToken()
  }

  private async saveToken(): Promise<void> {
    try {
      await writeJsonAtomic(this.configFile, { version: 1, token: await encryptSecret(this.token) } satisfies StoredApiConfig)
    } catch (error) {
      // Without OS encryption the token only lives for this app session.
      console.warn('[api] token could not be stored', error)
    }
  }

  private authorized(req: IncomingMessage, url: URL, allowQueryToken: boolean): boolean {
    const header = req.headers.authorization ?? ''
    const match = /^Bearer\s+(\S+)\s*$/i.exec(header)
    const candidate = match?.[1] ?? (allowQueryToken ? url.searchParams.get('access_token') : null)
    if (!candidate || !this.token) return false
    const a = Buffer.from(candidate)
    const b = Buffer.from(this.token)
    return a.length === b.length && timingSafeEqual(a, b)
  }

  // --- requests ----------------------------------------------------------------

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      // DNS-rebinding protection: only accept requests addressed to the loopback host.
      const host = (req.headers.host ?? '').toLowerCase()
      if (host !== `${HOST}:${this.port}` && host !== `localhost:${this.port}`) {
        throw new HttpError(403, 'Ungültiger Host-Header.')
      }
      const method = req.method ?? 'GET'
      const url = new URL(req.url ?? '/', `http://${HOST}:${this.port}`)
      const pathname = url.pathname.replace(/\/+$/, '') || '/'

      if (method === 'GET' && (pathname === '/' || pathname === '/docs')) {
        res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'")
        sendText(res, 200, 'text/html', renderDocsPage(`http://${HOST}:${this.port}`, this.options.version))
        return
      }
      if (method === 'GET' && pathname === '/openapi.json') {
        sendJson(res, 200, buildOpenApi(`http://${HOST}:${this.port}`, this.options.version))
        return
      }

      const { match, allowed } = matchRoute(method, pathname)
      if (!match) {
        if (allowed.length) {
          res.setHeader('Allow', allowed.join(', '))
          throw new HttpError(405, `Methode ${method} ist hier nicht erlaubt.`)
        }
        throw new HttpError(404, `Unbekannter Endpunkt ${pathname}.`)
      }

      const isEvents = match.route.path === '/api/v1/events'
      if (!match.route.doc.public && !this.authorized(req, url, isEvents)) {
        res.setHeader('WWW-Authenticate', 'Bearer')
        throw new HttpError(401, 'Token fehlt oder ist ungültig.')
      }
      if (isEvents) {
        this.openEventStream(req, res, url)
        return
      }

      let body: Promise<Record<string, unknown>> | null = null
      const result = await match.route.handler!({
        app: this.ctx,
        params: match.params,
        query: url.searchParams,
        body: () => (body ??= readJsonBody(req)),
        activateTerminal: (id) => this.options.activateTerminal(id),
      })
      if (result === undefined) sendNoContent(res)
      else sendJson(res, 200, result)
    } catch (error) {
      if (res.headersSent) {
        res.end()
        return
      }
      if (error instanceof HttpError) {
        sendError(res, error.status, error.message)
      } else {
        console.error('[api] request failed', error)
        sendError(res, 500, error instanceof Error ? error.message : 'Interner Fehler.')
      }
    }
  }

  // --- server-sent events ------------------------------------------------------

  private openEventStream(req: IncomingMessage, res: ServerResponse, url: URL): void {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      'X-Content-Type-Options': 'nosniff',
    })
    const output = new Set(
      (url.searchParams.get('output') ?? '')
        .split(',')
        .map((id) => id.trim())
        .filter(Boolean),
    )
    const client: EventClient = {
      res,
      output,
      heartbeat: setInterval(() => res.write(': ping\n\n'), HEARTBEAT_MS),
    }
    this.clients.add(client)
    req.on('close', () => this.dropClient(client))
    res.write('retry: 3000\n\n')
    this.send(client, 'terminals', this.ctx.terminals.list())
  }

  private send(client: EventClient, event: string, data: unknown): void {
    if (client.res.writableEnded) return
    client.res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
  }

  private broadcast(event: string, data: unknown): void {
    for (const client of this.clients) this.send(client, event, data)
  }

  private dropClient(client: EventClient): void {
    clearInterval(client.heartbeat)
    this.clients.delete(client)
  }

  private closeClients(): void {
    for (const client of [...this.clients]) {
      this.dropClient(client)
      client.res.end()
    }
  }
}

function generateToken(): string {
  return randomBytes(32).toString('base64url')
}
