/**
 * Parsing of Claude Code transcript files (`<configDir>/projects/<project>/<session>.jsonl`).
 * Pure functions — used by the indexer worker thread.
 */
import type { TranscriptMessage, TranscriptToolCall, TranscriptToolDetail } from '@shared/types'

export interface ParsedSummary {
  id: string
  cwd: string | null
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
export function parseTranscript(buf: Buffer, sessionId: string, withSummary: boolean): ParseResult {
  let aiTitle: string | null = null
  let customTitle: string | null = null
  let legacySummary: string | null = null
  let lastPrompt: string | null = null
  let firstPrompt: string | null = null
  let lastUserPrompt: string | null = null
  let cwd: string | null = null
  let gitBranch: string | null = null
  let model: string | null = null
  let version: string | null = null
  let createdAt: string | null = null
  let updatedAt: string | null = null
  let continuedIn: string | null = null
  let userMessages = 0
  const assistantIds = new Set<string>()
  const usageKeys = new Set<string>()
  const usage: UsageEntry[] = []

  forEachEntry(buf, (e) => {
    const type = e.type
    const timestamp = str(e.timestamp)
    if (timestamp) {
      if (!createdAt) createdAt = timestamp
      updatedAt = timestamp
    }
    if (withSummary) {
      if (!cwd) cwd = str(e.cwd)
      gitBranch = str(e.gitBranch) ?? gitBranch
      version = str(e.version) ?? version
    }

    switch (type) {
      case 'ai-title':
        aiTitle = str(e.aiTitle) ?? aiTitle
        break
      case 'custom-title':
        customTitle = str(e.customTitle) ?? customTitle
        break
      case 'summary':
        legacySummary = str(e.summary) ?? legacySummary
        break
      case 'last-prompt':
        lastPrompt = str(e.lastPrompt) ?? lastPrompt
        break
      case 'continued-in':
        continuedIn = str(e.continuedInSessionId) ?? continuedIn
        break
      case 'user': {
        if (!withSummary || e.isMeta || e.isSidechain) break
        const message = e.message as { content?: unknown } | undefined
        const prompt = cleanPrompt(textOf(message?.content))
        if (!prompt) break
        userMessages++
        if (!firstPrompt) firstPrompt = shorten(prompt, 300)
        lastUserPrompt = prompt
        break
      }
      case 'assistant': {
        const message = e.message as
          | { id?: unknown; model?: unknown; usage?: Record<string, unknown> }
          | undefined
        const messageId = str(message?.id)
        const messageModel = str(message?.model)
        if (withSummary && !e.isSidechain && messageId && !assistantIds.has(messageId)) {
          assistantIds.add(messageId)
          if (messageModel && messageModel !== '<synthetic>') model = messageModel
        }
        const u = message?.usage
        if (u && messageId && messageModel !== '<synthetic>') {
          const key = `${messageId}:${str(e.requestId) ?? ''}`
          if (usageKeys.has(key)) break
          usageKeys.add(key)
          const day = timestamp ? localDay(timestamp) : null
          if (!day) break
          usage.push([
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
  })

  const fallbackPrompt = lastPrompt ?? lastUserPrompt
  const title = customTitle ?? aiTitle ?? legacySummary ?? firstPrompt ?? 'Ohne Titel'
  return {
    summary: {
      id: sessionId,
      cwd,
      title: shorten(title, 160),
      firstPrompt,
      lastPrompt: fallbackPrompt ? shorten(fallbackPrompt, 300) : null,
      gitBranch,
      model,
      messageCount: userMessages + assistantIds.size,
      createdAt,
      updatedAt,
      version,
      continuedIn,
    },
    usage,
  }
}

function toolSummary(name: string, input: unknown): string {
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
export function readConversation(buf: Buffer, maxMessages: number): { messages: TranscriptMessage[]; truncated: boolean } {
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
  return { messages: truncated ? visible.slice(-maxMessages) : visible, truncated }
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
