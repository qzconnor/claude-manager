import { existsSync, statSync } from 'node:fs'
import type { TerminalInfo } from '@shared/types'
import type { TerminalService } from '../../services/terminal-service'
import { type Args, cut, optionalBoolean, optionalNumber, optionalPath, optionalString, requiredString, ToolError } from '../tool-args'
import { terminalText } from './terminal-text'
import { type AppToolDefinition, tool } from './tool'

/** The tools shell_*: shell tabs next to the session that Claude types into and reads. */

/** Output of a shell Claude gets at most at once; the end is kept. */
const MAX_OUTPUT_CHARS = 20_000
/** Raw output looked at for one result: plenty for MAX_OUTPUT_CHARS of text. */
const MAX_RAW_CHARS = 400_000
const MAX_WAIT_SECONDS = 60
/** Without waitFor, input counts as answered once the shell has been quiet this long. */
const QUIET_MS = 1500
const DEFAULT_QUIET_WAIT_SECONDS = 10
const DEFAULT_TEXT_WAIT_SECONDS = 30

const shellId = { type: 'number', description: 'The id of the shell, from shell_open or shell_list.' }
const waitFor = { type: 'string', description: 'Wait until this text appears in the new output, e.g. "ready" or "Local:".' }
const timeout = { type: 'number', description: `Seconds to wait at most (1–${MAX_WAIT_SECONDS}).` }

export const shellTools: AppToolDefinition<never>[] = [
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
    run: async (app, session, p) => app.shells.open(session, p),
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
    run: async (app, session, p) => app.shells.input(session, p),
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
    run: async (app, session, p) => app.shells.output(session, p),
  }),
  tool({
    name: 'shell_list',
    title: 'List your shells',
    description: 'The shell tabs you opened: id, folder, whether they still run, and how much output you have not read yet.',
    properties: {},
    group: 'shell',
    readOnly: true,
    parse: () => ({}),
    run: async (app, session) => app.shells.list(session),
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
    run: async (app, session, p) => app.shells.close(session, p.id),
  }),
]

/** A shell tab a session opened, and how far Claude has read its output. */
interface Shell {
  id: number
  terminalId: string
  sessionId: string
  /** Stream offset of the output Claude has not read yet. */
  readFrom: number
}

/** The shell tabs sessions opened (shell_open), and how far Claude has read their output. */
export class Shells {
  private readonly shells = new Map<string, Shell>()
  private readonly nextShellId = new Map<string, number>()

  constructor(private readonly terminals: TerminalService) {
    terminals.on('changed', (list) => {
      const open = new Set(list.map((t) => t.id))
      for (const [id, shell] of [...this.shells]) if (!open.has(id) || !open.has(shell.sessionId)) this.shells.delete(id)
      for (const session of [...this.nextShellId.keys()]) if (!open.has(session)) this.nextShellId.delete(session)
    })
  }

  async open(session: TerminalInfo, p: OpenParams): Promise<string> {
    const cwd = p.cwd ?? session.cwd
    if (p.cwd !== undefined && !isDirectory(p.cwd)) throw new ToolError(`No such folder: ${p.cwd}`)
    const { terminals } = this
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
      throw new ToolError(`The shell could not start: ${error instanceof Error ? error.message : String(error)}`)
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

  async input(session: TerminalInfo, p: InputParams): Promise<string> {
    const shell = this.shell(session, p.id)
    this.requireRunning(shell)
    const typed = await this.type(shell, p.text, p.enter, p.waitFor, p.timeout)
    shell.readFrom = this.terminals.buffer(shell.terminalId).end
    const what = p.text === '\u0003' ? 'Pressed Ctrl+C' : `Typed ${JSON.stringify(cut(p.text, 200))}${p.enter ? ' and pressed Enter' : ''}`
    return `${what} in shell ${shell.id}.${typed.note}${this.status(shell.terminalId)}\n\nNew output:\n${outputText(typed.raw)}`
  }

  async output(session: TerminalInfo, p: OutputParams): Promise<string> {
    const shell = this.shell(session, p.id)
    const { terminals } = this
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

  list(session: TerminalInfo): string {
    const terminals = new Map(this.terminals.list().map((t) => [t.id, t]))
    const mine = [...this.shells.values()].filter((s) => s.sessionId === session.id && terminals.has(s.terminalId))
    if (mine.length === 0) return 'You have no shell tabs open. Open one with shell_open.'
    const lines = mine.map((shell) => {
      const info = terminals.get(shell.terminalId)!
      const unread = terminalText(rawSince(this.terminals.buffer(shell.terminalId), shell.readFrom)).trim()
      const unreadLines = unread ? unread.split('\n').length : 0
      const state = info.status === 'running' ? 'running' : `exited with code ${info.exitCode ?? '?'}`
      return `- ${shell.id}: ${JSON.stringify(info.title)}, ${shellName(info.commandLine)} in ${info.cwd}, ${state}, ${unreadLines} unread line(s)`
    })
    return `Your shell tabs:\n${lines.join('\n')}`
  }

  close(session: TerminalInfo, id: number): string {
    const shell = this.shell(session, id)
    this.terminals.close(shell.terminalId)
    this.shells.delete(shell.terminalId)
    return `Closed shell ${id}.`
  }

  /** One of the session's shells; others, also those of the user, are out of reach. */
  private shell(session: TerminalInfo, id: number): Shell {
    const open = new Set(this.terminals.list().map((t) => t.id))
    const mine = [...this.shells.values()].filter((s) => s.sessionId === session.id && open.has(s.terminalId))
    const shell = mine.find((s) => s.id === id)
    if (!shell) {
      throw new ToolError(
        mine.length ? `You have no shell ${id}; yours are ${mine.map((s) => s.id).join(', ')}.` : 'You have no shell tabs open. Open one with shell_open.',
      )
    }
    return shell
  }

  private requireRunning(shell: Shell): void {
    const info = this.terminals.list().find((t) => t.id === shell.terminalId)
    if (info?.status !== 'running') throw new ToolError(`Shell ${shell.id} has ended (exit code ${info?.exitCode ?? '?'}). Open another one with shell_open.`)
  }

  /** ", running" or ", ended with exit code 1", for a result. */
  private status(terminalId: string, always = false): string {
    const info = this.terminals.list().find((t) => t.id === terminalId)
    if (!info) return ' The tab is closed.'
    if (info.status === 'running') return always ? ' (running)' : ''
    return ` The shell has ended (exit code ${info.exitCode ?? '?'}).`
  }

  /** Types into the shell and waits for its answer (see `collect`). */
  private async type(shell: Shell, text: string, enter: boolean, waitFor: string | undefined, timeoutSeconds: number | undefined) {
    const { terminals } = this
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
    const { terminals } = this
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

/** The shell of a terminal's command line, for Claude to pick the syntax. */
export function shellName(commandLine: string): string {
  const first = commandLine.trim().startsWith('"') ? commandLine.trim().slice(1).split('"')[0] : commandLine.trim().split(/\s+/)[0]
  const file = (first.split(/[\\/]/).pop() ?? '').toLowerCase().replace(/\.exe$/, '')
  if (file === 'pwsh') return 'PowerShell 7 (pwsh)'
  if (file === 'powershell') return 'Windows PowerShell 5.1'
  if (file === 'cmd') return 'cmd'
  return file || 'shell'
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
  if (waitFor !== undefined && waitFor.trim() === '') throw new ToolError('waitFor must not be empty.')
  return { waitFor, timeout: optionalNumber(args, 'timeout', 1, MAX_WAIT_SECONDS) }
}

function shellIdOf(args: Args): number {
  const value = args.id
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) throw new ToolError('id must be the number of one of your shells, from shell_open or shell_list.')
  return value
}
