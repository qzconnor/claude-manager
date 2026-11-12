import { randomUUID } from 'node:crypto'
import { existsSync, statSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import { userInfo } from 'node:os'
import { basename, join } from 'node:path'
import type * as Pty from 'node-pty'
import { BLANK_PAGE, fallbackTitle, isBrowsableUrl } from '@shared/browser'
import { folderKey, inFolder } from '@shared/folders'
import { applyOrder } from '@shared/order'
import { canInsertPane, dropPanes, hasPane, isSplit, ownerOf, paneIds, removePanes, replacePane, splitPane } from '@shared/panes'
import type {
  AttentionKind,
  BrowserOpenOptions,
  BrowserPage,
  CloseOnExit,
  PaneNode,
  PaneSplit,
  PastedImage,
  SessionLimit,
  SessionWorktree,
  SplitDirection,
  TerminalAttach,
  TerminalCreateOptions,
  TerminalInfo,
} from '@shared/types'
import { withdrawBootEntries, withdrawBootEntriesSync, type EndedLaunch } from '../lib/boot-canary'
import { colorFgBg, colorSchemeReport, ColorSchemeUpdates } from '../lib/color-scheme'
import {
  applyHookCall,
  idleHookState,
  interruptedHookState,
  newHookState,
  type HookCall,
  type HookState,
  type HookTurnEnd,
} from '../lib/hook-events'
import { KeptImages, type KeptImage } from '../lib/kept-images'
import { choosePastedImage, newPastedImageScan, readPastedImage, scanPastedImages, type PastedImageScan } from '../lib/pasted-images'
import { fallbackSessionFolder } from '../lib/session-folder'
import { readCompactLimit } from '../lib/auto-compact'
import {
  findTranscript,
  isWorktreeOf,
  liveSessionIds,
  newTitleScan,
  readContextUsage,
  readLiveSession,
  readSessionLimit,
  readStartedAt,
  readSessionTitles,
  readTurnOutcome,
  scannedTitle,
  SESSION_ID_RE,
  type ContextReading,
  type TitleScan,
  worktreeAt,
} from '../lib/session-files'
import { oneLine, plainText } from '../lib/plain-text'
import { awaitEnd, forceKill } from '../lib/process-end'
import { TrimmedModes } from '../lib/terminal-modes'
import { claudeActivity, TitleReader } from '../lib/terminal-title'
import { TypedEmitter } from '../lib/typed-emitter'
import type { AccountService } from './account-service'
import { displayCommand, type ClaudeCli, type ResolvedCommand } from './claude-cli'
import type { SessionNames } from './session-names'
import type { SettingsService } from './settings-service'
import type { WorkspaceTrust } from './workspace-trust'

/** Output kept per terminal so a view (or API client) can re-attach and replay it. */
const MAX_BUFFER_CHARS = 2_000_000
/** Output is coalesced for this long before it is forwarded — keeps IPC traffic low. */
const FLUSH_INTERVAL_MS = 6
/** How often running sessions are checked for their current session id and a usage limit. */
const TRACK_INTERVAL_MS = 2000
/** A tab whose transcript isn't where its folders say looks for it in all projects at most this often. */
const SEARCH_EVERYWHERE_MS = 30_000
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
/**
 * With hooks the end of a turn comes as an event, around the time the title turns idle. Without one
 * after this long (the user pressed Esc, which ends no turn, or a hook failed) the transcript tells.
 */
const HOOK_END_GRACE_MS = 1500
/** Changes the hooks report while Claude works (one tool after the other) go out together. */
const HOOK_CHANGES_MS = 100
/** How much of the end of a turn a tab keeps (`TerminalInfo.turn`). */
const MAX_TURN_DETAIL_CHARS = 400
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
  /** The context after the latest answer; kept while the end of the transcript has none. */
  context: ContextReading | null
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
  /** Resolves when the process has exited and the app has cleaned up after it (see `withdrawBootEntry`). */
  exited: Promise<void>
  transcript: TrackedTranscript | null
  chunks: string[]
  size: number
  /** The terminal modes in output dropped from `chunks`. */
  trimmed: TrimmedModes
  /** The pseudo terminal's size: the output was last written for it. */
  ptySize: { cols: number; rows: number }
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
  /** What the session's hooks told so far; null while none came (no hooks, see SessionHooks). */
  hooks: HookState | null
  /** The sessions the process had, oldest first: `/clear` starts another one in it. */
  sessionIds: string[]
  /** Since when (ms) the tab knows its current session: one `/clear` starts is written after that. */
  sessionSince: number
  /** The folder Claude Code last named for the session in `sessions/<pid>.json`; null until it did. */
  liveCwd: string | null
  /** The folders the tab's session worked in, the current one first: `/cd` moves it to another one. */
  folders: string[]
  /** The transcripts of these sessions with their pasted images read so far, by session. */
  pastedImages: Map<string, PastedImageTranscript>
  /** When (ms) a transcript of the tab was last looked for in all projects (see `findTabTranscript`). */
  searchedEverywhereAt: number
}

interface PastedImageTranscript {
  file: string
  scan: PastedImageScan
}

/** Options other parts of the app give every session they start, e.g. the browser's MCP server. */
export interface SessionArgsProvider {
  /** `extra`: the user's own arguments for the session, which come after these. `cwd`: the session's folder. */
  args(terminalId: string, extra: readonly string[], cwd: string): string[]
  /**
   * Options that come after the user's own (before a `--` of theirs), for one that has to win over the
   * same option of theirs: of an option given twice, Claude Code takes the last. `cwd`: the session's folder.
   */
  lastArgs?(terminalId: string, extra: readonly string[], cwd: string): string[]
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

/** Whether the environment for a session holds a token or API key of the app. */
export function hasSecret(set: Record<string, string>): boolean {
  return 'CLAUDE_CODE_OAUTH_TOKEN' in set || 'ANTHROPIC_API_KEY' in set
}

export class TerminalService extends TypedEmitter<Events> {
  private readonly terminals = new Map<string, TerminalRecord>()
  /** Pasted images of all tabs, until they are sent. */
  private readonly keptImages = new KeptImages()
  /** Tabs with more than one terminal; every other terminal has a tab of its own. */
  private splits: PaneSplit[] = []
  private readonly trackTimer: NodeJS.Timeout
  private tracking = false
  /** A new tab arrived during a round: run another one right after it. */
  private trackAgain = false
  /** Whether the terminal theme is dark, as the window reports it; unknown until it does. */
  private dark: boolean | null = null
  private readonly sessionArgs: SessionArgsProvider[] = []
  private changedTimer: NodeJS.Timeout | null = null

  constructor(
    private readonly accounts: AccountService,
    private readonly cli: ClaudeCli,
    private readonly settings: SettingsService,
    private readonly trust: WorkspaceTrust,
    /** The names the user gave sessions; without them a tab's name stays with the tab. */
    private readonly names: Pick<SessionNames, 'get' | 'set' | 'on'> | null = null,
  ) {
    super()
    this.trackTimer = setInterval(() => void this.track(), TRACK_INTERVAL_MS)
    names?.on('changed', (sessionId, name) => this.applySessionName(sessionId, name))
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
   *
   * Two processes must never write to the same transcript: a session that runs in a tab already is
   * that tab (returned as it is), one a Claude Code elsewhere has open goes on only after asking.
   */
  async open(options: TerminalCreateOptions): Promise<TerminalInfo | null> {
    if ((options.mode ?? 'session') !== 'session') return this.create(options)
    const resumed = options.forkSession ? null : options.resumeSessionId
    if (resumed) {
      const running = this.runningSession(options.accountId, resumed)
      if (running) return running
      if (!(await this.mayResumeElsewhereOpen(options.accountId, resumed))) return null
    }
    const cwd = await this.trustedCwd(options.accountId, options.cwd)
    return cwd === null ? null : this.create({ ...options, cwd })
  }

  /** The tab in which the session of the account runs right now. */
  runningSession(accountId: string, sessionId: string): TerminalInfo | null {
    for (const t of this.terminals.values()) {
      if (t.info.mode === 'session' && t.info.status === 'running' && t.info.accountId === accountId && t.info.sessionId === sessionId) {
        return { ...t.info }
      }
    }
    return null
  }

  /** True when no Claude Code has the session open, or the user wants to go on anyway. */
  private async mayResumeElsewhereOpen(accountId: string, sessionId: string): Promise<boolean> {
    const live = await liveSessionIds(this.accounts.paths(accountId).sessionsDir)
    if (!live.has(sessionId)) return true
    const answer = await this.trust.ask({
      title: 'Diese Session ist schon offen',
      description:
        'Ein Claude Code außerhalb dieser Tabs arbeitet gerade in ihr. Laufen beide weiter, schreiben sie durcheinander in denselben Verlauf. ' +
        'Beende sie dort zuerst, oder öffne einen Fork. Fortsetzen nur, wenn sie dort sicher nicht mehr läuft.',
      confirmText: 'Trotzdem fortsetzen',
      cancelText: 'Abbrechen',
      warning: true,
    })
    return answer === true
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
    let command: ResolvedCommand
    let proc: Pty.IPty
    // What the providers set up for the session (its token, its config files) goes again when it doesn't start.
    try {
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
          for (const provider of providers) args.push(...provider.args(id, extra, cwd))
        }
        // Before the extra args: an option there that takes several values would swallow it.
        const prompt = options.prompt?.trim()
        if (prompt && mode === 'session') args.push(prompt)
        const last = providers.flatMap((provider) => provider.lastArgs?.(id, extra, cwd) ?? [])
        const end = extra.indexOf('--')
        args.push(...(end === -1 ? [...extra, ...last] : [...extra.slice(0, end), ...last, ...extra.slice(end)]))
      }

      const env = this.cli.baseEnv()
      const accountEnv = this.accounts.launchEnv(account.id, auth.id)
      for (const key of accountEnv.unset) deleteEnv(env, key)
      for (const [key, value] of Object.entries(accountEnv.set)) {
        deleteEnv(env, key)
        env[key] = value
      }
      // A token or API key in the environment reaches every command Claude runs; Claude Code can keep it out.
      if (settings.claude.hideSecretsFromCommands && hasSecret(accountEnv.set)) {
        deleteEnv(env, 'CLAUDE_CODE_SUBPROCESS_ENV_SCRUB')
        env.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB = '1'
      }
      // The theme the program starts with, for programs that can't ask the terminal (see setColorScheme).
      if (this.dark !== null) {
        deleteEnv(env, 'COLORFGBG')
        env.COLORFGBG = colorFgBg(this.dark)
      }

      command = mode === 'shell' ? shellCommand() : this.cli.command(args)
      proc = loadPty().spawn(command.file, command.args, {
        name: 'xterm-256color',
        cols: clampSize(options.cols, 120),
        rows: clampSize(options.rows, 32),
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
      context: null,
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
      args: mode === 'shell' ? [] : [...(options.args ?? [])],
      restoredFrom: options.restoredFrom ?? null,
      status: 'running',
      exitCode: null,
      pid: proc.pid,
      createdAt: new Date().toISOString(),
      commandLine: command.display,
      worktree: null,
      hooks: false,
      activity: null,
      subagents: 0,
      compacting: false,
      turn: null,
      prompt: null,
    }
    let markExited!: () => void
    const record = newRecord(info, defaultTitle, proc, new Promise((resolve) => (markExited = resolve)))
    this.shareName(record)
    this.add(record, options)

    proc.onData((data) => this.handleData(record, data))
    proc.onExit(({ exitCode }) => {
      this.flush(record)
      record.process = null
      record.info.status = 'exited'
      record.info.exitCode = exitCode
      record.info.busy = false
      record.info.activity = null
      record.info.subagents = 0
      record.info.compacting = false
      for (const provider of providers) provider.release(id)
      // A session started right after (account switch) must not find the entry any more.
      void (record.killed && mode === 'session' ? this.withdrawBootEntry(info) : Promise.resolve()).then(markExited)
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
      context: null,
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
      args: [],
      restoredFrom: options.restoredFrom ?? null,
      status: 'running',
      exitCode: null,
      pid: 0,
      createdAt: new Date().toISOString(),
      commandLine: '',
      worktree: null,
      hooks: false,
      activity: null,
      subagents: 0,
      compacting: false,
      turn: null,
      prompt: null,
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
    // A view replaying the output at the terminal's size reports that size back.
    if (c < 2 || r < 1 || (c === record.ptySize.cols && r === record.ptySize.rows)) return
    try {
      record.process.resize(c, r)
      record.ptySize = { cols: c, rows: r }
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

  /**
   * Ends the process and waits until it is gone. One that is still there after `timeoutMs` is killed
   * hard, with what it started; throws when even that doesn't end it (see `awaitEnd`).
   */
  async stop(id: string, timeoutMs = 5000): Promise<void> {
    const record = this.require(id)
    if (!record.process) return
    const pid = record.process.pid
    this.kill(id)
    await awaitEnd(record.exited, () => forceKill(pid), timeoutMs)
  }

  /** Closes a terminal; the browsers that belong to a session (see `browsersOf`) go with it. */
  close(id: string): void {
    const record = this.terminals.get(id)
    if (!record) return
    const ids = [id, ...(record.info.mode === 'browser' ? [] : this.browsersOf(id))]
    for (const each of ids) {
      const closing = this.terminals.get(each)!
      if (closing.flushTimer) clearTimeout(closing.flushTimer)
      this.kill(each)
      this.terminals.delete(each)
      this.keptImages.forget(each)
    }
    this.splits = dropPanes(this.splits, new Set(ids))
    this.emitChanged()
  }

  /**
   * The browsers that belong to a terminal: those opened beside it, in its split (see `ownerOf`). A
   * terminal that replaces another takes its place there, and so its browsers.
   */
  browsersOf(id: string): string[] {
    const split = this.splits.find((s) => hasPane(s, id))
    if (!split) return []
    return paneIds(split).filter((pane) => this.terminals.get(pane)?.info.mode === 'browser' && ownerOf(split, pane, this.isOwner) === id)
  }

  /** The terminal a browser belongs to (see `browsersOf`); null for a browser on its own. */
  browserOwner(id: string): string | null {
    if (this.terminals.get(id)?.info.mode !== 'browser') return null
    const split = this.splits.find((s) => hasPane(s, id))
    return split ? ownerOf(split, id, this.isOwner) : null
  }

  /** A terminal browsers can belong to: any but a browser. */
  private readonly isOwner = (pane: string): boolean => {
    const mode = this.terminals.get(pane)?.info.mode
    return mode !== undefined && mode !== 'browser'
  }

  /**
   * Gives the tab a name of its own; the session's title stays known (`autoTitle`). An empty title
   * lets the tab follow the session's title again. The name of a session tab is its session's name:
   * the session list and everything else shows it too (see SessionNames).
   */
  rename(id: string, title: string): void {
    const { info } = this.require(id)
    const next = title.replace(/\s+/g, ' ').trim().slice(0, 120)
    info.fixedTitle = next.length > 0
    info.title = next || info.autoTitle
    if (this.names && info.mode === 'session' && info.sessionId) this.names.set(info.sessionId, next || null)
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
  attach(id: string): TerminalAttach {
    const record = this.require(id)
    const answered = record.viewed
    record.viewed = true
    const { data, end } = this.buffer(id)
    // The modes set in output that is no longer kept, such as bracketed paste or the mouse.
    return { data: record.trimmed.prefix() + data, end, answered, ...record.ptySize }
  }

  /** The numbers of the images pasted into the tab's sessions (`[Image #N]`): sent ones and those kept when pasted. */
  async pastedImageIds(id: string): Promise<number[]> {
    const ids = new Set<number>(this.keptImages.ids(id))
    for (const { scan } of await this.pastedImageTranscripts(id)) for (const n of scan.images.keys()) ids.add(n)
    return [...ids].sort((a, b) => a - b)
  }

  /**
   * Image `n` pasted into the tab's session: the one the process sent; before it is sent, the copy kept
   * when it was pasted; else one with that number from before the session was resumed.
   */
  async pastedImage(id: string, n: number): Promise<PastedImage | null> {
    const transcripts = await this.pastedImageTranscripts(id)
    const record = this.terminals.get(id)
    if (!record) return null
    const since = Date.parse(record.info.createdAt)
    const found = choosePastedImage(transcripts, n, since)
    const read = async () => (found ? await readPastedImage(found.transcript.file, found.at, n).catch(() => null) : null)
    if (found && found.at.time >= since) {
      const src = await read()
      if (src) {
        // Sent: the copy isn't needed any more.
        this.keptImages.delete(id, n)
        return { src, sent: true }
      }
    }
    const kept = this.keptImages.get(id, n)
    if (kept) return { src: kept, sent: false }
    const src = found && found.at.time < since ? await read() : null
    return src ? { src, sent: true } : null
  }

  /** Keeps image `n` the user just pasted into the tab's session, until it is sent. */
  keepPastedImage(id: string, n: number, image: KeptImage): boolean {
    const record = this.terminals.get(id)
    if (!record || record.info.mode !== 'session') return false
    this.keptImages.keep(id, n, image)
    return true
  }

  /** The transcripts of the sessions of the tab's process, read up to now, the current session first. */
  private async pastedImageTranscripts(id: string): Promise<PastedImageTranscript[]> {
    const record = this.terminals.get(id)
    if (!record || record.info.mode !== 'session') return []
    let projectsDir: string
    try {
      projectsDir = this.accounts.paths(record.info.accountId).projectsDir
    } catch {
      return []
    }
    const transcripts: PastedImageTranscript[] = []
    for (const sessionId of [...record.sessionIds].reverse()) {
      let transcript = record.pastedImages.get(sessionId)
      // `/cd` took it along into the project folder of the new folder.
      if (transcript && !(await isFile(transcript.file))) transcript = undefined
      if (!transcript) {
        // Before the first prompt there is no transcript yet: looked for again next time.
        const file = await this.findTabTranscript(projectsDir, record, sessionId)
        if (!file) continue
        transcript = { file, scan: newPastedImageScan() }
        record.pastedImages.set(sessionId, transcript)
      }
      try {
        await scanPastedImages(transcript.file, transcript.scan)
      } catch {
        // Gone or being rewritten: what was read before still counts.
      }
      transcripts.push(transcript)
    }
    return transcripts
  }

  disposeAll(): void {
    clearInterval(this.trackTimer)
    if (this.changedTimer) clearTimeout(this.changedTimer)
    const sessions = [...this.terminals.values()].filter((t) => t.process && t.info.mode === 'session').map((t) => t.info)
    for (const id of [...this.terminals.keys()]) this.close(id)
    // The app quits before the processes have ended: their entries go now (see `withdrawBootEntry`).
    const byConfig = new Map<string, EndedLaunch[]>()
    for (const info of sessions) {
      const file = this.configFile(info)
      if (file) byConfig.set(file, [...(byConfig.get(file) ?? []), endedLaunch(info)])
    }
    for (const [file, launches] of byConfig) {
      try {
        withdrawBootEntriesSync(file, launches)
      } catch (error) {
        console.warn('[terminal] fullscreen start entries could not be removed', error)
      }
    }
  }

  /**
   * The app ended the session hard, so Claude Code had no chance to take out its entry for a
   * fullscreen start (see boot-canary). Ended in its first seconds, the next session would count it
   * as a failed start and fall back to the classic renderer.
   */
  private async withdrawBootEntry(info: TerminalInfo): Promise<void> {
    const file = this.configFile(info)
    if (!file) return
    try {
      await withdrawBootEntries(file, [endedLaunch(info)])
    } catch (error) {
      console.warn('[terminal] fullscreen start entry could not be removed', error)
    }
  }

  /** The global config of the session's account; null when the account is gone. */
  private configFile(info: TerminalInfo): string | null {
    try {
      return this.accounts.paths(info.accountId).globalConfigFile
    } catch {
      return null
    }
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
      this.switchSession(record, live.sessionId)
      changed = true
    }
    // Before the transcript: after `/cd` it is in the project folder of the new folder.
    if (live?.cwd && this.followFolder(record, live.cwd)) changed = true
    const transcript = info.sessionId ? await this.readTranscript(record, paths.projectsDir, info.sessionId) : null
    const limit = transcript ? currentLimit(transcript.limit) : null
    if (JSON.stringify(limit) !== JSON.stringify(info.limit)) {
      info.limit = limit
      changed = true
    }
    // From the start of the session: before its first answer with the model chosen in Claude Code and
    // no tokens yet. Where it compacts is read on every round: `/autocompact` changes it without a new answer.
    const reading = transcript?.context ?? null
    const context = { tokens: reading?.tokens ?? null, ...(await readCompactLimit(paths.configDir, reading?.model ?? null)) }
    if (JSON.stringify(context) !== JSON.stringify(info.context)) {
      info.context = context
      changed = true
    }
    const worktree = currentWorktree(transcript?.titles.worktree, live?.cwd ?? null, info.cwd, info.worktree)
    if (JSON.stringify(worktree) !== JSON.stringify(info.worktree)) {
      info.worktree = worktree
      changed = true
    }
    return followTitle(info, this.autoTitle(record)) || changed
  }

  /**
   * `/cd` moved the session to another folder, as Claude Code names it in `sessions/<pid>.json` (see
   * `movedTo`): the tab goes along, with its tree, branch, title, new shells beside it and the folder
   * it is restored or continued in. True when the tab's folder changed.
   */
  private followFolder(record: TerminalRecord, liveCwd: string): boolean {
    const folder = movedTo(record.liveCwd, liveCwd, record.info.cwd)
    record.liveCwd = liveCwd
    if (!folder) return false
    this.moveTab(record, folder)
    return true
  }

  /**
   * The app moved the session to the folder `cwd` while it didn't run (see SessionService.move): its
   * ended tabs go along, as with `/cd`, so they show it there and continue it there.
   */
  followMovedSession(accountId: string, sessionId: string, cwd: string): void {
    let changed = false
    for (const record of this.terminals.values()) {
      const { info } = record
      if (record.process || info.mode !== 'session' || info.accountId !== accountId) continue
      if ((info.sessionId ?? info.resumeSessionId) !== sessionId) continue
      this.moveTab(record, cwd)
      // Gone from the worktree, as `/cd` leaves it.
      info.worktree = null
      followTitle(info, this.autoTitle(record))
      changed = true
    }
    if (changed) this.emitChanged()
  }

  /** The tab's session works in `folder` now: the tab's tree, branch, title and new shells beside it go along. */
  private moveTab(record: TerminalRecord, folder: string): void {
    const { info } = record
    info.cwd = folder
    record.folders = [folder, ...record.folders.filter((f) => folderKey(f) !== folderKey(folder))]
    // Its transcript went along: looked for again in the new folder.
    record.transcript = null
    try {
      record.defaultTitle = defaultTerminalTitle(info.mode, this.accounts.get(info.authAccountId).name, folder)
    } catch {
      // The account is gone: the tab keeps its title.
    }
  }

  /**
   * The transcript of a session of the tab's process. It lies in the project folder of the folder
   * Claude Code works in (a worktree, or where `/cd` moved it); a session from before a `/clear` may
   * still lie in a folder the tab worked in before. Until the first prompt there is none: it is looked
   * for every round, in all projects only every `SEARCH_EVERYWHERE_MS`.
   */
  private async findTabTranscript(projectsDir: string, record: TerminalRecord, sessionId: string): Promise<string | null> {
    const seen = new Set<string>()
    for (const folder of [record.liveCwd, ...record.folders]) {
      if (!folder || seen.has(folderKey(folder))) continue
      seen.add(folderKey(folder))
      const file = await findTranscript(projectsDir, sessionId, folder, false)
      if (file) return file
    }
    const now = Date.now()
    if (now - record.searchedEverywhereAt < SEARCH_EVERYWHERE_MS) return null
    record.searchedEverywhereAt = now
    return findTranscript(projectsDir, sessionId)
  }

  /**
   * The tab's process works in another session now (`/clear`, `/resume`): with its name, if it has
   * one. The tab's own name goes to a session `/clear` started, not to one `/resume` opened.
   */
  private switchSession(record: TerminalRecord, sessionId: string): void {
    const first = record.info.sessionId === null
    const known = record.sessionIds.includes(sessionId)
    const since = record.sessionSince
    followSession(record, sessionId)
    record.sessionSince = Date.now()
    if (first) {
      this.shareName(record)
      return
    }
    const { info } = record
    // Another conversation: the last one's prompt and end are not this one's.
    info.prompt = null
    info.turn = null
    const name = this.names?.get(sessionId)
    if (name === undefined) return
    if (name !== null) {
      info.fixedTitle = true
      info.title = name
      return
    }
    if (!info.fixedTitle) return
    // It was in the tab before without a name: the name was removed, or it is one `/resume` opened.
    if (known) followSessionTitle(info)
    else void this.nameIfNew(record, sessionId, since)
  }

  /**
   * Gives the tab's name to the session it switched to if `/clear` started it: its transcript isn't
   * written yet, or began after the tab knew its previous session (`since`). A session `/resume`
   * opened keeps its own (missing) name: the tab follows its title instead.
   */
  private async nameIfNew(record: TerminalRecord, sessionId: string, since: number): Promise<void> {
    let startedAt: number | null
    try {
      const { projectsDir } = this.accounts.paths(record.info.accountId)
      const file = (await this.findTabTranscript(projectsDir, record, sessionId)) ?? (await findTranscript(projectsDir, sessionId))
      startedAt = file ? await readStartedAt(file) : null
    } catch {
      return
    }
    const { info } = record
    if (!this.names || info.sessionId !== sessionId || !info.fixedTitle || this.names.get(sessionId) !== null) return
    if (startedAt === null || startedAt >= since) {
      this.names.set(sessionId, info.title)
      return
    }
    followSessionTitle(info)
    this.emitChanged()
  }

  /**
   * The name of a session tab is the name of its session: a session with a name gives the tab that
   * name, a tab with a name of its own gives it to a session without one, also to the next one after
   * `/clear`, so the tab keeps its name. True when the tab's title changed.
   */
  private shareName(record: TerminalRecord): boolean {
    const { info } = record
    if (!this.names || info.mode !== 'session' || !info.sessionId) return false
    const name = this.names.get(info.sessionId)
    if (name === null) {
      if (info.fixedTitle) this.names.set(info.sessionId, info.title)
      return false
    }
    if (info.fixedTitle && info.title === name) return false
    info.fixedTitle = true
    info.title = name
    return true
  }

  /** The session was named (renamed in the session list) or lost its name: its tabs show it. */
  private applySessionName(sessionId: string, name: string | null): void {
    let changed = false
    for (const { info } of this.terminals.values()) {
      if (info.mode !== 'session' || info.sessionId?.toLowerCase() !== sessionId.toLowerCase()) continue
      const fixedTitle = name !== null
      const title = name ?? info.autoTitle
      if (info.fixedTitle === fixedTitle && info.title === title) continue
      info.fixedTitle = fixedTitle
      info.title = title
      changed = true
    }
    if (changed) this.emitChanged()
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
      const file = await this.findTabTranscript(projectsDir, record, sessionId)
      record.transcript = file
        ? { sessionId, file, size: -1, mtimeMs: -1, limit: null, context: null, titles: newTitleScan() }
        : null
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
      const context = await readContextUsage(tracked.file)
      // After a compaction the end may have no answer yet: the model stays the one before.
      if (context) tracked.context = { tokens: context.tokens, model: context.model ?? tracked.context?.model ?? null }
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
      info.turn = null
    } else if (record.hooks?.ended) {
      // The hooks told already how the turn ended, or that it waits for the user.
      record.turnEnding = false
      void this.settleIdle(record, run)
    } else {
      record.turnEnding = true
      void (record.hooks ? this.awaitHookEnd(record, run) : this.reportTurnEnd(record, run))
    }
    this.emitChanged()
  }

  /**
   * An event from the session's hooks (see SessionHooks): its session, what runs, and the end of its
   * turn or a wait for the user, right away. Once one came, the transcript is only read for an end
   * the hooks don't tell (Esc) and for a limit.
   */
  applyHook(id: string, call: HookCall): void {
    const record = this.terminals.get(id)
    if (!record || record.info.mode !== 'session' || record.info.status !== 'running') return
    const { info } = record
    const wasEnded = record.hooks?.ended === true
    const { state, end } = applyHookCall(record.hooks ?? newHookState(), call, new Date().toISOString())
    // The turn starts with the prompt; a short one may end before the title ever shows it.
    if (call.event.kind === 'prompt' && !info.busy) record.busySince = Date.now()
    let changed = !info.hooks
    info.hooks = true
    if (state.sessionId && state.sessionId !== info.sessionId) {
      this.switchSession(record, state.sessionId)
      changed = true
      // A new session (`/clear`): its title, worktree and limit.
      this.trackSoon()
    }
    if (call.event.kind === 'prompt') {
      info.prompt = call.event.prompt ?? null
      changed = true
    }
    // The session goes on (a prompt, an answered permission): how the last turn ended is past.
    if (info.turn && (call.event.kind === 'prompt' || (wasEnded && !state.ended))) {
      info.turn = null
      changed = true
    }
    const soon = this.showHookState(record, state)
    if (end) this.endTurnByHook(record, end)
    if (changed) this.emitChanged()
    else if (soon) this.emitChangedSoon()
  }

  /** Takes the hooks' state in: what runs shows in the tab. True when the tab shows something else now. */
  private showHookState(record: TerminalRecord, state: HookState): boolean {
    record.hooks = state
    const { info } = record
    let changed = false
    if (JSON.stringify(state.activity) !== JSON.stringify(info.activity)) {
      info.activity = state.activity
      changed = true
    }
    if (state.subagents.length !== info.subagents || state.compacting !== info.compacting) {
      info.subagents = state.subagents.length
      info.compacting = state.compacting
      changed = true
    }
    return changed
  }

  /** Tells the end of the turn (or the wait for the user) a hook reported; a lookup still running stops. */
  private endTurnByHook(record: TerminalRecord, end: HookTurnEnd): void {
    const run = ++record.turnEndRun
    record.turnEnding = false
    const since = record.busySince
    const busyMs = since ? Date.now() - since : 0
    if (end.kind !== 'limit') {
      this.finishTurn(record, { ...end, busyMs })
      return
    }
    // When the limit resets is only in the transcript, which Claude Code writes a little later.
    void this.reportLimit(record, run, end.detail, busyMs)
  }

  /** Waits until the transcript has the limit (for its reset time and the tab's notice), then tells it. */
  private async reportLimit(record: TerminalRecord, run: number, message: string | null, busyMs: number): Promise<void> {
    const start = Date.now()
    const current = () => run === record.turnEndRun && record.info.status === 'running' && this.terminals.has(record.info.id)
    while (current() && !record.info.limit && Date.now() - start < TURN_END_TIMEOUT_MS) {
      await delay(TURN_END_POLL_MS)
      try {
        if (await this.trackSession(record)) this.emitChanged()
      } catch {
        // The transcript is being rewritten: look again.
      }
    }
    if (!current()) return
    this.finishTurn(record, { kind: 'limit', tool: null, detail: record.info.limit?.message ?? message, busyMs })
  }

  /** Keeps how the turn ended in the tab (`TerminalInfo.turn`) and tells it: notifications, the unread dot. */
  private finishTurn(record: TerminalRecord, end: TurnEnd): void {
    record.info.turn = {
      kind: end.kind,
      tool: end.tool,
      detail: oneLine(end.kind === 'done' ? plainText(end.detail) : end.detail, MAX_TURN_DETAIL_CHARS),
      at: new Date().toISOString(),
    }
    this.emitChanged()
    this.emit('turnEnded', record.info.id, end)
  }

  /**
   * The title turned idle, but no hook told the end yet: it may come a moment later. Without it, the
   * turn was stopped (Esc ends no turn) or a hook failed, and the transcript tells which.
   */
  private async awaitHookEnd(record: TerminalRecord, run: number): Promise<void> {
    const idleAt = Date.now()
    if (!(await this.settleIdle(record, run))) return
    await this.reportTurnEnd(record, run, idleAt)
  }

  /**
   * Once Claude Code stays idle, nothing runs that the hooks didn't end: Esc stops a tool or a
   * compaction without telling (see `idleHookState`). False when it got busy again meanwhile.
   */
  private async settleIdle(record: TerminalRecord, run: number): Promise<boolean> {
    await delay(HOOK_END_GRACE_MS)
    if (run !== record.turnEndRun) return false
    if (record.hooks && this.showHookState(record, idleHookState(record.hooks))) this.emitChanged()
    return true
  }

  /** Tells once whether Claude Code is done, waits for the user or stopped at a limit. */
  private async reportTurnEnd(record: TerminalRecord, run: number, idleAt = Date.now()): Promise<void> {
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
      // Stopped by the user (Esc, or a permission declined): they are at the tab already. Its subagents stopped too.
      if (turn !== 'interrupted') this.finishTurn(record, { ...turn, busyMs: since ? idleAt - since : 0 })
      else if (record.hooks && this.showHookState(record, interruptedHookState(record.hooks))) this.emitChanged()
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
      const dropped = record.chunks.shift()!
      record.size -= dropped.length
      record.trimmed.trim(dropped)
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

  /**
   * The new terminal `id` takes half the part of `of`, in its tab, and follows it in the order. A part
   * split as often as a tab can be gets a tab of its own beside it instead.
   */
  private addPane(of: string, id: string, direction: SplitDirection): void {
    const ids = [...this.terminals.keys()].filter((key) => key !== id)
    ids.splice(ids.indexOf(of) + 1, 0, id)
    this.applyOrder(ids)
    const index = this.splits.findIndex((split) => paneIds(split).includes(of))
    if (index !== -1 && !canInsertPane(this.splits[index], of)) return
    if (index === -1) this.splits = [...this.splits, splitPane(of, of, id, direction) as PaneSplit]
    else this.splits = this.splits.map((split, i) => (i === index ? (splitPane(split, of, id, direction) as PaneSplit) : split))
  }

  private emitChanged(): void {
    if (this.changedTimer) {
      clearTimeout(this.changedTimer)
      this.changedTimer = null
    }
    this.emit('changed', this.list())
  }

  /** For changes that come many at a time, e.g. the tool that runs. */
  private emitChangedSoon(): void {
    this.changedTimer ??= setTimeout(() => this.emitChanged(), HOOK_CHANGES_MS)
  }
}

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

const isFile = (path: string) =>
  stat(path).then(
    (s) => s.isFile(),
    () => false,
  )

function endedLaunch(info: TerminalInfo): EndedLaunch {
  return { pid: info.pid, startedAt: Date.parse(info.createdAt) }
}

/** A limit also ends at its reset time, even if the transcript doesn't change. */
function currentLimit(limit: SessionLimit | null): SessionLimit | null {
  const resetsAt = limit?.resetsAt ? Date.parse(limit.resetsAt) : null
  return resetsAt !== null && resetsAt <= Date.now() ? null : limit
}

/**
 * The folder a tab in `tabCwd` moves to when Claude Code names `liveCwd` for its session after
 * `previousLive`; null when it stays. The first report is where the session started (Claude Code may
 * spell it differently): only a change after it is a move. Into a worktree of the tab's folder and
 * back (`--worktree`, EnterWorktree, ExitWorktree) the tab stays, with the worktree beside it.
 */
export function movedTo(previousLive: string | null, liveCwd: string, tabCwd: string): string | null {
  if (previousLive === null || folderKey(previousLive) === folderKey(liveCwd)) return null
  if (folderKey(liveCwd) === folderKey(tabCwd) || isWorktreeOf(liveCwd, tabCwd)) return null
  return liveCwd
}

/**
 * The worktree a session works in. The transcript knows it with its branch, but only once the first
 * prompt is written; until then the folder from `sessions/<pid>.json` tells it. That folder also tells
 * when the session left it with `/cd`, which the transcript doesn't. Without either (e.g. just after
 * `/clear` with an older Claude Code) the tab keeps what it had.
 */
export function currentWorktree(
  scanned: SessionWorktree | null | undefined,
  liveCwd: string | null,
  startCwd: string,
  previous: SessionWorktree | null,
): SessionWorktree | null {
  if (liveCwd) return scanned && inFolder(liveCwd, scanned.path) ? scanned : worktreeAt(liveCwd, startCwd)
  if (scanned) return scanned
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
    trimmed: new TrimmedModes(),
    ptySize: { cols: process?.cols ?? 80, rows: process?.rows ?? 24 },
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
    hooks: null,
    sessionIds: info.sessionId ? [info.sessionId] : [],
    sessionSince: Date.now(),
    liveCwd: null,
    folders: info.cwd ? [info.cwd] : [],
    pastedImages: new Map(),
    searchedEverywhereAt: 0,
  }
}

/** The tab drops its name and shows its session's title (it comes with the next round). */
function followSessionTitle(info: TerminalInfo): void {
  info.fixedTitle = false
  info.title = info.autoTitle
}

/** The tab's session is now `sessionId`; the sessions the process had before stay known. */
function followSession(record: TerminalRecord, sessionId: string): void {
  record.info.sessionId = sessionId
  if (!record.sessionIds.includes(sessionId)) record.sessionIds.push(sessionId)
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

/**
 * Tab title when none was given: the folder. The account (the one whose limits the tab uses) shows as
 * the tab's colour and in its card, not in the title; only a login is about it.
 */
export function defaultTerminalTitle(mode: TerminalInfo['mode'], accountName: string, cwd: string): string {
  if (mode === 'login') return `Anmeldung · ${accountName}`
  if (mode === 'browser') return fallbackTitle(null)
  const folder = basename(cwd) || cwd
  return mode === 'shell' ? `Shell · ${folder}` : folder
}

/** The default title of older versions, with the account in it: a saved tab with it had no name of its own. */
export function legacyTerminalTitle(mode: TerminalInfo['mode'], accountName: string, cwd: string): string {
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
