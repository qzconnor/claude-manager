import { randomUUID } from 'node:crypto'
import { existsSync, statSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import { userInfo } from 'node:os'
import { basename, join } from 'node:path'
import type * as Pty from 'node-pty'
import { BLANK_PAGE, fallbackTitle, isBrowsableUrl } from '@shared/browser'
import { applyOrder } from '@shared/order'
import { dropPanes, isSplit, paneIds, removePanes, replacePane, splitPane } from '@shared/panes'
import type {
  AttentionKind,
  BrowserOpenOptions,
  BrowserPage,
  CloseOnExit,
  PaneNode,
  PaneSplit,
  SessionLimit,
  SessionWorktree,
  SplitDirection,
  TerminalCreateOptions,
  TerminalInfo,
} from '@shared/types'
import { colorFgBg, colorSchemeReport, ColorSchemeUpdates } from '../lib/color-scheme'
import { fallbackSessionFolder } from '../lib/session-folder'
import {
  findTranscript,
  newTitleScan,
  readLiveSession,
  readSessionLimit,
  readSessionTitles,
  readTurnOutcome,
  scannedTitle,
  SESSION_ID_RE,
  type TitleScan,
  worktreeAt,
} from '../lib/session-files'
import { claudeActivity, TitleReader } from '../lib/terminal-title'
import { TypedEmitter } from '../lib/typed-emitter'
import type { AccountService } from './account-service'
import { displayCommand, type ClaudeCli } from './claude-cli'
import type { SettingsService } from './settings-service'
import type { WorkspaceTrust } from './workspace-trust'

/** Output kept per terminal so a view (or API client) can re-attach and replay it. */
const MAX_BUFFER_CHARS = 2_000_000
/** Output is coalesced for this long before it is forwarded — keeps IPC traffic low. */
const FLUSH_INTERVAL_MS = 6
/** How often running sessions are checked for their current session id and a usage limit. */
const TRACK_INTERVAL_MS = 2000
/**
 * After Claude Code's title says the turn ended, the transcript tells why. Claude Code buffers its
 * own entries (answer, tool calls) for about 3 s, so it is read again until the end is clear.
 */
const TURN_END_POLL_MS = 300
/**
 * A tool call without result means Claude Code waits for the user only after this long: before, its
 * result may still be in Claude Code's buffer. A finished answer is known earlier by `turn_duration`.
 */
const TURN_END_SETTLE_MS = 4500
/** Without a clear end in the transcript the turn counts as done after this long. */
const TURN_END_TIMEOUT_MS = 8000
/** Arguments with which Claude Code picks the session itself. */
const SESSION_CHOICE_ARG_RE = /^(-c|--continue|-r|--resume|--session-id|--from-pr|--teleport)(=|$)/

let ptyModule: typeof Pty | undefined

/**
 * node-pty is a native module and is loaded with the first terminal. If it can't be loaded (e.g. on
 * Linux, compiled against a newer glibc than the system has), only the terminals fail with the reason,
 * the app still starts. As an import, the error would end the main process before its window, and on
 * Linux Electron reports errors before `ready` on stderr only: the app would seem to do nothing.
 */
function loadPty(): typeof Pty {
  if (ptyModule) return ptyModule
  try {
    ptyModule = require('node-pty') as typeof Pty
    return ptyModule
  } catch (error) {
    console.error('[terminal] node-pty could not be loaded', error)
    const reason = error instanceof Error ? error.message : String(error)
    throw new Error(`Terminals können nicht starten, node-pty lässt sich nicht laden: ${reason}`)
  }
}

interface TrackedTranscript {
  sessionId: string
  file: string
  size: number
  mtimeMs: number
  limit: SessionLimit | null
  titles: TitleScan
}

/** Claude Code ended its turn in a tab: what happened, for notifications and the unread dot. */
export interface TurnEnd {
  kind: AttentionKind
  /** How long Claude Code worked on the turn (ms). */
  busyMs: number
  /** `input`: the tool that waits for the user, e.g. `Bash` or `AskUserQuestion`. */
  tool: string | null
  /** The beginning of the answer, the command or question waiting for the user, or the limit message. */
  detail: string | null
}

interface TerminalRecord {
  info: TerminalInfo
  /** Shown while the session has no title (and for shells and logins). */
  defaultTitle: string
  process: Pty.IPty | null
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
  titles: TitleReader
  /** When Claude Code started working on the current turn (ms). */
  busySince: number
  /** The end of the turn is being looked up in the transcript. */
  turnEnding: boolean
  /** Counts turn ends and restarts: a lookup that is no longer the latest stops. */
  turnEndRun: number
  /** Whether the program wants to hear when the terminal turns dark or light. */
  colorScheme: ColorSchemeUpdates
  /** A view of the tab has had its output, and so answered the queries in it. */
  viewed: boolean
}

/** Options other parts of the app give every session they start, e.g. the browser's MCP server. */
export interface SessionArgsProvider {
  /** `extra`: the user's own arguments for the session, which come after these. */
  args(terminalId: string, extra: readonly string[]): string[]
  /** The session's process is gone: what `args` set up for it can go too. */
  release(terminalId: string): void
}

type Events = {
  changed: [terminals: TerminalInfo[]]
  /** `offset` = position of `data` in the terminal's output stream */
  data: [id: string, data: string, offset: number]
  exit: [id: string, exitCode: number]
  /** Claude Code ended its turn: it is done, waits for the user (e.g. a permission prompt) or hit a limit. */
  turnEnded: [id: string, turn: TurnEnd]
}

export class TerminalService extends TypedEmitter<Events> {
  private readonly terminals = new Map<string, TerminalRecord>()
  /** Tabs with more than one terminal; every other terminal has a tab of its own. */
  private splits: PaneSplit[] = []
  private readonly trackTimer: NodeJS.Timeout
  private tracking = false
  /** A new tab arrived during a round: run another one right after it. */
  private trackAgain = false
  /** Whether the terminal theme is dark, as the window reports it; unknown until it does. */
  private dark: boolean | null = null
  private readonly sessionArgs: SessionArgsProvider[] = []

  constructor(
    private readonly accounts: AccountService,
    private readonly cli: ClaudeCli,
    private readonly settings: SettingsService,
    private readonly trust: WorkspaceTrust,
  ) {
    super()
    this.trackTimer = setInterval(() => void this.track(), TRACK_INTERVAL_MS)
  }

  /** Gives the sessions started from now on more options (see SessionArgsProvider). */
  addSessionArgs(provider: SessionArgsProvider): void {
    this.sessionArgs.push(provider)
  }

  list(): TerminalInfo[] {
    return [...this.terminals.values()].map((t) => ({ ...t.info }))
  }

  /** The tabs with more than one terminal, as they share their space. */
  layouts(): PaneSplit[] {
    return [...this.splits]
  }

  get(id: string): TerminalInfo {
    return { ...this.require(id).info }
  }

  /** Running terminals that use the account, for its files or its credentials. Browsers run nothing. */
  runningCount(accountId?: string): number {
    return [...this.terminals.values()].filter(
      (t) =>
        t.info.status === 'running' &&
        t.info.mode !== 'browser' &&
        (!accountId || t.info.accountId === accountId || t.info.authAccountId === accountId),
    ).length
  }

  /**
   * Like `create`, but Claude Code only starts in a folder it trusts: the app asks first, instead of
   * Claude Code in the terminal. Null when the user said no.
   */
  async open(options: TerminalCreateOptions): Promise<TerminalInfo | null> {
    if ((options.mode ?? 'session') !== 'session') return this.create(options)
    const cwd = await this.trustedCwd(options.accountId, options.cwd)
    return cwd === null ? null : this.create({ ...options, cwd })
  }

  /** The folder a session of the account starts in, once it is trusted (see `open`). */
  async trustedCwd(accountId: string, cwd: string | null | undefined): Promise<string | null> {
    const account = this.accounts.get(accountId)
    const dir = this.resolveCwd(cwd ?? account.defaultCwd ?? this.settings.get().claude.defaultCwd)
    return this.trust.ensure(account.id, dir)
  }

  /** Starts right away; a folder Claude Code doesn't trust yet gets its question in the terminal. */
  create(options: TerminalCreateOptions): TerminalInfo {
    const account = this.accounts.get(options.accountId)
    const auth = options.authAccountId ? this.accounts.get(options.authAccountId) : account
    const settings = this.settings.get()
    const mode = options.mode ?? 'session'

    const cwd = this.resolveCwd(options.cwd ?? account.defaultCwd ?? settings.claude.defaultCwd)

    const id = randomUUID()
    const args: string[] = []
    let providers: SessionArgsProvider[] = []
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
      if (mode === 'session') {
        providers = [...this.sessionArgs]
        for (const provider of providers) args.push(...provider.args(id, extra))
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
    // The theme the program starts with, for programs that can't ask the terminal (see setColorScheme).
    if (this.dark !== null) {
      deleteEnv(env, 'COLORFGBG')
      env.COLORFGBG = colorFgBg(this.dark)
    }

    const command = mode === 'shell' ? shellCommand() : this.cli.command(args)
    const cols = clampSize(options.cols, 120)
    const rows = clampSize(options.rows, 32)
    let proc: Pty.IPty
    try {
      proc = loadPty().spawn(command.file, command.args, {
        name: 'xterm-256color',
        cols,
        rows,
        cwd,
        env,
        useConpty: true,
        // The ConPTY of Windows Terminal that comes with node-pty. Unlike the one of Windows, it passes
        // queries such as the background color (OSC 11) on to the terminal.
        useConptyDll: process.platform === 'win32' && settings.terminal.modernConpty,
      })
    } catch (error) {
      for (const provider of providers) provider.release(id)
      throw error
    }

    const defaultTitle = defaultTerminalTitle(mode, auth.name, cwd)
    const fixedTitle = options.title?.trim().slice(0, 120) || null
    const info: TerminalInfo = {
      id,
      accountId: account.id,
      authAccountId: auth.id,
      sessionId,
      limit: null,
      busy: false,
      attention: null,
      muted: options.muted === true,
      title: fixedTitle ?? defaultTitle,
      fixedTitle: fixedTitle !== null,
      autoTitle: defaultTitle,
      cwd,
      mode,
      url: null,
      resumeSessionId: options.resumeSessionId ?? null,
      status: 'running',
      exitCode: null,
      pid: proc.pid,
      createdAt: new Date().toISOString(),
      commandLine: command.display,
      worktree: null,
    }
    let markExited!: () => void
    const record = newRecord(info, defaultTitle, proc, new Promise((resolve) => (markExited = resolve)))
    this.add(record, options)

    proc.onData((data) => this.handleData(record, data))
    proc.onExit(({ exitCode }) => {
      this.flush(record)
      record.process = null
      record.info.status = 'exited'
      record.info.exitCode = exitCode
      record.info.busy = false
      for (const provider of providers) provider.release(id)
      markExited()
      this.emit('exit', id, exitCode)
      if (!record.killed && closesOnExit(this.settings.get().general.closeOnExit, exitCode)) this.close(id)
      else this.emitChanged()
    })

    this.emitChanged()
    // A resumed session already has its title: show it right away, not with the next round.
    if (mode === 'session') this.trackSoon()
    return { ...info }
  }

  /**
   * A browser in a new tab or next to a terminal: a web page instead of a process. The window shows
   * it and reports what it shows (`setBrowserPage`); it runs until it is closed.
   */
  openBrowser(options: BrowserOpenOptions = {}): TerminalInfo {
    const url = options.url?.trim() || BLANK_PAGE
    if (!isBrowsableUrl(url)) throw new Error('Der Browser öffnet nur http- und https-Adressen.')
    const fixedTitle = options.title?.trim().slice(0, 120) || null
    const defaultTitle = fallbackTitle(url)
    const info: TerminalInfo = {
      id: randomUUID(),
      accountId: '',
      authAccountId: '',
      sessionId: null,
      limit: null,
      busy: false,
      attention: null,
      muted: false,
      title: fixedTitle ?? defaultTitle,
      fixedTitle: fixedTitle !== null,
      autoTitle: defaultTitle,
      cwd: '',
      mode: 'browser',
      url,
      resumeSessionId: null,
      status: 'running',
      exitCode: null,
      pid: 0,
      createdAt: new Date().toISOString(),
      commandLine: '',
      worktree: null,
    }
    this.add(newRecord(info, defaultTitle, null, Promise.resolve()), options)
    this.emitChanged()
    return { ...info }
  }

  /** What a browser shows now; its tab follows the page's title unless it was given one. */
  setBrowserPage(id: string, page: BrowserPage): void {
    const record = this.terminals.get(id)
    if (record?.info.mode !== 'browser' || !isBrowsableUrl(page.url)) return
    const title = page.title.replace(/\s+/g, ' ').trim().slice(0, 120)
    record.defaultTitle = title || fallbackTitle(page.url)
    const moved = record.info.url !== page.url
    record.info.url = page.url
    if (followTitle(record.info, record.defaultTitle) || moved) this.emitChanged()
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
    this.splits = dropPanes(this.splits, new Set([id]))
    this.emitChanged()
  }

  /**
   * Gives the tab a name of its own; the session's title stays known (`autoTitle`). An empty title
   * lets the tab follow the session's title again.
   */
  rename(id: string, title: string): void {
    const { info } = this.require(id)
    const next = title.trim().slice(0, 120)
    info.fixedTitle = next.length > 0
    info.title = next || info.autoTitle
    this.emitChanged()
  }

  /** Marks the tab as having news the user hasn't seen, or as seen (`null`). */
  setAttention(id: string, attention: AttentionKind | null): void {
    const record = this.terminals.get(id)
    if (!record || record.info.attention === attention) return
    record.info.attention = attention
    this.emitChanged()
  }

  /**
   * Takes over the order of the window's tab bar (e.g. after dragging a tab), so the API lists the
   * tabs and the next start restores them in that order. Tabs missing from `ids` stay at the end.
   */
  reorder(ids: string[]): void {
    if (this.applyOrder(ids)) this.emitChanged()
  }

  /**
   * Puts these terminals together in one tab, as `layout` shares its space, and takes them out of the
   * tabs they were in. A single id gives the terminal a tab of its own. Terminals that closed in the
   * meantime leave their space to the others.
   */
  arrange(layout: PaneNode): void {
    const open = removePanes(layout, new Set(paneIds(layout).filter((id) => !this.terminals.has(id))))
    if (open === null) return
    this.splits = [...dropPanes(this.splits, new Set(paneIds(open))), ...(isSplit(open) ? [open] : [])]
    this.emitChanged()
  }

  /** A muted tab sends no notifications and doesn't flash the taskbar. */
  setMuted(id: string, muted: boolean): void {
    const record = this.require(id)
    if (record.info.muted === muted) return
    record.info.muted = muted
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

  /**
   * The output so far for a view of the tab. `answered`: an earlier view (e.g. before the window
   * reloaded) already answered the queries in it, such as device attributes or the background color.
   * The program got its replies or gave up waiting long ago; replies now would reach it as input.
   */
  attach(id: string): { data: string; end: number; answered: boolean } {
    const record = this.require(id)
    const answered = record.viewed
    record.viewed = true
    return { ...this.buffer(id), answered }
  }

  disposeAll(): void {
    clearInterval(this.trackTimer)
    for (const id of [...this.terminals.keys()]) this.close(id)
  }

  private trackSoon(): void {
    if (this.tracking) this.trackAgain = true
    else void this.track()
  }

  /** Follows which session runs in each tab, its title and whether it stopped at a usage limit. */
  private async track(): Promise<void> {
    if (this.tracking) return
    this.tracking = true
    this.trackAgain = false
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
    if (this.trackAgain) void this.track()
  }

  private async trackSession(record: TerminalRecord): Promise<boolean> {
    const { info } = record
    let paths
    try {
      paths = this.accounts.paths(info.accountId)
    } catch {
      return false
    }
    const live = await readLiveSession(paths.sessionsDir, info.pid, Date.parse(info.createdAt))
    let changed = false
    if (live && live.sessionId !== info.sessionId) {
      info.sessionId = live.sessionId
      changed = true
    }
    const transcript = info.sessionId ? await this.readTranscript(record, paths.projectsDir, info.sessionId) : null
    const limit = transcript ? currentLimit(transcript.limit) : null
    if (JSON.stringify(limit) !== JSON.stringify(info.limit)) {
      info.limit = limit
      changed = true
    }
    const worktree = currentWorktree(transcript?.titles.worktree, live?.cwd ?? null, info.cwd, info.worktree)
    if (JSON.stringify(worktree) !== JSON.stringify(info.worktree)) {
      info.worktree = worktree
      changed = true
    }
    return followTitle(info, this.autoTitle(record)) || changed
  }

  /** The session's title as Claude Code shows it; after `/clear` the new session has none yet. */
  private autoTitle(record: TerminalRecord): string {
    const tracked = record.transcript
    const title = tracked && tracked.sessionId === record.info.sessionId ? scannedTitle(tracked.titles) : null
    return title ? title.replace(/\s+/g, ' ').slice(0, 120) : record.defaultTitle
  }

  /** Re-reads the transcript only when it changed. */
  private async readTranscript(
    record: TerminalRecord,
    projectsDir: string,
    sessionId: string,
  ): Promise<TrackedTranscript | null> {
    if (record.transcript?.sessionId !== sessionId) {
      const file = await findTranscript(projectsDir, sessionId, record.info.cwd)
      record.transcript = file ? { sessionId, file, size: -1, mtimeMs: -1, limit: null, titles: newTitleScan() } : null
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
      await readSessionTitles(tracked.file, tracked.titles)
      tracked.size = info.size
      tracked.mtimeMs = info.mtimeMs
    }
    return tracked
  }

  /**
   * The terminal theme turned dark or light (or the window tells it on start). Programs that asked
   * for it (mode 2031) are told; Claude Code then reads the background color again (OSC 11, answered
   * by xterm) and picks its "Auto" theme. Programs started from now on also get it as COLORFGBG.
   */
  setColorScheme(dark: boolean): void {
    if (this.dark === dark) return
    this.dark = dark
    for (const record of this.terminals.values()) {
      if (record.process && record.colorScheme.enabled) record.process.write(colorSchemeReport(dark))
    }
  }

  private handleData(record: TerminalRecord, data: string): void {
    record.colorScheme.read(data)
    const title = record.titles.read(data)
    if (title !== null) this.followActivity(record, title)
    record.pending += data
    if (!record.flushTimer) {
      record.flushTimer = setTimeout(() => this.flush(record), FLUSH_INTERVAL_MS)
    }
  }

  /** Shows in the tab whether Claude Code works; the end of a turn is reported once. */
  private followActivity(record: TerminalRecord, title: string): void {
    const activity = claudeActivity(title)
    if (activity === null || (activity === 'busy') === record.info.busy) return
    const { info } = record
    info.busy = activity === 'busy'
    // Stops a lookup of the previous turn end.
    const run = ++record.turnEndRun
    if (info.busy) {
      // Back at work before the end was clear: the same turn goes on, its time keeps running.
      if (record.turnEnding) record.turnEnding = false
      else record.busySince = Date.now()
      // A permission or question was answered (also through the API): it no longer waits.
      if (info.attention === 'input') info.attention = null
    } else {
      record.turnEnding = true
      void this.reportTurnEnd(record, run)
    }
    this.emitChanged()
  }

  /** Tells once whether Claude Code is done, waits for the user or stopped at a limit. */
  private async reportTurnEnd(record: TerminalRecord, run: number): Promise<void> {
    const idleAt = Date.now()
    const since = record.busySince
    const current = () =>
      run === record.turnEndRun && !record.info.busy && record.info.status === 'running' && this.terminals.has(record.info.id)
    while (current()) {
      await delay(TURN_END_POLL_MS)
      if (!current()) return
      const elapsed = Date.now() - idleAt
      let turn: Omit<TurnEnd, 'busyMs'> | 'interrupted' | null = null
      try {
        turn = await this.inspectTurnEnd(record, since, elapsed)
      } catch {
        // The transcript is being rewritten: look again.
      }
      if (turn === null && elapsed >= TURN_END_TIMEOUT_MS) turn = { kind: 'done', tool: null, detail: null }
      if (turn === null || !current()) continue
      record.turnEnding = false
      // Stopped by the user (Esc, or a permission declined): they are at the tab already.
      if (turn !== 'interrupted') this.emit('turnEnded', record.info.id, { ...turn, busyMs: since ? idleAt - since : 0 })
      return
    }
  }

  /** What the transcript says about the turn that started at `since`; null while that isn't clear yet. */
  private async inspectTurnEnd(
    record: TerminalRecord,
    since: number,
    elapsed: number,
  ): Promise<Omit<TurnEnd, 'busyMs'> | 'interrupted' | null> {
    // Shell tabs run Claude Code without a known session: it can only be done.
    if (record.info.mode !== 'session') return { kind: 'done', tool: null, detail: null }
    // Also brings the session, its limit and title up to date right away.
    if (await this.trackSession(record)) this.emitChanged()
    const limit = record.info.limit
    if (limit) return { kind: 'limit', tool: null, detail: limit.message }
    const tracked = record.transcript
    if (!tracked || tracked.sessionId !== record.info.sessionId) return null
    const outcome = await readTurnOutcome(tracked.file, since)
    if (outcome.interrupted) return 'interrupted'
    if (outcome.ended) return { kind: 'done', tool: null, detail: outcome.answer }
    if (elapsed < TURN_END_SETTLE_MS) return null
    if (outcome.waiting) return { kind: 'input', tool: outcome.waiting.tool, detail: outcome.waiting.detail || null }
    // Older Claude Code versions write no `turn_duration`.
    return outcome.answer ? { kind: 'done', tool: null, detail: outcome.answer } : null
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
    return fallbackSessionFolder()
  }

  private require(id: string): TerminalRecord {
    const record = this.terminals.get(id)
    if (!record) throw new Error('Terminal nicht gefunden.')
    return record
  }

  /** Whether the order changed. */
  private applyOrder(ids: string[]): boolean {
    const records = [...this.terminals.values()]
    const ordered = applyOrder(records, ids, (record) => record.info.id)
    if (ordered.every((record, index) => record === records[index])) return false
    this.terminals.clear()
    for (const record of ordered) this.terminals.set(record.info.id, record)
    return true
  }

  /** Takes a new terminal in: in the place of `replaces`, next to the one it splits, or as a tab at the end. */
  private add(record: TerminalRecord, options: Pick<TerminalCreateOptions, 'replaces' | 'split'>): void {
    const { id } = record.info
    this.terminals.set(id, record)
    if (options.replaces && this.terminals.has(options.replaces)) this.takePlace(id, options.replaces)
    else if (options.split && this.terminals.has(options.split.terminalId)) {
      this.addPane(options.split.terminalId, id, options.split.direction === 'column' ? 'column' : 'row')
    }
  }

  /** The new terminal `id` goes where `oldId` is, in the order and in its tab; `oldId` is left with a tab of its own. */
  private takePlace(id: string, oldId: string): void {
    const ids = [...this.terminals.keys()].filter((key) => key !== id)
    ids.splice(ids.indexOf(oldId), 0, id)
    this.applyOrder(ids)
    this.splits = this.splits.map((split) => replacePane(split, oldId, id) as PaneSplit)
  }

  /** The new terminal `id` takes half the part of `of`, in its tab, and follows it in the order. */
  private addPane(of: string, id: string, direction: SplitDirection): void {
    const ids = [...this.terminals.keys()].filter((key) => key !== id)
    ids.splice(ids.indexOf(of) + 1, 0, id)
    this.applyOrder(ids)
    const index = this.splits.findIndex((split) => paneIds(split).includes(of))
    if (index === -1) this.splits = [...this.splits, splitPane(of, of, id, direction) as PaneSplit]
    else this.splits = this.splits.map((split, i) => (i === index ? (splitPane(split, of, id, direction) as PaneSplit) : split))
  }

  private emitChanged(): void {
    this.emit('changed', this.list())
  }
}

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/** A limit also ends at its reset time, even if the transcript doesn't change. */
function currentLimit(limit: SessionLimit | null): SessionLimit | null {
  const resetsAt = limit?.resetsAt ? Date.parse(limit.resetsAt) : null
  return resetsAt !== null && resetsAt <= Date.now() ? null : limit
}

/**
 * The worktree a session works in. The transcript knows it with its branch, but only once the first
 * prompt is written; until then the folder from `sessions/<pid>.json` tells it. Without either (e.g.
 * just after `/clear` with an older Claude Code) the tab keeps what it had.
 */
function currentWorktree(
  scanned: SessionWorktree | null | undefined,
  liveCwd: string | null,
  startCwd: string,
  previous: SessionWorktree | null,
): SessionWorktree | null {
  if (scanned) return scanned
  if (liveCwd) return worktreeAt(liveCwd, startCwd)
  return scanned === undefined ? previous : null
}

function closesOnExit(setting: CloseOnExit, exitCode: number): boolean {
  return setting === 'always' || (setting === 'graceful' && exitCode === 0)
}

function newRecord(info: TerminalInfo, defaultTitle: string, process: Pty.IPty | null, exited: Promise<void>): TerminalRecord {
  return {
    info,
    defaultTitle,
    process,
    exited,
    transcript: null,
    chunks: [],
    size: 0,
    emitted: 0,
    pending: '',
    flushTimer: null,
    killed: false,
    titles: new TitleReader(),
    busySince: 0,
    turnEnding: false,
    turnEndRun: 0,
    colorScheme: new ColorSchemeUpdates(),
    viewed: false,
  }
}

/**
 * Takes over the session's or page's title; the tab shows it unless it has a name of its own. True
 * when anything changed.
 */
function followTitle(info: TerminalInfo, autoTitle: string): boolean {
  const title = info.fixedTitle ? info.title : autoTitle
  if (info.autoTitle === autoTitle && info.title === title) return false
  info.autoTitle = autoTitle
  info.title = title
  return true
}

/** Tab title when none was given; the account is the one whose limits the tab uses. */
export function defaultTerminalTitle(mode: TerminalInfo['mode'], accountName: string, cwd: string): string {
  if (mode === 'login') return `Anmeldung · ${accountName}`
  if (mode === 'shell') return `Shell · ${accountName}`
  if (mode === 'browser') return fallbackTitle(null)
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
    return { file, args: ['-NoLogo'], display: displayCommand(file, ['-NoLogo']) }
  }
  let file = process.env.SHELL
  if (!file) {
    try {
      file = userInfo().shell ?? undefined
    } catch {
      // No entry in the user database.
    }
  }
  file ||= existsSync('/bin/bash') ? '/bin/bash' : '/bin/sh'
  return { file, args: ['-l'], display: displayCommand(file, ['-l']) }
}

function clampSize(value: number | undefined, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.max(1, Math.min(1000, Math.floor(value)))
}

/** Deletes an environment key; on Windows case-insensitively, like its environment names. */
function deleteEnv(env: Record<string, string>, key: string): void {
  if (process.platform !== 'win32') {
    delete env[key]
    return
  }
  const lower = key.toLowerCase()
  for (const existing of Object.keys(env)) {
    if (existing.toLowerCase() === lower) delete env[existing]
  }
}
