import { randomUUID } from 'node:crypto'
import { existsSync, statSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import * as pty from 'node-pty'
import type { CloseOnExit, SessionLimit, TerminalCreateOptions, TerminalInfo } from '@shared/types'
import { findTranscript, readLiveSessionId, readSessionLimit, SESSION_ID_RE } from '../lib/session-files'
import { TypedEmitter } from '../lib/typed-emitter'
import type { AccountService } from './account-service'
import type { ClaudeCli } from './claude-cli'
import type { SettingsService } from './settings-service'

/** Output kept per terminal so a view (or API client) can re-attach and replay it. */
const MAX_BUFFER_CHARS = 2_000_000
/** Output is coalesced for this long before it is forwarded — keeps IPC traffic low. */
const FLUSH_INTERVAL_MS = 6
/** How often running sessions are checked for their current session id and a usage limit. */
const TRACK_INTERVAL_MS = 2000
/** Arguments with which Claude Code picks the session itself. */
const SESSION_CHOICE_ARG_RE = /^(-c|--continue|-r|--resume|--session-id|--from-pr|--teleport)(=|$)/

interface TrackedTranscript {
  sessionId: string
  file: string
  size: number
  mtimeMs: number
  limit: SessionLimit | null
}

interface TerminalRecord {
  info: TerminalInfo
  process: pty.IPty | null
  /** Resolves when the process has exited. */
  exited: Promise<void>
  transcript: TrackedTranscript | null
  chunks: string[]
  size: number
  /** Total number of characters emitted so far (never decreases, also counts trimmed output). */
  emitted: number
  pending: string
  flushTimer: NodeJS.Timeout | null
  /** The app ended the process (kill, close, account switch): its tab never closes by itself. */
  killed: boolean
}

type Events = {
  changed: [terminals: TerminalInfo[]]
  /** `offset` = position of `data` in the terminal's output stream */
  data: [id: string, data: string, offset: number]
  exit: [id: string, exitCode: number]
}

export class TerminalService extends TypedEmitter<Events> {
  private readonly terminals = new Map<string, TerminalRecord>()
  private readonly trackTimer: NodeJS.Timeout
  private tracking = false

  constructor(
    private readonly accounts: AccountService,
    private readonly cli: ClaudeCli,
    private readonly settings: SettingsService,
  ) {
    super()
    this.trackTimer = setInterval(() => void this.track(), TRACK_INTERVAL_MS)
  }

  list(): TerminalInfo[] {
    return [...this.terminals.values()].map((t) => ({ ...t.info }))
  }

  get(id: string): TerminalInfo {
    return { ...this.require(id).info }
  }

  /** Running terminals that use the account, for its files or its credentials. */
  runningCount(accountId?: string): number {
    return [...this.terminals.values()].filter(
      (t) =>
        t.info.status === 'running' &&
        (!accountId || t.info.accountId === accountId || t.info.authAccountId === accountId),
    ).length
  }

  create(options: TerminalCreateOptions): TerminalInfo {
    const account = this.accounts.get(options.accountId)
    const auth = options.authAccountId ? this.accounts.get(options.authAccountId) : account
    const settings = this.settings.get()
    const mode = options.mode ?? 'session'

    const cwd = this.resolveCwd(options.cwd ?? account.defaultCwd ?? settings.claude.defaultCwd)

    const args: string[] = []
    let sessionId: string | null = null
    if (mode === 'login') {
      args.push('auth', 'login')
      // Imported accounts know who should log in: the login page starts with that email.
      const email = account.expectedLogin?.email
      if (email && this.cli.loginTakesEmail()) args.push('--email', email)
    } else {
      const extra = [...settings.claude.defaultArgs, ...auth.extraArgs, ...(options.args ?? [])]
      if (options.resumeSessionId) {
        if (!SESSION_ID_RE.test(options.resumeSessionId)) throw new Error('Ungültige Session-ID.')
        args.push('--resume', options.resumeSessionId)
        if (options.forkSession) args.push('--fork-session')
        else sessionId = options.resumeSessionId
      } else if (mode === 'session' && !extra.some((arg) => SESSION_CHOICE_ARG_RE.test(arg))) {
        // Name the session up front so the tab knows it before Claude Code reports it.
        sessionId = randomUUID()
        args.push('--session-id', sessionId)
      }
      // Before the extra args: an option there that takes several values would swallow it.
      const prompt = options.prompt?.trim()
      if (prompt && mode === 'session') args.push(prompt)
      args.push(...extra)
    }

    const env = this.cli.baseEnv()
    const accountEnv = this.accounts.launchEnv(account.id, auth.id)
    for (const key of accountEnv.unset) deleteEnv(env, key)
    for (const [key, value] of Object.entries(accountEnv.set)) {
      deleteEnv(env, key)
      env[key] = value
    }

    const command = mode === 'shell' ? shellCommand() : this.cli.command(args)
    const cols = clampSize(options.cols, 120)
    const rows = clampSize(options.rows, 32)
    const proc = pty.spawn(command.file, command.args, {
      name: 'xterm-256color',
      cols,
      rows,
      cwd,
      env,
      useConpty: true,
    })

    const id = randomUUID()
    const info: TerminalInfo = {
      id,
      accountId: account.id,
      authAccountId: auth.id,
      sessionId,
      limit: null,
      title: options.title?.trim() || defaultTerminalTitle(mode, auth.name, cwd),
      cwd,
      mode,
      resumeSessionId: options.resumeSessionId ?? null,
      status: 'running',
      exitCode: null,
      pid: proc.pid,
      createdAt: new Date().toISOString(),
      commandLine: command.display,
    }
    let markExited!: () => void
    const record: TerminalRecord = {
      info,
      process: proc,
      exited: new Promise((resolve) => (markExited = resolve)),
      transcript: null,
      chunks: [],
      size: 0,
      emitted: 0,
      pending: '',
      flushTimer: null,
      killed: false,
    }
    this.terminals.set(id, record)

    proc.onData((data) => this.handleData(record, data))
    proc.onExit(({ exitCode }) => {
      this.flush(record)
      record.process = null
      record.info.status = 'exited'
      record.info.exitCode = exitCode
      markExited()
      this.emit('exit', id, exitCode)
      if (!record.killed && closesOnExit(this.settings.get().general.closeOnExit, exitCode)) this.close(id)
      else this.emitChanged()
    })

    this.emitChanged()
    return { ...info }
  }

  write(id: string, data: string): void {
    const record = this.terminals.get(id)
    if (record?.process && typeof data === 'string' && data.length > 0) record.process.write(data)
  }

  resize(id: string, cols: number, rows: number): void {
    const record = this.terminals.get(id)
    if (!record?.process) return
    const c = clampSize(cols, 0)
    const r = clampSize(rows, 0)
    if (c < 2 || r < 1) return
    try {
      record.process.resize(c, r)
    } catch {
      // The process may have exited between the check and the call.
    }
  }

  kill(id: string): void {
    const record = this.terminals.get(id)
    if (!record?.process) return
    record.killed = true
    try {
      record.process.kill()
    } catch {
      // already gone
    }
  }

  /** Ends the process and waits until it is gone (at most `timeoutMs`). */
  async stop(id: string, timeoutMs = 5000): Promise<void> {
    const record = this.require(id)
    if (!record.process) return
    this.kill(id)
    let timer: NodeJS.Timeout | undefined
    await Promise.race([record.exited, new Promise<void>((resolve) => (timer = setTimeout(resolve, timeoutMs)))])
    clearTimeout(timer)
  }

  close(id: string): void {
    const record = this.terminals.get(id)
    if (!record) return
    if (record.flushTimer) clearTimeout(record.flushTimer)
    this.kill(id)
    this.terminals.delete(id)
    this.emitChanged()
  }

  rename(id: string, title: string): void {
    const record = this.require(id)
    const next = title.trim()
    if (!next) return
    record.info.title = next.slice(0, 120)
    this.emitChanged()
  }

  /**
   * Output emitted so far. `end` is the stream offset right after `data`, so a client can
   * subscribe first, then fetch the buffer and drop/trim live chunks that are already included.
   */
  buffer(id: string): { data: string; end: number } {
    const record = this.require(id)
    return { data: record.chunks.join(''), end: record.emitted }
  }

  disposeAll(): void {
    clearInterval(this.trackTimer)
    for (const id of [...this.terminals.keys()]) this.close(id)
  }

  /** Follows which session runs in each tab and whether it stopped at a usage limit. */
  private async track(): Promise<void> {
    if (this.tracking) return
    this.tracking = true
    try {
      let changed = false
      for (const record of [...this.terminals.values()]) {
        if (record.info.mode !== 'session' || record.info.status !== 'running') continue
        if (await this.trackSession(record)) changed = true
      }
      if (changed) this.emitChanged()
    } catch {
      // Files may be rewritten while we read them; the next round tries again.
    } finally {
      this.tracking = false
    }
  }

  private async trackSession(record: TerminalRecord): Promise<boolean> {
    const { info } = record
    let paths
    try {
      paths = this.accounts.paths(info.accountId)
    } catch {
      return false
    }
    const live = await readLiveSessionId(paths.sessionsDir, info.pid, Date.parse(info.createdAt))
    let changed = false
    if (live && live !== info.sessionId) {
      info.sessionId = live
      changed = true
    }
    const limit = info.sessionId ? await this.readLimit(record, paths.projectsDir, info.sessionId) : null
    if (JSON.stringify(limit) !== JSON.stringify(info.limit)) {
      info.limit = limit
      changed = true
    }
    return changed
  }

  /** Re-reads the transcript only when it changed; a limit also ends at its reset time. */
  private async readLimit(record: TerminalRecord, projectsDir: string, sessionId: string): Promise<SessionLimit | null> {
    if (record.transcript?.sessionId !== sessionId) {
      const file = await findTranscript(projectsDir, sessionId, record.info.cwd)
      record.transcript = file ? { sessionId, file, size: -1, mtimeMs: -1, limit: null } : null
    }
    const tracked = record.transcript
    if (!tracked) return null
    const info = await stat(tracked.file).catch(() => null)
    if (!info) {
      record.transcript = null
      return null
    }
    if (info.size !== tracked.size || info.mtimeMs !== tracked.mtimeMs) {
      tracked.limit = await readSessionLimit(tracked.file, Date.parse(record.info.createdAt))
      tracked.size = info.size
      tracked.mtimeMs = info.mtimeMs
    }
    const resetsAt = tracked.limit?.resetsAt ? Date.parse(tracked.limit.resetsAt) : null
    return resetsAt !== null && resetsAt <= Date.now() ? null : tracked.limit
  }

  private handleData(record: TerminalRecord, data: string): void {
    record.pending += data
    if (!record.flushTimer) {
      record.flushTimer = setTimeout(() => this.flush(record), FLUSH_INTERVAL_MS)
    }
  }

  private flush(record: TerminalRecord): void {
    if (record.flushTimer) {
      clearTimeout(record.flushTimer)
      record.flushTimer = null
    }
    if (!record.pending) return
    const data = record.pending
    record.pending = ''
    const offset = record.emitted
    record.emitted += data.length
    record.chunks.push(data)
    record.size += data.length
    while (record.size > MAX_BUFFER_CHARS && record.chunks.length > 1) {
      record.size -= record.chunks.shift()!.length
    }
    this.emit('data', record.info.id, data, offset)
  }

  private resolveCwd(candidate: string | null | undefined): string {
    const dir = candidate?.trim()
    if (dir) {
      try {
        if (existsSync(dir) && statSync(dir).isDirectory()) return dir
      } catch {
        // fall through
      }
      throw new Error(`Der Ordner „${dir}“ existiert nicht.`)
    }
    return homedir()
  }

  private require(id: string): TerminalRecord {
    const record = this.terminals.get(id)
    if (!record) throw new Error('Terminal nicht gefunden.')
    return record
  }

  private emitChanged(): void {
    this.emit('changed', this.list())
  }
}

function closesOnExit(setting: CloseOnExit, exitCode: number): boolean {
  return setting === 'always' || (setting === 'graceful' && exitCode === 0)
}

/** Tab title when none was given; the account is the one whose limits the tab uses. */
export function defaultTerminalTitle(mode: TerminalInfo['mode'], accountName: string, cwd: string): string {
  if (mode === 'login') return `Anmeldung · ${accountName}`
  if (mode === 'shell') return `Shell · ${accountName}`
  return `${accountName} · ${basename(cwd) || cwd}`
}

/** The user's shell, started with the account environment (handy for `claude setup-token` & co). */
function shellCommand(): { file: string; args: string[]; display: string } {
  if (process.platform === 'win32') {
    const pwsh = (process.env.PATH ?? '')
      .split(';')
      .map((dir) => join(dir, 'pwsh.exe'))
      .find((candidate) => existsSync(candidate))
    const file = pwsh ?? 'powershell.exe'
    return { file, args: ['-NoLogo'], display: `${file} -NoLogo` }
  }
  const file = process.env.SHELL || '/bin/bash'
  return { file, args: ['-l'], display: `${file} -l` }
}

function clampSize(value: number | undefined, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.max(1, Math.min(1000, Math.floor(value)))
}

/** Deletes an environment key case-insensitively (Windows env names are case-insensitive). */
function deleteEnv(env: Record<string, string>, key: string): void {
  const lower = key.toLowerCase()
  for (const existing of Object.keys(env)) {
    if (existing.toLowerCase() === lower) delete env[existing]
  }
}
