/**
 * Parsing of Claude Code transcript files (`<configDir>/projects/<project>/<session>.jsonl`).
 * Pure functions — used by the indexer worker thread (`toolSummary` also by the main process).
 */
import { folderKey, inFolder } from '@shared/folders'
import { unwrapPasted } from '@shared/pasted'
import type { SessionWorktree, TranscriptMessage, TranscriptToolCall, TranscriptToolDetail } from '@shared/types'

export interface ParsedSummary {
  id: string
  cwd: string | null
  worktree: SessionWorktree | null
  title: string
  firstPrompt: string | null
  lastPrompt: string | null
  gitBranch: string | null
  model: string | null
  messageCount: number
  createdAt: string | null
  updatedAt: string | null
  version: string | null
  continuedIn: string | null
}

/** [key, localDay, model, input, output, cacheCreation, cacheRead] */
export type UsageEntry = [string, string, string, number, number, number, number]

export interface ParseResult {
  summary: ParsedSummary
  usage: UsageEntry[]
}

const NEWLINE = 0x0a
/** Line prefixes we never need — `api-request` lines alone are ~80% of a transcript's bytes. */
const SKIP_PREFIXES = [
  '{"type":"api-request',
  '{"type":"file-history',
  '{"type":"permission-mode"',
  '{"type":"mode"',
  '{"type":"atis-latch"',
  '{"type":"tools-used"',
  '{"type":"queue-operation"',
  '{"type":"cost-state"',
].map((p) => Buffer.from(p, 'latin1'))

function hasPrefix(buf: Buffer, start: number, end: number, prefix: Buffer): boolean {
  if (end - start < prefix.length) return false
  return buf.compare(prefix, 0, prefix.length, start, start + prefix.length) === 0
}

/** Calls `onEntry` for every JSON line that isn't on the skip list. */
export function forEachEntry(buf: Buffer, onEntry: (entry: Record<string, unknown>) => void): void {
  let start = 0
  const length = buf.length
  while (start < length) {
    let end = buf.indexOf(NEWLINE, start)
    if (end === -1) end = length
    let lineEnd = end
    if (lineEnd > start && buf[lineEnd - 1] === 0x0d) lineEnd--
    if (lineEnd - start > 1 && !SKIP_PREFIXES.some((p) => hasPrefix(buf, start, lineEnd, p))) {
      try {
        const entry = JSON.parse(buf.toString('utf8', start, lineEnd)) as unknown
        if (entry && typeof entry === 'object') onEntry(entry as Record<string, unknown>)
      } catch {
        // partial line (file is being written) or corrupt line — ignore
      }
    }
    start = end + 1
  }
}

const NOISE_TAGS = [
  'system-reminder',
  'local-command-stdout',
  'local-command-stderr',
  'local-command-caveat',
  'command-message',
  'command-contents',
  'bash-stdout',
  'bash-stderr',
  'user-memory-input',
  // A background task reporting back: Claude Code sends it as a message of the user's.
  'task-notification',
]
const NOISE_RE = new RegExp(`<(${NOISE_TAGS.join('|')})>[\\s\\S]*?</\\1>`, 'g')

/** The text between `<tag>` and `</tag>`; null without. */
function tagText(raw: string, tag: string): string | null {
  const match = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(raw)
  return match ? match[1] : null
}

/** A slash command as typed (`/review 123`); null when the message is none. */
function commandOf(raw: string): string | null {
  const name = tagText(raw, 'command-name')?.trim()
  if (name === undefined) return null
  const args = tagText(raw, 'command-args')?.trim()
  return `${name.startsWith('/') ? name : `/${name}`}${args ? ` ${args}` : ''}`
}

/** Turns a raw user message into what the user actually typed (or the slash command). */
export function cleanPrompt(raw: string): string {
  const command = commandOf(raw)
  if (command !== null) return command
  const bash = tagText(raw, 'bash-input')
  if (bash !== null) return `! ${bash.trim()}`
  return unwrapPasted(raw.replace(NOISE_RE, '')).trim()
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content) {
    if (block && typeof block === 'object' && (block as { type?: string }).type === 'text') {
      const text = (block as { text?: unknown }).text
      if (typeof text === 'string') parts.push(text)
    }
  }
  return parts.join('\n')
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

/** The worktree of a `worktree-state` entry, as Claude Code writes it with `--worktree`. */
export function toWorktree(value: unknown): SessionWorktree | null {
  if (!value || typeof value !== 'object') return null
  const w = value as Record<string, unknown>
  const path = str(w.worktreePath)
  const originalCwd = str(w.originalCwd)
  if (!path || !originalCwd) return null
  return {
    name: str(w.worktreeName) ?? path.split(/[\\/]/).filter(Boolean).at(-1) ?? path,
    branch: str(w.worktreeBranch),
    path,
    originalCwd,
  }
}

function localDay(iso: string): string | null {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return null
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

function shorten(text: string, max: number): string {
  const single = text.replace(/\s+/g, ' ').trim()
  return single.length > max ? `${single.slice(0, max - 1)}…` : single
}

/** Parses one transcript. `withSummary=false` only collects token usage (subagent files). */
/**
 * What a transcript told so far. `scanTranscript` reads more of it into the same scan, so a session at
 * work is read on from where it was, not from the start.
 */
export interface TranscriptScan {
  withSummary: boolean
  aiTitle: string | null
  customTitle: string | null
  legacySummary: string | null
  lastPrompt: string | null
  firstPrompt: string | null
  lastUserPrompt: string | null
  cwd: string | null
  /** Where `/cd` (or entering and leaving a worktree) last moved the session. */
  relocatedCwd: string | null
  gitBranch: string | null
  model: string | null
  version: string | null
  createdAt: string | null
  updatedAt: string | null
  continuedIn: string | null
  worktree: SessionWorktree | null
  userMessages: number
  assistantIds: Set<string>
  usageKeys: Set<string>
  usage: UsageEntry[]
}

export function newTranscriptScan(withSummary: boolean): TranscriptScan {
  return {
    withSummary,
    aiTitle: null,
    customTitle: null,
    legacySummary: null,
    lastPrompt: null,
    firstPrompt: null,
    lastUserPrompt: null,
    cwd: null,
    relocatedCwd: null,
    gitBranch: null,
    model: null,
    version: null,
    createdAt: null,
    updatedAt: null,
    continuedIn: null,
    worktree: null,
    userMessages: 0,
    assistantIds: new Set(),
    usageKeys: new Set(),
    usage: [],
  }
}

function scanEntry(scan: TranscriptScan, e: Record<string, unknown>): void {
  const { withSummary } = scan
  const type = e.type
  const timestamp = str(e.timestamp)
  if (timestamp) {
    if (!scan.createdAt) scan.createdAt = timestamp
    scan.updatedAt = timestamp
  }
  if (withSummary) {
    if (!scan.cwd) scan.cwd = str(e.cwd)
    scan.gitBranch = str(e.gitBranch) ?? scan.gitBranch
    scan.version = str(e.version) ?? scan.version
  }

  switch (type) {
    case 'ai-title':
      scan.aiTitle = str(e.aiTitle) ?? scan.aiTitle
      break
    case 'custom-title':
      scan.customTitle = str(e.customTitle) ?? scan.customTitle
      break
    case 'summary':
      scan.legacySummary = str(e.summary) ?? scan.legacySummary
      break
    case 'last-prompt':
      scan.lastPrompt = str(e.lastPrompt) ?? scan.lastPrompt
      break
    case 'relocated':
      if (withSummary) scan.relocatedCwd = str(e.relocatedCwd) ?? scan.relocatedCwd
      break
    case 'continued-in':
      scan.continuedIn = str(e.continuedInSessionId) ?? scan.continuedIn
      break
    case 'worktree-state':
      // `null` once the session left the worktree: the latest one it worked in stays.
      if (withSummary) scan.worktree = toWorktree(e.worktreeSession) ?? scan.worktree
      break
    case 'user': {
      if (!withSummary || e.isMeta || e.isSidechain) break
      const message = e.message as { content?: unknown } | undefined
      const prompt = cleanPrompt(textOf(message?.content))
      if (!prompt) break
      scan.userMessages++
      if (!scan.firstPrompt) scan.firstPrompt = shorten(prompt, 300)
      scan.lastUserPrompt = prompt
      break
    }
    case 'assistant': {
      const message = e.message as
        | { id?: unknown; model?: unknown; usage?: Record<string, unknown> }
        | undefined
      const messageId = str(message?.id)
      const messageModel = str(message?.model)
      // `<synthetic>` replies come from Claude Code itself (API errors, "No response requested."); the
      // conversation view and the search leave them out, so the message count does too.
      if (withSummary && !e.isSidechain && messageId && messageModel !== '<synthetic>' && !scan.assistantIds.has(messageId)) {
        scan.assistantIds.add(messageId)
        if (messageModel) scan.model = messageModel
      }
      const u = message?.usage
      if (u && messageId && messageModel !== '<synthetic>') {
        const key = `${messageId}:${str(e.requestId) ?? ''}`
        if (scan.usageKeys.has(key)) break
        scan.usageKeys.add(key)
        const day = timestamp ? localDay(timestamp) : null
        if (!day) break
        scan.usage.push([
          key,
          day,
          messageModel ?? 'unknown',
          num(u.input_tokens),
          num(u.output_tokens),
          num(u.cache_creation_input_tokens),
          num(u.cache_read_input_tokens),
        ])
      }
      break
    }
  }
}

/**
 * Reads the complete lines of `buf` into the scan and returns how many bytes they take; a last line
 * without its newline is still being written and is read the next time.
 */
export function scanTranscript(scan: TranscriptScan, buf: Buffer): number {
  const end = buf.lastIndexOf(NEWLINE) + 1
  forEachEntry(buf.subarray(0, end), (e) => scanEntry(scan, e))
  return end
}

/**
 * The worktree the session works in: the latest one, unless the session was moved out of it with
 * `/cd` to an unrelated folder (back to the folder the worktree was made from still counts).
 */
function currentWorktree(worktree: SessionWorktree | null, relocatedCwd: string | null): SessionWorktree | null {
  if (!worktree || !relocatedCwd) return worktree
  return inFolder(relocatedCwd, worktree.path) || folderKey(relocatedCwd) === folderKey(worktree.originalCwd) ? worktree : null
}

/** The summary and usage of what the scan read. */
export function scanResult(scan: TranscriptScan, sessionId: string): ParseResult {
  const fallbackPrompt = scan.lastPrompt ?? scan.lastUserPrompt
  const title = scan.customTitle ?? scan.aiTitle ?? scan.legacySummary ?? scan.firstPrompt ?? 'Ohne Titel'
  return {
    summary: {
      id: sessionId,
      // The session is resumed where it was moved to last: Claude Code refuses it in another folder.
      cwd: scan.relocatedCwd ?? scan.cwd,
      worktree: currentWorktree(scan.worktree, scan.relocatedCwd),
      title: shorten(title, 160),
      firstPrompt: scan.firstPrompt,
      lastPrompt: fallbackPrompt ? shorten(fallbackPrompt, 300) : null,
      gitBranch: scan.gitBranch,
      model: scan.model,
      messageCount: scan.userMessages + scan.assistantIds.size,
      createdAt: scan.createdAt,
      updatedAt: scan.updatedAt,
      version: scan.version,
      continuedIn: scan.continuedIn,
    },
    usage: [...scan.usage],
  }
}

/** The whole transcript at once, a last line without its newline included. */
export function parseTranscript(buf: Buffer, sessionId: string, withSummary: boolean): ParseResult {
  const scan = newTranscriptScan(withSummary)
  forEachEntry(buf, (e) => scanEntry(scan, e))
  return scanResult(scan, sessionId)
}

/** Starts a user's message in the search text. */
export const SEARCH_USER = '\u0001'
/** Starts one of Claude's answers in the search text. */
export const SEARCH_ASSISTANT = '\u0002'
const SEARCH_MARKERS = /[\u0001\u0002]/g
/** Tool output arrives as user messages and makes up most of a transcript; it holds nothing typed. */
const TOOL_RESULT = Buffer.from('"type":"tool_result"', 'latin1')

/**
 * The conversation as plain text for the full-text search: the user's prompts and Claude's answers,
 * each message starting with SEARCH_USER or SEARCH_ASSISTANT. Tool calls and their output are left out.
 * Only complete lines are read; `end` is the offset after the last one, to carry on from there.
 */
export function collectSearchText(buf: Buffer): { text: string; end: number } {
  const parts: string[] = []
  const end = buf.lastIndexOf(NEWLINE) + 1
  let start = 0
  while (start < end) {
    const lineEnd = buf.indexOf(NEWLINE, start)
    let contentEnd = lineEnd
    if (contentEnd > start && buf[contentEnd - 1] === 0x0d) contentEnd--
    const line = buf.subarray(start, contentEnd)
    start = lineEnd + 1
    if (line.length < 2 || SKIP_PREFIXES.some((p) => hasPrefix(line, 0, line.length, p)) || line.includes(TOOL_RESULT)) {
      continue
    }
    let e: Record<string, unknown>
    try {
      e = JSON.parse(line.toString('utf8')) as Record<string, unknown>
    } catch {
      continue
    }
    if (!e || typeof e !== 'object' || e.isSidechain || e.isMeta) continue
    const message = e.message as { content?: unknown; model?: unknown } | undefined
    let text = ''
    if (e.type === 'user') text = cleanPrompt(textOf(message?.content))
    else if (e.type === 'assistant' && message?.model !== '<synthetic>') text = textOf(message?.content).trim()
    else continue
    if (text) parts.push((e.type === 'user' ? SEARCH_USER : SEARCH_ASSISTANT) + text.replace(SEARCH_MARKERS, ' '))
  }
  return { text: parts.join(''), end }
}

/** One line about a tool call: its command, file, pattern, URL… */
export function toolSummary(name: string, input: unknown): string {
  if (!input || typeof input !== 'object') return ''
  const i = input as Record<string, unknown>
  const pick =
    str(i.command) ??
    str(i.file_path) ??
    str(i.path) ??
    str(i.pattern) ??
    str(i.url) ??
    str(i.query) ??
    str(i.description) ??
    str(i.prompt) ??
    str(i.skill)
  if (pick) return shorten(pick, 200)
  try {
    return shorten(JSON.stringify(input), 200)
  } catch {
    return name
  }
}

/** Tools that run a command in a shell: the window shows it as code. */
const SHELL_TOOLS = new Set(['Bash', 'PowerShell'])
/** Longest command sent along with the call; longer ones are complete in `readToolCall`. */
const MAX_COMMAND_CHARS = 4000

/** A little more about a tool call than its summary, in a few words: lines, where it searched, how many. */
export function toolDetail(name: string, input: unknown): string | null {
  if (!input || typeof input !== 'object') return null
  const i = input as Record<string, unknown>
  const count = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : null)
  switch (name) {
    case 'Read': {
      const pages = str(i.pages)
      if (pages) return `Seiten ${pages}`
      const offset = count(i.offset)
      const limit = count(i.limit)
      if (offset && limit) return `Zeilen ${offset}–${offset + limit - 1}`
      if (offset) return `ab Zeile ${offset}`
      return limit ? `Zeilen 1–${limit}` : null
    }
    case 'Grep':
    case 'Glob': {
      const where = [str(i.path), str(i.glob) ?? str(i.type)].filter(Boolean)
      return where.length ? `in ${where.join(' · ')}` : null
    }
    case 'Edit':
      return i.replace_all === true ? 'alle Stellen' : null
    case 'MultiEdit':
      return Array.isArray(i.edits) ? `${i.edits.length} ${i.edits.length === 1 ? 'Änderung' : 'Änderungen'}` : null
    case 'Agent':
    case 'Task':
      return str(i.subagent_type)
    case 'TodoWrite':
      return Array.isArray(i.todos) ? `${i.todos.length} ${i.todos.length === 1 ? 'Aufgabe' : 'Aufgaben'}` : null
    default:
      return null
  }
}

/** A tool call of the history from its `tool_use` block, without its outcome yet. */
export function toolCallOf(id: string | null, name: string, input: unknown): TranscriptToolCall {
  const i = input && typeof input === 'object' ? (input as Record<string, unknown>) : {}
  const command = SHELL_TOOLS.has(name) ? str(i.command) : null
  return {
    id,
    name,
    summary: toolSummary(name, input),
    detail: toolDetail(name, input),
    description: str(i.description) ? shorten(i.description as string, 300) : null,
    command: command && command.length > MAX_COMMAND_CHARS ? `${command.slice(0, MAX_COMMAND_CHARS)}…` : command,
    status: null,
  }
}

/** Colours and other escape sequences of the terminal, which commands like `/context` print. */
// eslint-disable-next-line no-control-regex -- the escape character is what is searched for
const ANSI_RE = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-_]/g

/** What a command printed, from the tags of its output; null when it printed nothing. */
function commandOutput(raw: string, out: string, err: string): { output: string | null; failed: boolean } | null {
  const stdout = tagText(raw, out)
  const stderr = tagText(raw, err)
  if (stdout === null && stderr === null) return null
  const clean = (text: string | null) => {
    const plain = (text ?? '').replace(ANSI_RE, '').replace(/\s+$/, '')
    return plain.trim() === '(no content)' ? '' : plain
  }
  const parts = [clean(stdout), clean(stderr)].filter(Boolean)
  return { output: parts.length ? parts.join('\n') : null, failed: clean(stderr).trim() !== '' }
}

/** A background task reporting back: its summary, result and whether it went wrong. */
function taskNotice(raw: string): { text: string; output: string | null; failed: boolean } | null {
  const notice = tagText(raw, 'task-notification')
  if (notice === null) return null
  const status = tagText(notice, 'status')?.trim() ?? ''
  const result = tagText(notice, 'result')?.trim()
  return {
    text: tagText(notice, 'summary')?.trim() || 'Eine Hintergrundaufgabe hat sich gemeldet.',
    output: result || null,
    failed: status === 'failed' || status === 'killed',
  }
}

/**
 * Builds a readable conversation: the user's prompts, commands and what they printed, background tasks
 * reporting back, Claude's answers with their tool calls, and where it was compacted.
 */
export function readConversation(buf: Buffer, maxMessages: number): { messages: TranscriptMessage[]; truncated: boolean; total: number } {
  const messages: TranscriptMessage[] = []
  const byMessageId = new Map<string, TranscriptMessage>()
  const calls: TranscriptToolCall[] = []
  /** tool_use id → the result was an error */
  const results = new Map<string, boolean>()
  /** The last entry if it is a command whose output may follow (as an entry of its own). */
  let awaiting: TranscriptMessage | null = null

  const push = (message: Omit<TranscriptMessage, 'output' | 'failed' | 'tools' | 'model'> & Partial<TranscriptMessage>) => {
    const full: TranscriptMessage = { output: null, failed: false, tools: [], model: null, ...message }
    messages.push(full)
    awaiting = full.kind === 'command' || full.kind === 'shell' ? full : null
    return full
  }
  /** Output of the command before, from an entry of its own; false when there is no such output. */
  const outputOf = (raw: string): boolean => {
    const printed = commandOutput(raw, 'local-command-stdout', 'local-command-stderr') ?? commandOutput(raw, 'bash-stdout', 'bash-stderr')
    if (!printed) return false
    const command = awaiting
    if (command && command.output === null) {
      command.output = printed.output
      command.failed = printed.failed
    }
    return true
  }

  forEachEntry(buf, (e) => {
    if (e.isSidechain || e.isMeta) return
    const timestamp = str(e.timestamp)
    const uuid = str(e.uuid) ?? `${messages.length}`
    if (e.type === 'user') {
      const message = e.message as { content?: unknown } | undefined
      // Tool results arrive as user messages; only their outcome is needed here.
      for (const block of Array.isArray(message?.content) ? message.content : []) {
        const b = block as { type?: unknown; tool_use_id?: unknown; is_error?: unknown } | null
        if (b?.type === 'tool_result' && typeof b.tool_use_id === 'string') results.set(b.tool_use_id, b.is_error === true)
      }
      const raw = textOf(message?.content)
      if (e.isCompactSummary) {
        const text = raw.replace(NOISE_RE, '').trim()
        if (text) push({ uuid, role: 'user', kind: 'summary', timestamp, text })
        return
      }
      const command = commandOf(raw)
      if (command !== null) {
        push({ uuid, role: 'user', kind: 'command', timestamp, text: command })
        return
      }
      const bash = tagText(raw, 'bash-input')
      if (bash !== null) {
        push({ uuid, role: 'user', kind: 'shell', timestamp, text: bash.trim() })
        return
      }
      if (outputOf(raw)) return
      const task = taskNotice(raw)
      if (task) {
        push({ uuid, role: 'user', kind: 'task', timestamp, ...task })
        return
      }
      // Pasted text keeps its tags: the window shows it as a block of its own.
      const text = raw.replace(NOISE_RE, '').trim()
      if (text) push({ uuid, role: 'user', kind: 'prompt', timestamp, text })
      return
    }
    if (e.type === 'assistant') {
      const message = e.message as { id?: unknown; model?: unknown; content?: unknown } | undefined
      const messageId = str(message?.id) ?? uuid
      const model = str(message?.model)
      if (model === '<synthetic>') return
      let target = byMessageId.get(messageId)
      if (!target) {
        target = push({ uuid, role: 'assistant', kind: 'answer', timestamp, text: '', model })
        byMessageId.set(messageId, target)
      }
      const blocks = Array.isArray(message?.content) ? message.content : []
      for (const block of blocks) {
        if (!block || typeof block !== 'object') continue
        const b = block as { type?: string; id?: unknown; text?: unknown; name?: unknown; input?: unknown }
        if (b.type === 'text' && typeof b.text === 'string' && b.text.trim()) {
          target.text = target.text ? `${target.text}\n\n${b.text}` : b.text
        } else if (b.type === 'tool_use') {
          const call = toolCallOf(str(b.id), str(b.name) ?? 'Tool', b.input)
          target.tools.push(call)
          calls.push(call)
        }
      }
      return
    }
    if (e.type === 'system' && typeof e.content === 'string') {
      if (e.subtype === 'compact_boundary') {
        push({ uuid, role: 'system', kind: 'compact', timestamp, text: 'Konversation wurde komprimiert (/compact).' })
      } else if (e.subtype === 'local_command') {
        // Newer versions of Claude Code write commands and what they printed as entries of this kind.
        const command = commandOf(e.content)
        if (command !== null) push({ uuid, role: 'user', kind: 'command', timestamp, text: command })
        else outputOf(e.content)
      }
    }
  })

  for (const call of calls) {
    const isError = call.id ? results.get(call.id) : undefined
    if (isError !== undefined) call.status = isError ? 'error' : 'ok'
  }

  const visible = messages.filter((m) => m.text || m.tools.length)
  const truncated = visible.length > maxMessages
  return { messages: truncated ? visible.slice(-maxMessages) : visible, truncated, total: visible.length }
}

/** Longest text per value that is sent to the window (a Read result can be a whole file). */
const MAX_DETAIL_CHARS = 200_000

/** Text of a tool result as Claude saw it; images and other blocks become placeholders. */
function resultText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((block) => {
      const b = block as { type?: unknown; text?: unknown } | null
      if (b?.type === 'text' && typeof b.text === 'string') return b.text
      return `[${typeof b?.type === 'string' ? b.type : 'Inhalt'}]`
    })
    .join('\n')
}

/** The complete input and output of one tool call. Only lines containing the id are parsed. */
export function readToolCall(buf: Buffer, toolUseId: string): TranscriptToolDetail | null {
  const needle = Buffer.from(JSON.stringify(toolUseId), 'utf8')
  let name: string | null = null
  let input: TranscriptToolDetail['input'] = []
  let output: string | null = null
  let isError = false
  let truncated = false
  const limit = (text: string) => {
    if (text.length <= MAX_DETAIL_CHARS) return text
    truncated = true
    return `${text.slice(0, MAX_DETAIL_CHARS)}\n… (${text.length - MAX_DETAIL_CHARS} weitere Zeichen ausgeblendet)`
  }

  for (let at = buf.indexOf(needle); at !== -1; ) {
    const start = buf.lastIndexOf(NEWLINE, at) + 1
    let end = buf.indexOf(NEWLINE, at)
    if (end === -1) end = buf.length
    at = buf.indexOf(needle, end)

    let entry: { message?: { content?: unknown } }
    try {
      entry = JSON.parse(buf.toString('utf8', start, end)) as typeof entry
    } catch {
      continue
    }
    for (const block of Array.isArray(entry.message?.content) ? entry.message.content : []) {
      const b = block as {
        type?: unknown
        id?: unknown
        name?: unknown
        input?: unknown
        tool_use_id?: unknown
        content?: unknown
        is_error?: unknown
      } | null
      if (b?.type === 'tool_use' && b.id === toolUseId) {
        name = str(b.name) ?? 'Tool'
        const params = b.input && typeof b.input === 'object' ? (b.input as Record<string, unknown>) : {}
        input = Object.entries(params).map(([key, value]) => ({
          key,
          value: limit(typeof value === 'string' ? value : JSON.stringify(value, null, 2)),
        }))
      } else if (b?.type === 'tool_result' && b.tool_use_id === toolUseId) {
        output = limit(resultText(b.content))
        isError = b.is_error === true
      }
    }
  }
  if (name === null && output === null) return null
  return { id: toolUseId, name: name ?? 'Tool', input, output, isError, truncated }
}
