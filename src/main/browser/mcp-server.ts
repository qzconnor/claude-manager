import { mkdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { join } from 'node:path'
import type { ClaudeSettings } from '@shared/types'
import { BodyTooLarge, readBody, sendJson, sendPlain, type SessionServer } from '../services/session-server'
import type { SettingsService } from '../services/settings-service'
import type { SessionArgsProvider } from '../services/terminal-service'
import { allowedAppToolNames, appInstructions, appToolGroup, enabledAppGroups, type AppTools } from './app-tools'
import type { BrowserTools } from './browser-tools'
import { BROWSER_INSTRUCTIONS } from './browser-tools'
import { handleRpc, isRequest, PARSE_ERROR, rpcError, type McpServerSpec } from './mcp-protocol'

/** The name Claude Code knows the server by; its tools are `mcp__claude-manager__browser_…`, `mcp__claude-manager__limits` … */
export const MCP_SERVER_NAME = 'claude-manager'
const PATH = '/mcp'
const MAX_BODY_BYTES = 1024 * 1024
/** Keeps a long tool call's stream open (Claude Code's HTTP client gives up after 5 min of silence). */
const KEEPALIVE_MS = 20_000

/**
 * The options that give a session the server (`=` form: Claude Code's options that take several
 * values would otherwise take the prompt after them as one more). `allowedTools`: the server's tools
 * Claude Code uses without asking. `noChrome`: without Claude in Chrome, which Claude might otherwise
 * take instead of the app's browser.
 */
export function mcpLaunchArgs(configFile: string, allowedTools: string[], noChrome = false): string[] {
  return [
    `--mcp-config=${configFile}`,
    ...(allowedTools.length ? [`--allowedTools=${allowedTools.map((name) => `mcp__${MCP_SERVER_NAME}__${name}`).join(',')}`] : []),
    ...(noChrome ? ['--no-chrome'] : []),
  ]
}

/**
 * The tools a session may use without asking: the browser's when the settings allow it, the app's
 * reading tools whenever they are on, its shell tools only when allowed too; the theme tools that
 * change something always ask.
 */
export function allowedToolNames(claude: ClaudeSettings, browserToolNames: string[], appTools: boolean): string[] {
  return [
    ...(claude.browserTools && claude.browserToolsAllowed ? browserToolNames : []),
    ...(appTools ? allowedAppToolNames(claude) : []),
  ]
}

/** The `--mcp-config` file of one session. */
export function mcpConfig(url: string, token: string): unknown {
  return { mcpServers: { [MCP_SERVER_NAME]: { type: 'http', url, headers: { Authorization: `Bearer ${token}` } } } }
}

/**
 * The app's MCP server for the browser and the app's own tools (Streamable HTTP, route `/mcp` of the
 * SessionServer). Only sessions the app starts know of it: each gets a config file with a token of its
 * own, which says which session calls, and so which browser and shells it drives. Nothing is
 * registered with Claude Code itself.
 */
export class BrowserMcpServer implements SessionArgsProvider {
  /** Token and config file by session terminal. */
  private readonly grants = new Map<string, { token: string; file: string }>()
  private readonly dir: string
  /** The tools for the app itself; they need services that start after the server. */
  private appTools: AppTools | null = null

  constructor(
    private readonly server: SessionServer,
    userDataDir: string,
    private readonly settings: SettingsService,
    private readonly tools: BrowserTools,
    private readonly version: string,
  ) {
    this.dir = join(userDataDir, 'browser-mcp')
  }

  init(): void {
    // Files of the last run: their tokens are gone with it.
    rmSync(this.dir, { recursive: true, force: true })
    mkdirSync(this.dir, { recursive: true })
    this.server.route(PATH, (req, res, terminalId) => this.handle(req, res, terminalId))
  }

  setAppTools(tools: AppTools): void {
    this.appTools = tools
  }

  /** The options for a new session, given the settings; nothing when all of the server's tools are off. */
  args(terminalId: string): string[] {
    const claude = this.settings.get().claude
    const appGroups = this.appTools ? enabledAppGroups(claude) : new Set()
    if ((!claude.browserTools && appGroups.size === 0) || !this.server.running) return []
    this.release(terminalId)
    const token = this.server.grant(PATH, terminalId)
    const file = join(this.dir, `${terminalId}.json`)
    try {
      writeFileSync(file, JSON.stringify(mcpConfig(this.server.url(PATH), token)), { mode: 0o600 })
    } catch (error) {
      console.error('[browser-mcp] config could not be written', error)
      this.server.revoke(token)
      return []
    }
    this.grants.set(terminalId, { token, file })
    const allowed = allowedToolNames(
      claude,
      this.tools.list().map((tool) => tool.name),
      this.appTools !== null,
    )
    return mcpLaunchArgs(file, allowed, claude.browserTools && claude.noClaudeInChrome)
  }

  /** The session ended: its token stops working. */
  release(terminalId: string): void {
    const grant = this.grants.get(terminalId)
    if (!grant) return
    this.grants.delete(terminalId)
    this.server.revoke(grant.token)
    try {
      unlinkSync(grant.file)
    } catch {
      // already gone
    }
  }

  dispose(): void {
    for (const id of [...this.grants.keys()]) this.release(id)
  }

  private async handle(req: IncomingMessage, res: ServerResponse, sessionId: string): Promise<void> {
    if (req.method !== 'POST') {
      // No stream of its own for the server's messages: it sends none.
      res.writeHead(405, { Allow: 'POST' })
      res.end()
      return
    }

    let message: unknown
    try {
      message = JSON.parse(await readBody(req, MAX_BODY_BYTES))
    } catch (error) {
      if (error instanceof BodyTooLarge) return sendPlain(res, 413, 'Payload too large')
      return sendJson(res, 400, rpcError(null, PARSE_ERROR, 'Parse error'))
    }

    // What the session gets follows the settings of the moment; a tool switched off says so when called.
    const claude = this.settings.get().claude
    const appTools = this.appTools
    const appGroups = appTools ? enabledAppGroups(claude) : new Set<never>()
    const browserTools = this.tools.list()
    const instructions = [claude.browserTools ? BROWSER_INSTRUCTIONS : null, appGroups.size ? appInstructions(appGroups) : null].filter(Boolean)
    const spec: McpServerSpec = {
      name: MCP_SERVER_NAME,
      version: this.version,
      instructions: instructions.length ? instructions.join('\n\n') : undefined,
      tools: [...(claude.browserTools ? browserTools : []), ...(appTools ? appTools.list(appGroups) : [])],
      knowsTool: (name) => browserTools.some((tool) => tool.name === name) || (appTools !== null && appToolGroup(name) !== null),
      callTool: (name, args) => {
        if (appTools && appToolGroup(name) !== null) return appTools.call(sessionId, name, args)
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
      return sendJson(res, 200, answer)
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
}

function isToolCall(message: unknown): boolean {
  return isRequest(message) && (message as { method: string }).method === 'tools/call'
}
