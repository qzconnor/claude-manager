/**
 * Parsing of Claude Code transcript files (`<configDir>/projects/<project>/<session>.jsonl`).
 * Pure functions — used by the indexer worker thread (`toolSummary` also by the main process).
 */
import { folderKey, inFolder } from '@shared/folders'
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
]
const NOISE_RE = new RegExp(`<(${NOISE_TAGS.join('|')})>[\\s\\S]*?</\\1>`, 'g')

/** Turns a raw user message into what the user actually typed (or the slash command). */
export function cleanPrompt(raw: string): string {
  const command = /<command-name>([\s\S]*?)<\/command-name>/.exec(raw)
  if (command) {
    const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(raw)
    const name = command[1].trim()
    return `${name.startsWith('/') ? name : `/${name}`}${args?.[1].trim() ? ` ${args[1].trim()}` : ''}`
  }
  const bash = /<bash-input>([\s\S]*?)<\/bash-input>/.exec(raw)
  if (bash) return `! ${bash[1].trim()}`
  return raw.replace(NOISE_RE, '').trim()
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

/** Builds a readable conversation (user prompts, assistant text, tool calls). */
export function readConversation(buf: Buffer, maxMessages: number): { messages: TranscriptMessage[]; truncated: boolean; total: number } {
  const messages: TranscriptMessage[] = []
  const byMessageId = new Map<string, TranscriptMessage>()
  const calls: TranscriptToolCall[] = []
  /** tool_use id → the result was an error */
  const results = new Map<string, boolean>()

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
      const text = cleanPrompt(textOf(message?.content))
      if (!text) return
      messages.push({ uuid, role: 'user', timestamp, text, tools: [], model: null })
      return
    }
    if (e.type === 'assistant') {
      const message = e.message as { id?: unknown; model?: unknown; content?: unknown } | undefined
      const messageId = str(message?.id) ?? uuid
      const model = str(message?.model)
      if (model === '<synthetic>') return
      let target = byMessageId.get(messageId)
      if (!target) {
        target = { uuid, role: 'assistant', timestamp, text: '', tools: [], model }
        byMessageId.set(messageId, target)
        messages.push(target)
      }
      const blocks = Array.isArray(message?.content) ? message.content : []
      for (const block of blocks) {
        if (!block || typeof block !== 'object') continue
        const b = block as { type?: string; id?: unknown; text?: unknown; name?: unknown; input?: unknown }
        if (b.type === 'text' && typeof b.text === 'string' && b.text.trim()) {
          target.text = target.text ? `${target.text}\n\n${b.text}` : b.text
        } else if (b.type === 'tool_use') {
          const name = str(b.name) ?? 'Tool'
          const call: TranscriptToolCall = { id: str(b.id), name, summary: toolSummary(name, b.input), status: null }
          target.tools.push(call)
          calls.push(call)
        }
      }
      return
    }
    if (e.type === 'system' && typeof e.content === 'string' && e.subtype === 'compact_boundary') {
      messages.push({ uuid, role: 'system', timestamp, text: 'Konversation wurde komprimiert (/compact).', tools: [], model: null })
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
