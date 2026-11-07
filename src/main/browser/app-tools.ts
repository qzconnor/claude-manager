import { existsSync, statSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import type { Account, AccountUsage, ClaudeSettings, SessionSummary, TerminalInfo, TranscriptMessage, UsageWindow } from '@shared/types'
import type { AccountService } from '../services/account-service'
import type { SessionService } from '../services/session-service'
import type { SettingsService } from '../services/settings-service'
import type { TerminalService } from '../services/terminal-service'
import type { UsageService } from '../services/usage-service'
import type { McpTool, McpToolResult } from './mcp-protocol'

/**
 * Tools of the app's MCP server for Claude Manager itself (next to the browser's): a session reads
 * the limits of its account, searches and reads earlier sessions, and drives shell tabs it opened.
 * Each group has a switch in the settings (tab "Werkzeuge"); the shells are off by default, since
 * what runs in them is outside Claude Code's permissions.
 */

type Args = Record<string, unknown>

/** The switches of the settings the tools belong to. */
export type AppToolGroup = 'limits' | 'sessions' | 'shell'

/** An error for Claude: it ends up in the tool's result. */
export class AppToolError extends Error {}

const MAX_SEARCH_RESULTS = 50
const DEFAULT_SEARCH_RESULTS = 10
const MAX_TRANSCRIPT_CHARS = 30_000
const MAX_MESSAGE_CHARS = 4000
const DEFAULT_READ_MESSAGES = 40
const MAX_READ_MESSAGES = 200
/** Output of a shell Claude gets at most at once; the end is kept. */
const MAX_OUTPUT_CHARS = 20_000
/** Raw output looked at for one result: plenty for MAX_OUTPUT_CHARS of text. */
const MAX_RAW_CHARS = 400_000
const MAX_WAIT_SECONDS = 60
/** Without waitFor, input counts as answered once the shell has been quiet this long. */
const QUIET_MS = 1500
const DEFAULT_QUIET_WAIT_SECONDS = 10
const DEFAULT_TEXT_WAIT_SECONDS = 30

const SETTING_LABELS: Record<AppToolGroup, string> = {
  limits: 'Eigene Limits lesen',
  sessions: 'Sessions durchsuchen',
  shell: 'Shell-Tabs steuern',
}

/** The groups the settings switch on. */
export function enabledAppGroups(claude: ClaudeSettings): Set<AppToolGroup> {
  const groups = new Set<AppToolGroup>()
  if (claude.limitsTool) groups.add('limits')
  if (claude.sessionsTool) groups.add('sessions')
  if (claude.shellTools) groups.add('shell')
  return groups
}

/** The groups whose tools Claude Code may use without asking (`--allowedTools`): reading always, shells when allowed. */
export function allowedAppGroups(claude: ClaudeSettings): Set<AppToolGroup> {
  const groups = enabledAppGroups(claude)
  if (!claude.shellToolsAllowed) groups.delete('shell')
  return groups
}

/** What the server tells Claude about the tools of these groups. */
export function appInstructions(groups: ReadonlySet<AppToolGroup>): string {
  const lines = ['Claude Manager, the app this session runs in, also gives you tools for the app itself:']
  if (groups.has('limits')) lines.push('- limits: how much of the usage limits of your account is used and when they reset; check it before long tasks.')
  if (groups.has('sessions')) {
    lines.push('- sessions_search and session_read: earlier Claude Code sessions of the user, e.g. to look up how something was solved or decided before.')
  }
  if (groups.has('shell')) {
    lines.push(
      '- shell_open, shell_input, shell_output, shell_list, shell_close: shell tabs next to this session that the user sees. Use them for processes that keep running (dev servers, watchers) and read their output later; for one-off commands keep using your own shell tool.',
    )
  }
  return lines.join('\n')
}

// --- tools -------------------------------------------------------------------

interface AppToolDefinition<P> {
  name: string
  title: string
  description: string
  properties: Record<string, unknown>
  required?: string[]
  group: AppToolGroup
  readOnly?: boolean
  destructive?: boolean
  parse(args: Args): P
  run(tools: AppTools, session: TerminalInfo, params: P): Promise<string>
}

function tool<P>(definition: AppToolDefinition<P>): AppToolDefinition<never> {
  return definition as unknown as AppToolDefinition<never>
}

const shellId = { type: 'number', description: 'The id of the shell, from shell_open or shell_list.' }
const waitFor = { type: 'string', description: 'Wait until this text appears in the new output, e.g. "ready" or "Local:".' }
const timeout = { type: 'number', description: `Seconds to wait at most (1–${MAX_WAIT_SECONDS}).` }

const TOOLS: AppToolDefinition<never>[] = [
  tool({
    name: 'limits',
    title: 'Usage limits',
    description:
      'The usage limits of the Claude account this session runs on: how much of the 5-hour window and of the weekly limits is used, and when they reset. Also the other accounts in Claude Manager. Check it before long tasks.',
    properties: {},
    group: 'limits',
    readOnly: true,
    parse: () => ({}),
    run: async (tools, session) => tools.limits(session),
  }),
  tool({
    name: 'sessions_search',
    title: 'Search earlier sessions',
    description:
      "Searches the conversations of the user's earlier Claude Code sessions (all accounts in Claude Manager) for words, newest first; with folder only the sessions in that folder or below, with folder alone the newest sessions there. Read one with session_read.",
    properties: {
      query: { type: 'string', description: 'Words that all have to occur in the conversation.' },
      folder: { type: 'string', description: 'Only sessions that ran in this folder or below (absolute path).' },
      limit: { type: 'number', description: `How many sessions at most (1–${MAX_SEARCH_RESULTS}, default ${DEFAULT_SEARCH_RESULTS}).` },
    },
    group: 'sessions',
    readOnly: true,
    parse: parseSearch,
    run: async (tools, session, p) => tools.searchSessions(session, p),
  }),
  tool({
    name: 'session_read',
    title: 'Read an earlier session',
    description:
      "Reads the conversation of an earlier session: the user's and Claude's messages, with each tool call as one line. Long sessions come in parts: offset counts messages from the start, a negative one from the end (-20: the last 20).",
    properties: {
      sessionId: { type: 'string', description: 'The session, from sessions_search.' },
      accountId: { type: 'string', description: 'The account of the session, from sessions_search (optional).' },
      offset: { type: 'number', description: 'The first message to read (default 0); negative: counted from the end.' },
      limit: { type: 'number', description: `How many messages at most (1–${MAX_READ_MESSAGES}, default ${DEFAULT_READ_MESSAGES}).` },
    },
    required: ['sessionId'],
    group: 'sessions',
    readOnly: true,
    parse: parseRead,
    run: async (tools, session, p) => tools.readSession(session, p),
  }),
  tool({
    name: 'shell_open',
    title: 'Open a shell tab',
    description:
      "Opens a shell tab next to this session in Claude Manager, where the user sees it, optionally runs a command in it and returns the output. Meant for processes that keep running, e.g. a dev server or a watcher. It is the user's shell (PowerShell on Windows): the result names it, mind its syntax.",
    properties: {
      command: { type: 'string', description: 'A command to run right away, e.g. "npm run dev".' },
      cwd: { type: 'string', description: 'The folder to start in (absolute path); default: the folder of this session.' },
      title: { type: 'string', description: 'A name for the tab, e.g. "Dev server".' },
      waitFor,
      timeout,
    },
    group: 'shell',
    parse: parseOpen,
    run: async (tools, session, p) => tools.openShell(session, p),
  }),
  tool({
    name: 'shell_input',
    title: 'Type into a shell',
    description:
      'Types text into one of your shell tabs and presses Enter (unless enter is false), then returns the new output: once waitFor appeared, or once the shell is quiet for a moment. Each line of the text is entered like typed. "\\u0003" is Ctrl+C: it stops the running command.',
    properties: {
      id: shellId,
      text: { type: 'string', description: 'What to type, e.g. a command.' },
      enter: { type: 'boolean', description: 'Press Enter after the text (default true).' },
      waitFor,
      timeout,
    },
    required: ['id', 'text'],
    group: 'shell',
    parse: parseInput,
    run: async (tools, session, p) => tools.shellInput(session, p),
  }),
  tool({
    name: 'shell_output',
    title: 'Read a shell',
    description:
      'The output of one of your shell tabs: what is new since you last read it, or its last lines (tail). With waitFor it first waits until that text appears, e.g. the "ready" of a dev server.',
    properties: {
      id: shellId,
      tail: { type: 'number', description: 'Instead of the new output: the last lines of all output (1–2000).' },
      waitFor,
      timeout,
    },
    required: ['id'],
    group: 'shell',
    readOnly: true,
    parse: parseOutput,
    run: async (tools, session, p) => tools.shellOutput(session, p),
  }),
  tool({
    name: 'shell_list',
    title: 'List your shells',
    description: 'The shell tabs you opened: id, folder, whether they still run, and how much output you have not read yet.',
    properties: {},
    group: 'shell',
    readOnly: true,
    parse: () => ({}),
    run: async (tools, session) => tools.listShells(session),
  }),
  tool({
    name: 'shell_close',
    title: 'Close a shell tab',
    description: 'Closes one of your shell tabs and ends what runs in it.',
    properties: { id: shellId },
    required: ['id'],
    group: 'shell',
    destructive: true,
    parse: (args) => ({ id: shellIdOf(args) }),
    run: async (tools, session, p) => tools.closeShell(session, p.id),
  }),
]

/** The names of the tools of these groups. */
export function appToolNames(groups: ReadonlySet<AppToolGroup>): string[] {
  return TOOLS.filter((t) => groups.has(t.group)).map((t) => t.name)
}

/** The group of a tool of the app; null for other names (e.g. the browser's). */
export function appToolGroup(name: string): AppToolGroup | null {
  return TOOLS.find((t) => t.name === name)?.group ?? null
}

/** Checks a tool's arguments as its call does (for tests). */
export function parseAppToolArgs(name: string, args: Args): unknown {
  const definition = TOOLS.find((t) => t.name === name) as AppToolDefinition<unknown> | undefined
  if (!definition) throw new AppToolError(`Unknown tool: ${name}`)
  return definition.parse(args)
}

// --- the tools' work ---------------------------------------------------------

export interface AppToolsDeps {
  terminals: TerminalService
  usage: UsageService
  sessions: SessionService
  accounts: AccountService
  settings: SettingsService
}

/** A shell tab a session opened, and how far Claude has read its output. */
interface Shell {
  id: number
  terminalId: string
  sessionId: string
  /** Stream offset of the output Claude has not read yet. */
  readFrom: number
}

export class AppTools {
  private readonly shells = new Map<string, Shell>()
  private readonly nextShellId = new Map<string, number>()

  constructor(private readonly deps: AppToolsDeps) {
    deps.terminals.on('changed', (list) => {
      const open = new Set(list.map((t) => t.id))
      for (const [id, shell] of [...this.shells]) if (!open.has(id) || !open.has(shell.sessionId)) this.shells.delete(id)
      for (const session of [...this.nextShellId.keys()]) if (!open.has(session)) this.nextShellId.delete(session)
    })
  }

  list(groups: ReadonlySet<AppToolGroup>): McpTool[] {
    return TOOLS.filter((t) => groups.has(t.group)).map((t) => ({
      name: t.name,
      title: t.title,
      description: t.description,
      inputSchema: { type: 'object', properties: t.properties, ...(t.required ? { required: t.required } : {}), additionalProperties: false },
      annotations: { title: t.title, readOnlyHint: t.readOnly === true, destructiveHint: t.destructive === true, openWorldHint: false },
    }))
  }

  /** Whether `name` is one of the app's tools (switched on or not). */
  has(name: string): boolean {
    return appToolGroup(name) !== null
  }

  async call(sessionId: string, name: string, args: Args): Promise<McpToolResult> {
    const definition = TOOLS.find((t) => t.name === name) as AppToolDefinition<unknown> | undefined
    if (!definition) throw new AppToolError(`Unknown tool: ${name}`)
    if (!enabledAppGroups(this.deps.settings.get().claude).has(definition.group)) {
      throw new AppToolError(
        `The user turned "${SETTING_LABELS[definition.group]}" off in the settings of Claude Manager (Einstellungen › Werkzeuge).`,
      )
    }
    const session = this.deps.terminals.list().find((t) => t.id === sessionId)
    if (!session) throw new AppToolError('This session is no longer open in Claude Manager.')
    const params = definition.parse(args)
    const text = await definition.run(this, session, params)
    return { content: [{ type: 'text', text }] }
  }

  // --- limits ---

  limits(session: TerminalInfo): string {
    const accounts = this.deps.accounts.list()
    const usage = this.deps.usage.getAll()
    const accountId = session.authAccountId || session.accountId
    return formatLimits({
      account: accounts.find((a) => a.id === accountId) ?? null,
      filesAccount: session.authAccountId && session.authAccountId !== session.accountId ? (accounts.find((a) => a.id === session.accountId) ?? null) : null,
      usage: usage.find((u) => u.accountId === accountId) ?? null,
      others: accounts.filter((a) => a.id !== accountId).map((a) => ({ account: a, usage: usage.find((u) => u.accountId === a.id) ?? null })),
      sessionLimit: session.limit,
      autoSwitch: this.deps.settings.get().claude.autoSwitch,
      now: Date.now(),
    })
  }

  // --- sessions ---

  async searchSessions(session: TerminalInfo, p: SearchParams): Promise<string> {
    const [groups, hits] = await Promise.all([this.deps.sessions.list(), p.query ? this.deps.sessions.search(p.query) : Promise.resolve(null)])
    const summaries = new Map<string, SessionSummary>()
    for (const group of groups) for (const summary of group.sessions) summaries.set(`${group.accountId}:${summary.id}`, summary)
    const names = new Map(this.deps.accounts.list().map((a) => [a.id, a.name]))
    const own = (s: SessionSummary) => s.id === session.sessionId
    const inFolder = (s: SessionSummary) => !p.folder || (s.cwd !== null && insideFolder(s.cwd, p.folder))

    let found: { summary: SessionSummary; snippet: string | null; role: string | null }[]
    if (hits) {
      found = hits
        .map((hit) => ({ summary: summaries.get(`${hit.accountId}:${hit.sessionId}`), snippet: hit.snippet, role: hit.role }))
        .filter((f): f is { summary: SessionSummary; snippet: string; role: 'user' | 'assistant' } => !!f.summary)
    } else {
      found = [...summaries.values()].map((summary) => ({ summary, snippet: null, role: null }))
    }
    found = found.filter((f) => !own(f.summary) && inFolder(f.summary))
    found.sort((a, b) => b.summary.updatedAt.localeCompare(a.summary.updatedAt))
    const what = [p.query ? `match ${JSON.stringify(p.query)}` : null, p.folder ? `ran in ${p.folder} or below` : null].filter(Boolean).join(' and ')
    if (found.length === 0) return `No earlier sessions ${what || 'found'}.`
    const shown = found.slice(0, p.limit)
    const lines = shown.map((f, index) => {
      const s = f.summary
      const head = `${index + 1}. ${JSON.stringify(cut(s.title, 120))}`
      const where = [s.cwd ?? 'folder unknown', s.gitBranch ? `branch ${s.gitBranch}` : null].filter(Boolean).join(', ')
      const facts = `${names.get(s.accountId) ?? s.accountId}, last active ${localTime(s.updatedAt)}, ${s.messageCount}${s.messageCountExact ? '' : '+'} messages`
      const parts = [head, `   ${where}; ${facts}`, `   sessionId: ${s.id}, accountId: ${s.accountId}`]
      if (f.snippet) parts.push(`   ${f.role}: ${JSON.stringify(cut(f.snippet, 300))}`)
      return parts.join('\n')
    })
    const more = found.length > shown.length ? ` (showing the newest ${shown.length})` : ''
    return `${found.length} earlier session(s) ${what}${more}, newest first:\n${lines.join('\n')}\n\nRead one with session_read.`
  }

  async readSession(session: TerminalInfo, p: ReadParams): Promise<string> {
    let accountId = p.accountId
    if (!accountId) {
      const groups = await this.deps.sessions.list()
      accountId = groups.find((g) => g.sessions.some((s) => s.id === p.sessionId))?.accountId
      if (!accountId) throw new AppToolError(`There is no session ${p.sessionId}. Find sessions with sessions_search.`)
    }
    let detail
    try {
      detail = await this.deps.sessions.get(accountId, p.sessionId)
    } catch {
      throw new AppToolError(`There is no session ${p.sessionId} in account ${accountId}. Find sessions with sessions_search.`)
    }
    const name = this.deps.accounts.list().find((a) => a.id === accountId)?.name ?? accountId
    const own = p.sessionId === session.sessionId ? ' This is your current session.' : ''
    const s = detail.summary
    const head = [
      `Session ${JSON.stringify(s.title)} (${s.id}), account ${name}.${own}`,
      `Folder: ${s.cwd ?? 'unknown'}${s.gitBranch ? `, branch ${s.gitBranch}` : ''}; started ${localTime(s.createdAt)}, last active ${localTime(s.updatedAt)}.`,
    ].join('\n')
    return `${head}\n${formatTranscript(detail.messages, p.offset, p.limit, detail.truncated)}`
  }

  // --- shells ---

  async openShell(session: TerminalInfo, p: OpenParams): Promise<string> {
    const cwd = p.cwd ?? session.cwd
    if (p.cwd !== undefined && !isDirectory(p.cwd)) throw new AppToolError(`No such folder: ${p.cwd}`)
    const { terminals } = this.deps
    const open = new Set(terminals.list().map((t) => t.id))
    const last = [...this.shells.values()].filter((s) => s.sessionId === session.id && open.has(s.terminalId)).pop()
    let info: TerminalInfo
    try {
      info = terminals.create({
        accountId: session.accountId,
        authAccountId: session.authAccountId || null,
        mode: 'shell',
        cwd: cwd || null,
        // The user tells the tab by what runs in it.
        title: p.title ?? (p.command ? cut(p.command.trim().split(/\r?\n/)[0], 60) : null),
        split: { terminalId: last?.terminalId ?? session.id, direction: 'column' },
      })
    } catch (error) {
      throw new AppToolError(`The shell could not start: ${error instanceof Error ? error.message : String(error)}`)
    }
    const id = (this.nextShellId.get(session.id) ?? 0) + 1
    this.nextShellId.set(session.id, id)
    const shell: Shell = { id, terminalId: info.id, sessionId: session.id, readFrom: 0 }
    this.shells.set(info.id, shell)

    // The shell's banner and first prompt, before the command goes in.
    const started = await this.collect(info.id, 0, { quietMs: QUIET_MS, timeoutMs: DEFAULT_QUIET_WAIT_SECONDS * 1000 })
    let output = started.raw
    let note = ''
    if (p.command && !started.exited) {
      const typed = await this.type(shell, p.command, true, p.waitFor, p.timeout)
      output += typed.raw
      note = typed.note
    }
    shell.readFrom = terminals.buffer(info.id).end
    const name = shellName(info.commandLine)
    const head = `Opened shell ${id} (${name}) in ${info.cwd}, below ${last ? 'your last shell' : 'this session'}.${p.command ? ` Ran ${JSON.stringify(p.command)}.` : ''}`
    return `${head}${note}${this.status(info.id)}\n\nOutput:\n${outputText(output)}`
  }

  async shellInput(session: TerminalInfo, p: InputParams): Promise<string> {
    const shell = this.shell(session, p.id)
    this.requireRunning(shell)
    const typed = await this.type(shell, p.text, p.enter, p.waitFor, p.timeout)
    shell.readFrom = this.deps.terminals.buffer(shell.terminalId).end
    const what = p.text === '\u0003' ? 'Pressed Ctrl+C' : `Typed ${JSON.stringify(cut(p.text, 200))}${p.enter ? ' and pressed Enter' : ''}`
    return `${what} in shell ${shell.id}.${typed.note}${this.status(shell.terminalId)}\n\nNew output:\n${outputText(typed.raw)}`
  }

  async shellOutput(session: TerminalInfo, p: OutputParams): Promise<string> {
    const shell = this.shell(session, p.id)
    const { terminals } = this.deps
    let note = ''
    if (p.waitFor) {
      const unread = rawSince(terminals.buffer(shell.terminalId), shell.readFrom)
      if (!terminalText(unread).includes(p.waitFor)) {
        const start = terminals.buffer(shell.terminalId).end
        const waited = await this.collect(shell.terminalId, start, { waitFor: p.waitFor, timeoutMs: (p.timeout ?? DEFAULT_TEXT_WAIT_SECONDS) * 1000, unread })
        note = waitNote(p.waitFor, waited, p.timeout ?? DEFAULT_TEXT_WAIT_SECONDS)
      }
    }
    const buffer = terminals.buffer(shell.terminalId)
    let text: string
    let what: string
    if (p.tail !== undefined) {
      text = lastLines(terminalText(buffer.data.slice(-MAX_RAW_CHARS)), p.tail)
      what = `The last ${p.tail} line(s)`
    } else {
      text = outputText(rawSince(buffer, shell.readFrom))
      what = 'New output since you last read it'
    }
    shell.readFrom = buffer.end
    return `Shell ${shell.id}${this.status(shell.terminalId, true)}${note}\n\n${what}:\n${text || '(none)'}`
  }

  listShells(session: TerminalInfo): string {
    const terminals = new Map(this.deps.terminals.list().map((t) => [t.id, t]))
    const mine = [...this.shells.values()].filter((s) => s.sessionId === session.id && terminals.has(s.terminalId))
    if (mine.length === 0) return 'You have no shell tabs open. Open one with shell_open.'
    const lines = mine.map((shell) => {
      const info = terminals.get(shell.terminalId)!
      const unread = terminalText(rawSince(this.deps.terminals.buffer(shell.terminalId), shell.readFrom)).trim()
      const unreadLines = unread ? unread.split('\n').length : 0
      const state = info.status === 'running' ? 'running' : `exited with code ${info.exitCode ?? '?'}`
      return `- ${shell.id}: ${JSON.stringify(info.title)}, ${shellName(info.commandLine)} in ${info.cwd}, ${state}, ${unreadLines} unread line(s)`
    })
    return `Your shell tabs:\n${lines.join('\n')}`
  }

  closeShell(session: TerminalInfo, id: number): string {
    const shell = this.shell(session, id)
    this.deps.terminals.close(shell.terminalId)
    this.shells.delete(shell.terminalId)
    return `Closed shell ${id}.`
  }

  /** One of the session's shells; others, also those of the user, are out of reach. */
  private shell(session: TerminalInfo, id: number): Shell {
    const open = new Set(this.deps.terminals.list().map((t) => t.id))
    const mine = [...this.shells.values()].filter((s) => s.sessionId === session.id && open.has(s.terminalId))
    const shell = mine.find((s) => s.id === id)
    if (!shell) {
      throw new AppToolError(
        mine.length ? `You have no shell ${id}; yours are ${mine.map((s) => s.id).join(', ')}.` : 'You have no shell tabs open. Open one with shell_open.',
      )
    }
    return shell
  }

  private requireRunning(shell: Shell): void {
    const info = this.deps.terminals.list().find((t) => t.id === shell.terminalId)
    if (info?.status !== 'running') throw new AppToolError(`Shell ${shell.id} has ended (exit code ${info?.exitCode ?? '?'}). Open another one with shell_open.`)
  }

  /** ", running" or ", ended with exit code 1", for a result. */
  private status(terminalId: string, always = false): string {
    const info = this.deps.terminals.list().find((t) => t.id === terminalId)
    if (!info) return ' The tab is closed.'
    if (info.status === 'running') return always ? ' (running)' : ''
    return ` The shell has ended (exit code ${info.exitCode ?? '?'}).`
  }

  /** Types into the shell and waits for its answer (see `collect`). */
  private async type(shell: Shell, text: string, enter: boolean, waitFor: string | undefined, timeoutSeconds: number | undefined) {
    const { terminals } = this.deps
    const start = terminals.buffer(shell.terminalId).end
    const data = text.replace(/\r?\n/g, '\r') + (enter ? '\r' : '')
    const waiting = this.collect(shell.terminalId, start, {
      waitFor,
      quietMs: waitFor ? undefined : QUIET_MS,
      timeoutMs: (timeoutSeconds ?? (waitFor ? DEFAULT_TEXT_WAIT_SECONDS : DEFAULT_QUIET_WAIT_SECONDS)) * 1000,
    })
    if (data) terminals.write(shell.terminalId, data)
    const result = await waiting
    return { raw: result.raw, note: waitFor ? waitNote(waitFor, result, timeoutSeconds ?? DEFAULT_TEXT_WAIT_SECONDS) : '' }
  }

  /**
   * The terminal's output from stream offset `start` on, until `waitFor` appears in it (also in
   * `unread`, output before `start`), the output has been quiet for `quietMs` after it began, the
   * process ends or `timeoutMs` is over.
   */
  private collect(
    terminalId: string,
    start: number,
    options: { waitFor?: string; quietMs?: number; timeoutMs: number; unread?: string },
  ): Promise<CollectResult> {
    const { terminals } = this.deps
    return new Promise((resolve) => {
      const buffer = terminals.buffer(terminalId)
      let raw = rawSince(buffer, start)
      /** Stream offset right after what `raw` holds. */
      let end = buffer.end
      let settled = false
      let quietTimer: NodeJS.Timeout | undefined
      const finish = (found: boolean, exited = false) => {
        if (settled) return
        settled = true
        clearTimeout(quietTimer)
        clearTimeout(deadline)
        offData()
        offExit()
        resolve({ raw, found, exited })
      }
      const check = () => {
        if (options.waitFor !== undefined) {
          if (terminalText((options.unread ?? '') + raw.slice(-MAX_RAW_CHARS)).includes(options.waitFor)) finish(true)
        } else if (options.quietMs !== undefined && raw !== '') {
          // Quiet counts from the first output on: a shell may take a moment to answer at all.
          clearTimeout(quietTimer)
          quietTimer = setTimeout(() => finish(false), options.quietMs)
        }
      }
      const offData = terminals.on('data', (id, data, offset) => {
        if (id !== terminalId) return
        if (offset + data.length <= end) return
        raw += data.slice(Math.max(0, end - offset))
        end = offset + data.length
        check()
      })
      const offExit = terminals.on('exit', (id) => {
        if (id === terminalId) setTimeout(() => finish(false, true), 100)
      })
      const deadline = setTimeout(() => finish(false), options.timeoutMs)
      check()
    })
  }
}

interface CollectResult {
  raw: string
  /** waitFor appeared. */
  found: boolean
  exited: boolean
}

function waitNote(text: string, result: CollectResult, seconds: number): string {
  if (result.found) return ` ${JSON.stringify(text)} appeared.`
  if (result.exited) return ` The shell ended before ${JSON.stringify(text)} appeared.`
  return ` ${JSON.stringify(text)} did not appear within ${seconds} s.`
}

/** The raw output from stream offset `from` on (what is still in the buffer). */
function rawSince(buffer: { data: string; end: number }, from: number): string {
  const start = buffer.end - buffer.data.length
  return buffer.data.slice(Math.max(0, from - start)).slice(-MAX_RAW_CHARS)
}

/** Output for a result: as text, the end of it when it is long. */
function outputText(raw: string): string {
  const text = terminalText(raw)
  if (!text) return '(none)'
  return text.length > MAX_OUTPUT_CHARS ? `… (earlier output cut)\n${text.slice(-MAX_OUTPUT_CHARS)}` : text
}

function lastLines(text: string, count: number): string {
  const lines = text.split('\n')
  const kept = lines.slice(-count).join('\n')
  return kept.length > MAX_OUTPUT_CHARS ? `… (cut)\n${kept.slice(-MAX_OUTPUT_CHARS)}` : kept
}

function isDirectory(path: string): boolean {
  try {
    return existsSync(path) && statSync(path).isDirectory()
  } catch {
    return false
  }
}

// --- formatting (exported for tests) -------------------------------------------

/** The shell of a terminal's command line, for Claude to pick the syntax. */
export function shellName(commandLine: string): string {
  const first = commandLine.trim().startsWith('"') ? commandLine.trim().slice(1).split('"')[0] : commandLine.trim().split(/\s+/)[0]
  const file = (first.split(/[\\/]/).pop() ?? '').toLowerCase().replace(/\.exe$/, '')
  if (file === 'pwsh') return 'PowerShell 7 (pwsh)'
  if (file === 'powershell') return 'Windows PowerShell 5.1'
  if (file === 'cmd') return 'cmd'
  return file || 'shell'
}

/** Whether `path` is `folder` or inside it; Windows paths compare without case. */
export function insideFolder(path: string, folder: string, platform = process.platform): boolean {
  const norm = (p: string) => {
    let out = p.trim().replace(/\\/g, '/').replace(/\/+$/, '')
    if (platform === 'win32') out = out.toLowerCase()
    return out
  }
  const a = norm(path)
  const b = norm(folder)
  return b !== '' && (a === b || a.startsWith(`${b}/`))
}

/** A time for Claude: local date and time. */
export function localTime(iso: string | null, now?: number): string {
  if (!iso) return 'unknown'
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return 'unknown'
  const pad = (n: number) => String(n).padStart(2, '0')
  const text = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
  return now === undefined ? text : `${text} (${relative(date.getTime() - now)})`
}

/** "in 1 h 40 min", "3 min ago". */
export function relative(ms: number): string {
  const past = ms < 0
  const minutes = Math.round(Math.abs(ms) / 60_000)
  if (minutes < 1) return 'now'
  const days = Math.floor(minutes / 1440)
  const hours = Math.floor((minutes % 1440) / 60)
  const mins = minutes % 60
  const span = days > 0 ? `${days} d${hours ? ` ${hours} h` : ''}` : hours > 0 ? `${hours} h${mins ? ` ${mins} min` : ''}` : `${mins} min`
  return past ? `${span} ago` : `in ${span}`
}

/** An English name for a limit window (the app's labels are German). */
export function windowName(window: UsageWindow): string {
  if (window.key === 'five_hour') return '5-hour window'
  if (window.key === 'seven_day') return 'Week, all models'
  if (window.key === 'seven_day_opus') return 'Week, Opus'
  if (window.key === 'seven_day_sonnet') return 'Week, Sonnet'
  const [kind, model] = window.key.split(':')
  if (model) return /week/i.test(kind) ? `Week, ${model}` : `${kind.replace(/_/g, ' ')}, ${model}`
  return window.label
}

export interface LimitsInput {
  account: Account | null
  /** The account whose files the session uses, when its limits come from another one. */
  filesAccount: Account | null
  usage: AccountUsage | null
  others: { account: Account; usage: AccountUsage | null }[]
  sessionLimit: TerminalInfo['limit']
  autoSwitch: boolean
  now: number
}

const SOURCES: Record<AccountUsage['source'], string> = {
  live: 'live from Anthropic',
  'claude-cache': "from Claude Code's cache",
  none: 'no numbers yet',
}

export function formatLimits(input: LimitsInput): string {
  const { account, usage, now } = input
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone
  const name = account?.name ?? 'unknown account'
  const lines: string[] = []
  const borrowed = input.filesAccount ? ` (its files are those of ${input.filesAccount.name})` : ''
  lines.push(`This session runs on the account ${JSON.stringify(name)}${borrowed}. Times are local (${zone}).`)
  if (input.sessionLimit) {
    const reset = input.sessionLimit.resetsAt ? `, resets ${localTime(input.sessionLimit.resetsAt, now)}` : ''
    lines.push(`This session is stopped at a usage limit right now${reset}: ${input.sessionLimit.message}`)
  }
  if (!usage) {
    lines.push('Claude Manager has no usage numbers for it.')
  } else {
    if (usage.status !== 'ok') lines.push(`Status: ${usage.status}${usage.message ? ` (${usage.message})` : ''}.`)
    const windows = [usage.fiveHour, usage.sevenDay, ...usage.scoped].filter((w): w is UsageWindow => w !== null)
    if (windows.length) {
      lines.push(`Limits (${SOURCES[usage.source]}${usage.fetchedAt ? `, as of ${localTime(usage.fetchedAt)}` : ''}):`)
      for (const w of windows) lines.push(`- ${windowName(w)}: ${Math.round(w.percent)} % used${w.resetsAt ? `, resets ${localTime(w.resetsAt, now)}` : ''}`)
    } else if (usage.status === 'ok') {
      lines.push(usage.message ?? 'There are no limits to show (e.g. an API key, billed by use).')
    }
    if (usage.extra?.enabled) {
      const { usedCredits: used, monthlyLimit: limit, currency } = usage.extra
      const amount = used === null ? '' : `: ${[used.toFixed(2), limit !== null ? `of ${limit.toFixed(2)}` : null, currency].filter(Boolean).join(' ')} used this month`
      lines.push(`Extra usage is on${amount}.`)
    }
  }
  if (input.others.length) {
    lines.push('Other accounts:')
    for (const { account: other, usage: u } of input.others) {
      const parts = [u?.fiveHour ? `5 h ${Math.round(u.fiveHour.percent)} %` : null, u?.sevenDay ? `week ${Math.round(u.sevenDay.percent)} %` : null].filter(Boolean)
      const state = parts.length ? parts.join(', ') : u ? (u.status === 'ok' ? 'no numbers' : u.status) : 'no numbers'
      lines.push(`- ${other.name}: ${state}`)
    }
  }
  lines.push(
    input.autoSwitch
      ? 'Automatic switch at a limit is on: a session that hits a limit continues with the next free account.'
      : 'Automatic switch at a limit is off: at a limit the user switches the account or waits for the reset.',
  )
  return lines.join('\n')
}

/** Messages `offset`… of a conversation as text, at most `limit` and MAX_TRANSCRIPT_CHARS. */
export function formatTranscript(messages: TranscriptMessage[], offset: number, limit: number, truncated: boolean): string {
  const total = messages.length
  const from = offset < 0 ? Math.max(0, total + offset) : Math.min(offset, total)
  const to = Math.min(total, from + limit)
  const blocks: string[] = []
  let size = 0
  let end = from
  for (let i = from; i < to; i++) {
    const m = messages[i]
    const lines = [`[${i}] ${m.role}${m.timestamp ? ` · ${localTime(m.timestamp)}` : ''}`]
    if (m.text.trim()) lines.push(cut(m.text.trim(), MAX_MESSAGE_CHARS))
    for (const t of m.tools) lines.push(`  → ${t.name}: ${cut(t.summary.replace(/\s+/g, ' '), 200)}${t.status ? ` (${t.status})` : ''}`)
    const block = lines.join('\n')
    if (size + block.length > MAX_TRANSCRIPT_CHARS && blocks.length > 0) break
    blocks.push(block)
    size += block.length + 2
    end = i + 1
  }
  const earlier = truncated ? ` Only the last ${total} messages of the session are available.` : ''
  const range = total === 0 ? 'The session has no messages.' : `Messages ${from}–${Math.max(from, end - 1)} of ${total} (0-based).${earlier}`
  const rest = end < total ? `\nRead on with offset ${end}.` : ''
  return `${range}\n\n${blocks.join('\n\n')}${rest}`
}

/**
 * Terminal output as plain text: escape sequences out, carriage returns and erasing applied.
 * Moves of the cursor to another row start a new line, so nothing is lost, though a part a
 * program draws again may show twice.
 */
export function terminalText(raw: string): string {
  const lines: string[][] = [[]]
  let row = 0
  let col = 0
  /** Row of the last absolute cursor move, followed through line feeds. */
  let screenRow: number | null = null
  const line = () => lines[row]
  const newLine = () => {
    row++
    if (!lines[row]) lines[row] = []
    col = 0
    if (screenRow !== null) screenRow++
  }
  const put = (ch: string) => {
    const l = line()
    while (l.length < col) l.push(' ')
    l[col] = ch
    col++
  }
  const params = (text: string) => text.replace(/^[?>=<]/, '').split(';').map((p) => (p === '' ? NaN : Number(p)))
  const n = (value: number, fallback = 1) => (Number.isFinite(value) && value > 0 ? value : fallback)

  for (let i = 0; i < raw.length; i++) {
    const c = raw[i]
    const code = c.charCodeAt(0)
    if (c === '\x1b') {
      const next = raw[i + 1]
      if (next === '[') {
        let j = i + 2
        while (j < raw.length && /[0-?]/.test(raw[j])) j++
        const paramText = raw.slice(i + 2, j)
        while (j < raw.length && /[ -/]/.test(raw[j])) j++
        const final = raw[j]
        i = j
        if (final === undefined) break
        const p = params(paramText)
        const private_ = /^[?>=<]/.test(paramText)
        if (private_) continue
        switch (final) {
          case 'K': {
            const mode = Number.isFinite(p[0]) ? p[0] : 0
            const l = line()
            if (mode === 0) l.length = Math.min(l.length, col)
            else if (mode === 1) for (let k = 0; k <= col && k < l.length; k++) l[k] = ' '
            else lines[row] = []
            break
          }
          case 'J': {
            const mode = Number.isFinite(p[0]) ? p[0] : 0
            if (mode === 2 || mode === 3) {
              if (line().length) newLine()
              screenRow = 1
              col = 0
            } else if (mode === 0) {
              line().length = Math.min(line().length, col)
              lines.length = row + 1
            }
            break
          }
          case 'H':
          case 'f': {
            const r = n(p[0])
            const target = n(p[1]) - 1
            // Unknown row (output read from the middle): a new line, so nothing is overwritten.
            if ((screenRow === null || r !== screenRow) && line().length) newLine()
            screenRow = r
            col = target
            break
          }
          case 'd': {
            const r = n(p[0])
            if ((screenRow === null || r !== screenRow) && line().length) newLine()
            screenRow = r
            break
          }
          case 'A':
          case 'F':
            row = Math.max(0, row - n(p[0]))
            if (screenRow !== null) screenRow = Math.max(1, screenRow - n(p[0]))
            if (final === 'F') col = 0
            break
          case 'B':
          case 'E':
            for (let k = 0; k < n(p[0]); k++) {
              const keep = col
              newLine()
              if (final === 'B') col = keep
            }
            break
          case 'C':
            col += n(p[0])
            break
          case 'D':
            col = Math.max(0, col - n(p[0]))
            break
          case 'G':
            col = n(p[0]) - 1
            break
          case 'X': {
            const l = line()
            for (let k = col; k < col + n(p[0]) && k < l.length; k++) l[k] = ' '
            break
          }
          case 'P':
            line().splice(col, n(p[0]))
            break
          case '@':
            if (col < line().length) line().splice(col, 0, ...' '.repeat(n(p[0])))
            break
          default:
            // Colors (m), modes, scroll regions and the like don't change the text.
            break
        }
        continue
      }
      if (next === ']' || next === 'P' || next === '_' || next === '^' || next === 'X') {
        // OSC, DCS, APC, PM, SOS: up to BEL or ST.
        let j = i + 2
        while (j < raw.length && raw[j] !== '\x07' && !(raw[j] === '\x1b' && raw[j + 1] === '\\')) j++
        i = raw[j] === '\x07' ? j : j + 1
        continue
      }
      if (next === '(' || next === ')' || next === '*' || next === '+') {
        i += 2
        continue
      }
      if (next === 'M') row = Math.max(0, row - 1)
      i += 1
      continue
    }
    if (c === '\r') {
      col = 0
      continue
    }
    if (c === '\n') {
      newLine()
      continue
    }
    if (c === '\b') {
      col = Math.max(0, col - 1)
      continue
    }
    if (c === '\t') {
      const stop = (Math.floor(col / 8) + 1) * 8
      while (col < stop) put(' ')
      continue
    }
    if (code < 0x20 || code === 0x7f || (code >= 0x80 && code < 0xa0)) continue
    put(c)
  }

  const out: string[] = []
  let blank = 0
  for (const l of lines) {
    const text = (l ?? []).join('').replace(/\s+$/, '')
    if (!text) {
      blank++
      continue
    }
    if (blank && out.length) out.push('')
    blank = 0
    out.push(text)
  }
  return out.join('\n')
}

// --- arguments -----------------------------------------------------------------

interface SearchParams {
  query: string | undefined
  folder: string | undefined
  limit: number
}

interface ReadParams {
  sessionId: string
  accountId: string | undefined
  offset: number
  limit: number
}

interface OpenParams {
  command: string | undefined
  cwd: string | undefined
  title: string | undefined
  waitFor: string | undefined
  timeout: number | undefined
}

interface InputParams {
  id: number
  text: string
  enter: boolean
  waitFor: string | undefined
  timeout: number | undefined
}

interface OutputParams {
  id: number
  tail: number | undefined
  waitFor: string | undefined
  timeout: number | undefined
}

function parseSearch(args: Args): SearchParams {
  const query = optionalString(args, 'query', 500)?.trim() || undefined
  const folder = optionalPath(args, 'folder')
  if (!query && !folder) throw new AppToolError('Give query, folder or both.')
  const limit = optionalNumber(args, 'limit', 1, MAX_SEARCH_RESULTS)
  return { query, folder, limit: limit === undefined ? DEFAULT_SEARCH_RESULTS : Math.floor(limit) }
}

function parseRead(args: Args): ReadParams {
  const sessionId = requiredString(args, 'sessionId', 128).trim()
  if (!/^[A-Za-z0-9_-]+$/.test(sessionId)) throw new AppToolError('sessionId must be the id of a session, from sessions_search.')
  const accountId = optionalString(args, 'accountId', 200)?.trim() || undefined
  const offset = optionalNumber(args, 'offset', -100_000, 100_000)
  const limit = optionalNumber(args, 'limit', 1, MAX_READ_MESSAGES)
  return { sessionId, accountId, offset: Math.trunc(offset ?? 0), limit: limit === undefined ? DEFAULT_READ_MESSAGES : Math.floor(limit) }
}

function parseOpen(args: Args): OpenParams {
  const command = optionalString(args, 'command', 10_000)
  return {
    command: command?.trim() ? command : undefined,
    cwd: optionalPath(args, 'cwd'),
    title: optionalString(args, 'title', 120)?.trim() || undefined,
    ...waitArgs(args),
  }
}

function parseInput(args: Args): InputParams {
  return {
    id: shellIdOf(args),
    text: requiredString(args, 'text', 100_000, true),
    enter: optionalBoolean(args, 'enter') ?? true,
    ...waitArgs(args),
  }
}

function parseOutput(args: Args): OutputParams {
  const tail = optionalNumber(args, 'tail', 1, 2000)
  return { id: shellIdOf(args), tail: tail === undefined ? undefined : Math.floor(tail), ...waitArgs(args) }
}

function waitArgs(args: Args): { waitFor: string | undefined; timeout: number | undefined } {
  const waitFor = optionalString(args, 'waitFor', 500)
  if (waitFor !== undefined && waitFor.trim() === '') throw new AppToolError('waitFor must not be empty.')
  return { waitFor, timeout: optionalNumber(args, 'timeout', 1, MAX_WAIT_SECONDS) }
}

function shellIdOf(args: Args): number {
  const value = args.id
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) throw new AppToolError('id must be the number of one of your shells, from shell_open or shell_list.')
  return value
}

function optionalPath(args: Args, key: string): string | undefined {
  const value = optionalString(args, key, 1000)?.trim()
  if (!value) return undefined
  if (!isAbsolute(value)) throw new AppToolError(`${key} must be an absolute path.`)
  return resolve(value)
}

function requiredString(args: Args, key: string, max: number, allowEmpty = false): string {
  const value = args[key]
  if (typeof value !== 'string' || (!allowEmpty && value.trim() === '')) throw new AppToolError(`${key} must be a non-empty string.`)
  if (value.length > max) throw new AppToolError(`${key} is too long.`)
  return value
}

function optionalString(args: Args, key: string, max: number): string | undefined {
  const value = args[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') throw new AppToolError(`${key} must be a string.`)
  if (value.length > max) throw new AppToolError(`${key} is too long.`)
  return value
}

function optionalBoolean(args: Args, key: string): boolean | undefined {
  const value = args[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'boolean') throw new AppToolError(`${key} must be true or false.`)
  return value
}

function optionalNumber(args: Args, key: string, min: number, max: number): number | undefined {
  const value = args[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    throw new AppToolError(`${key} must be a number from ${min} to ${max}.`)
  }
  return value
}

function cut(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}
