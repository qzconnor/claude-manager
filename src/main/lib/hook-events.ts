import { isAbsolute, resolve } from 'node:path'
import type { FileTouch, TerminalActivity } from '@shared/types'
import { isPlainObject } from '@shared/utils'
import { toolSummary } from '../workers/transcript-parser'
import { SESSION_ID_RE, waitingDetail } from './session-files'
import { shellFiles } from './shell-files'

/**
 * The hook events of Claude Code the app listens to. Each one costs a request to the app per event
 * (a few milliseconds on 127.0.0.1); events the app has no use for are left out. SessionStart takes
 * no HTTP hooks: the session comes with every event instead (`session_id`).
 */
export const HOOK_EVENTS = [
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'PermissionRequest',
  'Elicitation',
  'Stop',
  'StopFailure',
  'SubagentStart',
  'SubagentStop',
  'PreCompact',
  'PostCompact',
] as const

/**
 * Longest wait for the app per event (s). Claude Code waits for the answer of a hook before it goes on
 * (PreToolUse before every tool); the app answers at once, this only bounds a hanging main process.
 */
const HOOK_TIMEOUT_S = 3

type HookHandler = { type: 'http'; url: string; headers: Record<string, string>; timeout: number }
type HookMatchers = { hooks: HookHandler[] }[]

/** The settings that give a session the app's hooks (`--settings`): all events to one address. */
export function hookSettings(url: string, token: string): { hooks: Record<string, HookMatchers> } {
  const handler: HookHandler = { type: 'http', url, headers: { Authorization: `Bearer ${token}` }, timeout: HOOK_TIMEOUT_S }
  return { hooks: Object.fromEntries(HOOK_EVENTS.map((event) => [event, [{ hooks: [handler] }]])) }
}

/**
 * The user's own settings with the app's hooks added to theirs. Of the other keys nothing changes;
 * an event both name gets the user's matchers first.
 */
export function mergeHookSettings(
  user: Record<string, unknown>,
  ours: { hooks: Record<string, HookMatchers> },
): Record<string, unknown> {
  const hooks: Record<string, unknown> = isPlainObject(user.hooks) ? { ...user.hooks } : {}
  for (const [event, matchers] of Object.entries(ours.hooks)) {
    const theirs = hooks[event]
    hooks[event] = Array.isArray(theirs) ? [...theirs, ...matchers] : matchers
  }
  return { ...user, hooks }
}

const SETTINGS_RE = /^--settings(?:=(.*))?$/s

/**
 * The user's own `--settings` among their arguments: the value of the last one (Claude Code takes
 * only the last), `null` without one, `invalid` for an option without a value. After `--` come no
 * more options.
 */
export function userSettingsValue(extra: readonly string[]): string | null | 'invalid' {
  let value: string | null | 'invalid' = null
  for (let i = 0; i < extra.length; i++) {
    if (extra[i] === '--') break
    const match = SETTINGS_RE.exec(extra[i]!)
    if (!match) continue
    if (match[1] !== undefined) value = match[1]
    else {
      const next = extra[i + 1]
      value = next === undefined || next.startsWith('-') ? 'invalid' : next
      i++
    }
  }
  return value === '' ? 'invalid' : value
}

/**
 * The settings a `--settings` value stands for, as Claude Code reads it: JSON when it looks like an
 * object, otherwise a file, relative to the session's folder. Null when they can't be read.
 */
export function readUserSettings(value: string, cwd: string, readFile: (path: string) => string): Record<string, unknown> | null {
  try {
    const text = value.trimStart().startsWith('{') ? value : readFile(isAbsolute(value) ? value : resolve(cwd, value))
    const parsed: unknown = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text)
    return isPlainObject(parsed) ? parsed : null
  } catch {
    return null
  }
}

/** One hook call of Claude Code, as far as the app needs it. */
export type HookEvent =
  | { kind: 'prompt' }
  /** A tool starts; `agent`: the subagent it runs in, null in the session's own turn. */
  | { kind: 'tool'; tool: string; detail: string | null; agent: string | null }
  | { kind: 'toolDone'; agent: string | null }
  /** Claude Code asks the user: a permission, a question, the approval of a plan, input for an MCP server. */
  | { kind: 'input'; tool: string; detail: string | null }
  /** `background`: the turn waits for tasks that still run (e.g. a subagent), Claude goes on after them. */
  | { kind: 'stop'; message: string | null; background: boolean }
  | { kind: 'failure'; error: string; message: string | null }
  | { kind: 'subagent'; id: string; running: boolean }
  | { kind: 'compact'; running: boolean }

/** Tools that wait for the user by themselves, without a permission prompt. */
const ASKING_TOOLS = new Set(['AskUserQuestion', 'ExitPlanMode'])

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

/** What a hook call tells of files, for the file tree; paths are absolute. */
export interface FileActivity {
  /** Files a tool reads or writes. */
  touches?: FileTouch[]
  /** Paths that count only where they are files: a shell command's arguments, what a search found. */
  maybe?: FileTouch[]
  /** A commit was made in this folder. */
  commit?: string
  /**
   * A shell command starts or ended. Files that change in `cwd` meanwhile are what it writes; at its
   * end so are the `writes` it names, if they changed since it started.
   */
  shell?: { id: string; cwd: string; end: boolean; writes: string[] }
}

/** One hook call: its event and the session it belongs to (also for the events of subagents). */
export interface HookCall {
  sessionId: string | null
  event: HookEvent
  /** What the call does with files. */
  files?: FileActivity
}

/** The call in the body of a hook request; null for an event the app doesn't know or can't read. */
export function parseHookCall(body: unknown): HookCall | null {
  if (!isPlainObject(body)) return null
  const event = parseEvent(body)
  if (!event) return null
  const sessionId = text(body.session_id)
  const files = fileActivity(body)
  return { sessionId: sessionId && SESSION_ID_RE.test(sessionId) ? sessionId : null, event, ...(files && { files }) }
}

/** Tools that read a file, and those that write one; the file is in `file_path` (`notebook_path` for notebooks). */
const READING_TOOLS = new Set(['Read'])
const WRITING_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit'])
const SEARCH_TOOLS = new Set(['Grep', 'Glob'])
const SHELL_TOOLS = new Set(['Bash', 'PowerShell'])
/**
 * Whether a shell command commits: `git commit`, also with options between (`git -C repo commit`).
 * Part by part (`;`, `&`, `|`, new line) instead of one pattern over all: `git[^;]*\scommit` backtracks
 * over each `git` of a long command, 64 KB of them took most of a second.
 */
export function commitsInShell(command: string): boolean {
  return command.split(/[;&|\n]/).some((part) => {
    const git = /\bgit\b/.exec(part)
    return git !== null && /\scommit\b/.test(part.slice(git.index + 3))
  })
}

/** The most files of a search that light up. */
const MAX_FOUND = 20

/**
 * What a tool does with files: the file it is about to read or write (PreToolUse); the file a search
 * looks in, and what it found (PostToolUse); the files a shell command names, while it runs, and the
 * commit it made.
 */
export function fileActivity(body: Record<string, unknown>): FileActivity | null {
  const tool = text(body.tool_name)
  const input = isPlainObject(body.tool_input) ? body.tool_input : null
  const cwd = text(body.cwd)
  if (!tool || !input) return null
  const at = (file: string) => (isAbsolute(file) ? file : cwd ? resolve(cwd, file) : null)
  const event = body.hook_event_name
  if (event === 'PreToolUse' && (READING_TOOLS.has(tool) || WRITING_TOOLS.has(tool))) {
    const file = text(input.file_path) ?? text(input.notebook_path)
    const path = file ? at(file) : null
    return path ? { touches: [{ path, kind: READING_TOOLS.has(tool) ? 'read' : 'write' }] } : null
  }
  if (SEARCH_TOOLS.has(tool)) {
    if (event === 'PreToolUse') {
      // Searched in one file; a folder isn't marked.
      const file = text(input.path)
      const path = file ? at(file) : null
      return path ? { maybe: [{ path, kind: 'search' }] } : null
    }
    if (event !== 'PostToolUse' || !cwd) return null
    const found = foundFiles(body.tool_response).flatMap((file) => at(file) ?? [])
    return found.length ? { maybe: found.map((path) => ({ path, kind: 'search' })) } : null
  }
  if (SHELL_TOOLS.has(tool) && cwd && (event === 'PreToolUse' || event === 'PostToolUse' || event === 'PostToolUseFailure')) {
    const command = text(input.command)
    if (!command) return null
    const id = text(body.tool_use_id) ?? tool
    const files = shellFiles(command, cwd, tool === 'PowerShell')
    if (event === 'PreToolUse') {
      const maybe: FileTouch[] = [
        ...files.reads.map((path) => ({ path, kind: 'read' as const })),
        ...files.searches.map((path) => ({ path, kind: 'search' as const })),
      ]
      return { ...(maybe.length && { maybe }), shell: { id, cwd, end: false, writes: [] } }
    }
    const commit = event === 'PostToolUse' && tool === 'Bash' && commitsInShell(command)
    return { ...(commit && { commit: cwd }), shell: { id, cwd, end: true, writes: files.writes } }
  }
  return null
}

/**
 * The files a search (Grep, Glob) found, relative to the folder Claude works in: its `filenames`, or
 * with Grep's lines the files at their start (`path:12:text`).
 */
function foundFiles(response: unknown): string[] {
  if (!isPlainObject(response)) return []
  const names = new Set<string>()
  if (Array.isArray(response.filenames)) {
    for (const name of response.filenames) if (typeof name === 'string' && name) names.add(name)
  }
  if (names.size === 0 && typeof response.content === 'string') {
    for (const line of response.content.split('\n', 2000)) {
      const match = /^(.+?)([:-])\d+\2/.exec(line) ?? /^(.+):\d+$/.exec(line)
      if (match) names.add(match[1]!)
      if (names.size >= MAX_FOUND) break
    }
  }
  return [...names].slice(0, MAX_FOUND)
}

/** Tasks a turn leaves running (`background_tasks` of Stop), after which Claude goes on. */
function runsInBackground(tasks: unknown): boolean {
  return Array.isArray(tasks) && tasks.some((task) => isPlainObject(task) && task.status === 'running')
}

function parseEvent(body: Record<string, unknown>): HookEvent | null {
  const tool = text(body.tool_name)
  const agent = text(body.agent_id)
  switch (body.hook_event_name) {
    case 'UserPromptSubmit':
      return { kind: 'prompt' }
    case 'PreToolUse':
      if (!tool) return null
      if (ASKING_TOOLS.has(tool)) return { kind: 'input', tool, detail: text(waitingDetail(tool, body.tool_input)) }
      return { kind: 'tool', tool, detail: text(toolSummary(tool, body.tool_input)), agent }
    case 'PostToolUse':
    case 'PostToolUseFailure':
      return { kind: 'toolDone', agent }
    case 'PermissionRequest':
      return tool ? { kind: 'input', tool, detail: text(waitingDetail(tool, body.tool_input)) } : null
    case 'Elicitation':
      return { kind: 'input', tool: text(body.mcp_server_name) ?? 'MCP', detail: text(body.message) }
    case 'Stop':
      return { kind: 'stop', message: text(body.last_assistant_message), background: runsInBackground(body.background_tasks) }
    case 'StopFailure':
      return { kind: 'failure', error: text(body.error) ?? 'unknown', message: text(body.last_assistant_message) }
    case 'SubagentStart':
    case 'SubagentStop': {
      const id = text(body.agent_id)
      return id ? { kind: 'subagent', id, running: body.hook_event_name === 'SubagentStart' } : null
    }
    case 'PreCompact':
    case 'PostCompact':
      return { kind: 'compact', running: body.hook_event_name === 'PreCompact' }
    default:
      return null
  }
}

/** What the hooks have told about a session so far. */
export interface HookState {
  sessionId: string | null
  /** The tool the session's own turn runs (not one of a subagent). */
  activity: TerminalActivity | null
  /** Subagents that started and haven't stopped. */
  subagents: string[]
  compacting: boolean
  /**
   * The turn ended, or waits for the user, and that was told: the title turning idle needs no lookup
   * in the transcript. Cleared once the session goes on (a prompt, a tool's result).
   */
  ended: boolean
  /**
   * What the user was told Claude waits for (tool and detail): Claude Code may ask for the same thing
   * twice, e.g. a question by PreToolUse and its permission. Cleared once anything goes on.
   */
  waitingFor: string | null
}

export function newHookState(): HookState {
  return { sessionId: null, activity: null, subagents: [], compacting: false, ended: false, waitingFor: null }
}

/** How a turn ended (or that it waits), as a hook told it; `limit` is looked up in the transcript. */
export type HookTurnEnd =
  | { kind: 'done'; tool: null; detail: string | null }
  | { kind: 'input'; tool: string; detail: string | null }
  | { kind: 'limit'; tool: null; detail: string | null }

/** A subagent that works runs: one lost track of (see `interruptedHookState`) counts again. */
function working(subagents: string[], agent: string): string[] {
  return subagents.includes(agent) ? subagents : [...subagents, agent]
}

/**
 * Claude Code has been idle for a while: no compaction runs, nor a tool of the turn unless it waits
 * for the user. Esc stops them without a hook (no PostCompact, no PostToolUseFailure).
 */
export function idleHookState(state: HookState): HookState {
  return { ...state, compacting: false, activity: state.ended ? state.activity : null }
}

/**
 * Esc ended the turn (the transcript says so): its subagents stopped with it, without SubagentStop.
 * One that goes on in the background counts again with its next tool.
 */
export function interruptedHookState(state: HookState): HookState {
  return { ...idleHookState(state), activity: null, subagents: [] }
}

/** The state after a call, and the end of the turn it tells, if it tells one. */
export function applyHookCall(state: HookState, { sessionId, event }: HookCall, now: string): { state: HookState; end: HookTurnEnd | null } {
  // Another session in the same process (`/clear`, `/resume`): nothing of the old one runs any more.
  if (sessionId && sessionId !== state.sessionId) state = { ...(state.sessionId ? newHookState() : state), sessionId }
  return applyEvent(state, event, now)
}

function applyEvent(state: HookState, event: HookEvent, now: string): { state: HookState; end: HookTurnEnd | null } {
  switch (event.kind) {
    case 'prompt':
      return { state: { ...state, activity: null, ended: false, waitingFor: null }, end: null }
    case 'tool':
      if (event.agent) return { state: { ...state, subagents: working(state.subagents, event.agent) }, end: null }
      return { state: { ...state, activity: { tool: event.tool, detail: event.detail, since: now } }, end: null }
    case 'toolDone':
      // An answered permission of a subagent: its next one is news again.
      if (event.agent) return { state: { ...state, subagents: working(state.subagents, event.agent), waitingFor: null }, end: null }
      return { state: { ...state, activity: null, ended: false, waitingFor: null }, end: null }
    case 'input': {
      const waitingFor = `${event.tool}\n${event.detail ?? ''}`
      const end: HookTurnEnd | null = waitingFor === state.waitingFor ? null : { kind: 'input', tool: event.tool, detail: event.detail }
      return { state: { ...state, ended: true, waitingFor }, end }
    }
    case 'stop':
      // Waits for tasks in the background: the turn that ends is the one after them.
      if (event.background) return { state: { ...state, activity: null, compacting: false }, end: null }
      // Nothing of the turn runs any more, also what ended without telling.
      return {
        state: { ...state, activity: null, subagents: [], compacting: false, ended: true, waitingFor: null },
        end: { kind: 'done', tool: null, detail: event.message },
      }
    case 'failure': {
      const end: HookTurnEnd =
        event.error === 'rate_limit'
          ? { kind: 'limit', tool: null, detail: event.message }
          : { kind: 'done', tool: null, detail: event.message }
      return { state: { ...state, activity: null, compacting: false, ended: true, waitingFor: null }, end }
    }
    case 'subagent': {
      const others = state.subagents.filter((id) => id !== event.id)
      return { state: { ...state, subagents: event.running ? [...others, event.id] : others }, end: null }
    }
    case 'compact':
      return { state: { ...state, compacting: event.running }, end: null }
  }
}
