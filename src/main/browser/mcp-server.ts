import { randomBytes } from 'node:crypto'
import { mkdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { join } from 'node:path'
import type { SettingsService } from '../services/settings-service'
import type { SessionArgsProvider } from '../services/terminal-service'
import type { BrowserTools } from './browser-tools'
import { BROWSER_INSTRUCTIONS } from './browser-tools'
import { handleRpc, isRequest, PARSE_ERROR, rpcError, type McpServerSpec } from './mcp-protocol'

/** The name Claude Code knows the server by; its tools are `mcp__claude-manager__browser_…`. */
export const MCP_SERVER_NAME = 'claude-manager'
const HOST = '127.0.0.1'
const PATH = '/mcp'
const MAX_BODY_BYTES = 1024 * 1024
/** Keeps a long tool call's stream open (Claude Code's HTTP client gives up after 5 min of silence). */
const KEEPALIVE_MS = 20_000

/**
 * The options that give a session the server (`=` form: Claude Code's options that take several
 * values would otherwise take the prompt after them as one more). `noChrome`: without Claude in
 * Chrome, which Claude might otherwise take instead of the app's browser.
 */
export function mcpLaunchArgs(configFile: string, allowTools: boolean, noChrome = false): string[] {
  return [
    `--mcp-config=${configFile}`,
    ...(allowTools ? [`--allowedTools=mcp__${MCP_SERVER_NAME}`] : []),
    ...(noChrome ? ['--no-chrome'] : []),
  ]
}

/** The `--mcp-config` file of one session. */
export function mcpConfig(url: string, token: string): unknown {
  return { mcpServers: { [MCP_SERVER_NAME]: { type: 'http', url, headers: { Authorization: `Bearer ${token}` } } } }
}

/**
 * The app's MCP server for the browser (Streamable HTTP on 127.0.0.1). Only sessions the app starts
 * know of it: each gets a config file with a token of its own, which says which session calls, and
 * so which browser it drives. Nothing is registered with Claude Code itself.
 */
export class BrowserMcpServer implements SessionArgsProvider {
  private server: Server | null = null
  private port = 0
  /** Session terminal by token. */
  private readonly sessions = new Map<string, string>()
  /** Token and config file by session terminal. */
  private readonly grants = new Map<string, { token: string; file: string }>()
  private readonly dir: string

  constructor(
    userDataDir: string,
    private readonly settings: SettingsService,
    private readonly tools: BrowserTools,
    private readonly version: string,
  ) {
    this.dir = join(userDataDir, 'browser-mcp')
  }

  async start(): Promise<void> {
    // Files of the last run: their tokens are gone with it.
    rmSync(this.dir, { recursive: true, force: true })
    mkdirSync(this.dir, { recursive: true })
    const server = createServer((req, res) => void this.handle(req, res).catch((error) => this.fail(res, error)))
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, HOST, () => {
        server.off('error', reject)
        resolve()
      })
    })
    server.on('error', (error) => console.error('[browser-mcp] server error', error))
    const address = server.address()
    this.port = typeof address === 'object' && address ? address.port : 0
    this.server = server
  }

  /** The options for a new session, given the settings; nothing when the browser is off for sessions. */
  args(terminalId: string): string[] {
    const { browserTools, browserToolsAllowed, noClaudeInChrome } = this.settings.get().claude
    if (!browserTools || !this.server) return []
    this.release(terminalId)
    const token = randomBytes(32).toString('base64url')
    const file = join(this.dir, `${terminalId}.json`)
    try {
      writeFileSync(file, JSON.stringify(mcpConfig(`http://${HOST}:${this.port}${PATH}`, token)), { mode: 0o600 })
    } catch (error) {
      console.error('[browser-mcp] config could not be written', error)
      return []
    }
    this.sessions.set(token, terminalId)
    this.grants.set(terminalId, { token, file })
    return mcpLaunchArgs(file, browserToolsAllowed, noClaudeInChrome)
  }

  /** The session ended: its token stops working. */
  release(terminalId: string): void {
    const grant = this.grants.get(terminalId)
    if (!grant) return
    this.grants.delete(terminalId)
    this.sessions.delete(grant.token)
    try {
      unlinkSync(grant.file)
    } catch {
      // already gone
    }
  }

  dispose(): void {
    for (const id of [...this.grants.keys()]) this.release(id)
    this.server?.close()
    this.server?.closeAllConnections()
    this.server = null
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // Only Claude Code on this machine: no pages (they send an Origin), no other host names (DNS rebinding).
    const host = req.headers.host ?? ''
    if ((host !== `${HOST}:${this.port}` && host !== `localhost:${this.port}`) || req.headers.origin !== undefined) {
      return this.plain(res, 403, 'Forbidden')
    }
    const url = new URL(req.url ?? '/', `http://${host}`)
    if (url.pathname !== PATH) return this.plain(res, 404, 'Not found')
    const sessionId = this.session(req)
    if (!sessionId) return this.plain(res, 401, 'Unauthorized')
    if (req.method !== 'POST') {
      // No stream of its own for the server's messages: it sends none.
      res.writeHead(405, { Allow: 'POST' })
      res.end()
      return
    }

    let message: unknown
    try {
      message = JSON.parse(await readBody(req))
    } catch (error) {
      if (error instanceof BodyTooLarge) return this.plain(res, 413, 'Payload too large')
      return this.json(res, 400, rpcError(null, PARSE_ERROR, 'Parse error'))
    }

    const spec: McpServerSpec = {
      name: MCP_SERVER_NAME,
      version: this.version,
      instructions: BROWSER_INSTRUCTIONS,
      tools: this.tools.list(),
      callTool: (name, args) => {
        if (!this.settings.get().claude.browserTools) {
          throw new Error('The user turned the browser off for Claude sessions in the settings of Claude Manager.')
        }
        return this.tools.call(sessionId, name, args)
      },
    }

    // A tool call can take long (e.g. while the user has the browser): its answer comes as a stream,
    // kept open with comments.
    const streaming = isToolCall(message) && (req.headers.accept ?? '').includes('text/event-stream')
    if (!streaming) {
      const answer = await handleRpc(spec, message)
      if (answer === null) {
        res.writeHead(202)
        res.end()
        return
      }
      return this.json(res, 200, answer)
    }

    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' })
    res.flushHeaders()
    const keepalive = setInterval(() => res.write(': keepalive\n\n'), KEEPALIVE_MS)
    try {
      const answer = await handleRpc(spec, message)
      if (!res.writableEnded && !res.destroyed) res.write(`event: message\ndata: ${JSON.stringify(answer)}\n\n`)
    } finally {
      clearInterval(keepalive)
      res.end()
    }
  }

  private session(req: IncomingMessage): string | null {
    const match = /^Bearer\s+(\S+)\s*$/i.exec(req.headers.authorization ?? '')
    return (match && this.sessions.get(match[1])) ?? null
  }

  private json(res: ServerResponse, status: number, body: unknown): void {
    const payload = JSON.stringify(body)
    res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), 'Cache-Control': 'no-store' })
    res.end(payload)
  }

  private plain(res: ServerResponse, status: number, text: string): void {
    res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' })
    res.end(text)
  }

  private fail(res: ServerResponse, error: unknown): void {
    console.error('[browser-mcp] request failed', error)
    if (!res.headersSent) this.plain(res, 500, 'Internal error')
    else res.end()
  }
}

function isToolCall(message: unknown): boolean {
  return isRequest(message) && (message as { method: string }).method === 'tools/call'
}

class BodyTooLarge extends Error {}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buf = chunk as Buffer
    size += buf.length
    if (size > MAX_BODY_BYTES) throw new BodyTooLarge()
    chunks.push(buf)
  }
  return Buffer.concat(chunks).toString('utf8')
}
