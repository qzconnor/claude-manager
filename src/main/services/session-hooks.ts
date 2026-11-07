import { mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { join } from 'node:path'
import { hookSettings, mergeHookSettings, parseHookCall, readUserSettings, userSettingsValue, type HookCall } from '../lib/hook-events'
import type { SessionServer } from './session-server'
import type { SettingsService } from './settings-service'
import type { SessionArgsProvider } from './terminal-service'

const PATH = '/hooks'
/**
 * Bodies up to this size are read. PreToolUse of `Write` brings the whole file along; a larger body is
 * still taken in and answered, only the event is lost.
 */
const MAX_BODY_BYTES = 16 * 1024 * 1024

/**
 * Claude Code's hooks for the sessions the app starts (setting `claude.hookState`): each session gets
 * a settings file (`--settings`) whose hooks send every event the app needs to route `/hooks` of the
 * SessionServer, with a token of its own. Claude Code runs them besides the user's own hooks; nothing
 * is written to the user's settings. A `--settings` of the user's own is merged into the file, since
 * Claude Code takes only the last one.
 */
export class SessionHooks implements SessionArgsProvider {
  /** Token and settings file by session terminal. */
  private readonly grants = new Map<string, { token: string; file: string }>()
  private readonly dir: string

  constructor(
    private readonly server: SessionServer,
    userDataDir: string,
    private readonly settings: SettingsService,
    private readonly receive: (terminalId: string, call: HookCall) => void,
  ) {
    this.dir = join(userDataDir, 'session-hooks')
  }

  init(): void {
    // Files of the last run: their tokens are gone with it.
    rmSync(this.dir, { recursive: true, force: true })
    mkdirSync(this.dir, { recursive: true })
    this.server.route(PATH, (req, res, terminalId) => this.handle(req, res, terminalId))
  }

  args(): string[] {
    return []
  }

  /** After the user's own options: of two `--settings`, Claude Code takes the last. */
  lastArgs(terminalId: string, extra: readonly string[], cwd: string): string[] {
    if (!this.settings.get().claude.hookState || !this.server.running) return []
    const own = userSettingsValue(extra)
    if (own === 'invalid') return []
    this.release(terminalId)
    const token = this.server.grant(PATH, terminalId)
    let settings: Record<string, unknown> = hookSettings(this.server.url(PATH), token)
    if (own !== null) {
      const user = readUserSettings(own, cwd, (path) => readFileSync(path, 'utf8'))
      // Settings of the user's that can't be read stay theirs; the app goes without hooks then.
      if (!user) {
        this.server.revoke(token)
        return []
      }
      settings = mergeHookSettings(user, settings as ReturnType<typeof hookSettings>)
    }
    const file = join(this.dir, `${terminalId}.json`)
    try {
      writeFileSync(file, JSON.stringify(settings), { mode: 0o600 })
    } catch (error) {
      console.error('[session-hooks] settings could not be written', error)
      this.server.revoke(token)
      return []
    }
    this.grants.set(terminalId, { token, file })
    return [`--settings=${file}`]
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

  private async handle(req: IncomingMessage, res: ServerResponse, terminalId: string): Promise<void> {
    if (req.method !== 'POST') {
      res.writeHead(405, { Allow: 'POST' })
      res.end()
      return
    }
    const body = await readJsonBody(req)
    // Answered first: Claude Code waits for it (PreToolUse before every tool). An empty answer
    // decides nothing and adds nothing to Claude's context.
    res.writeHead(204, { 'Cache-Control': 'no-store' })
    res.end()
    const call = parseHookCall(body)
    if (call) this.receive(terminalId, call)
  }
}

/** The body as JSON; null when it isn't, or is too large (read to the end all the same). */
async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buf = chunk as Buffer
    size += buf.length
    if (size <= MAX_BODY_BYTES) chunks.push(buf)
  }
  if (size > MAX_BODY_BYTES) return null
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    return null
  }
}
