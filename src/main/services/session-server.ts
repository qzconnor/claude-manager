import { randomBytes } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'

const HOST = '127.0.0.1'

/** Answers one request of a session; `terminalId` is the session whose token came with it. */
export type SessionRoute = (req: IncomingMessage, res: ServerResponse, terminalId: string) => Promise<void>

/**
 * The app's HTTP server for the sessions it starts (127.0.0.1, a free port): the browser's MCP server
 * (`/mcp`) and Claude Code's hooks (`/hooks`). Each session gets a token per route, which says which
 * session calls. Only Claude Code on this machine gets through: no pages (they send an Origin), no
 * other host names (DNS rebinding), no request without a token of the route.
 */
export class SessionServer {
  private server: Server | null = null
  private port = 0
  private readonly routes = new Map<string, SessionRoute>()
  /** Route and session terminal by token. */
  private readonly tokens = new Map<string, { path: string; terminalId: string }>()

  async start(): Promise<void> {
    const server = createServer((req, res) => void this.handle(req, res).catch((error) => fail(res, error)))
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, HOST, () => {
        server.off('error', reject)
        resolve()
      })
    })
    server.on('error', (error) => console.error('[session-server] server error', error))
    const address = server.address()
    this.port = typeof address === 'object' && address ? address.port : 0
    this.server = server
  }

  /** Whether sessions can reach the server; it may have failed to start. */
  get running(): boolean {
    return this.server !== null
  }

  /** The address of a route, for a session's config. */
  url(path: string): string {
    return `http://${HOST}:${this.port}${path}`
  }

  route(path: string, handler: SessionRoute): void {
    this.routes.set(path, handler)
  }

  /** A new token with which the session reaches the route. */
  grant(path: string, terminalId: string): string {
    const token = randomBytes(32).toString('base64url')
    this.tokens.set(token, { path, terminalId })
    return token
  }

  /** The token stops working (its session ended). */
  revoke(token: string): void {
    this.tokens.delete(token)
  }

  dispose(): void {
    this.tokens.clear()
    this.server?.close()
    this.server?.closeAllConnections()
    this.server = null
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const host = req.headers.host ?? ''
    if ((host !== `${HOST}:${this.port}` && host !== `localhost:${this.port}`) || req.headers.origin !== undefined) {
      return sendPlain(res, 403, 'Forbidden')
    }
    const path = new URL(req.url ?? '/', `http://${host}`).pathname
    const handler = this.routes.get(path)
    if (!handler) return sendPlain(res, 404, 'Not found')
    const match = /^Bearer\s+(\S+)\s*$/i.exec(req.headers.authorization ?? '')
    const grant = match ? this.tokens.get(match[1]) : undefined
    if (!grant || grant.path !== path) return sendPlain(res, 401, 'Unauthorized')
    await handler(req, res, grant.terminalId)
  }
}

export class BodyTooLarge extends Error {}

/** The request's body as text; more than `maxBytes` throws BodyTooLarge. */
export async function readBody(req: IncomingMessage, maxBytes: number): Promise<string> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buf = chunk as Buffer
    size += buf.length
    if (size > maxBytes) throw new BodyTooLarge()
    chunks.push(buf)
  }
  return Buffer.concat(chunks).toString('utf8')
}

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), 'Cache-Control': 'no-store' })
  res.end(payload)
}

export function sendPlain(res: ServerResponse, status: number, text: string): void {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' })
  res.end(text)
}

function fail(res: ServerResponse, error: unknown): void {
  console.error('[session-server] request failed', error)
  if (!res.headersSent) sendPlain(res, 500, 'Internal error')
  else res.end()
}
