import type { SessionSummary, TerminalInfo, TranscriptMessage } from '@shared/types'
import { type Args, cut, optionalNumber, optionalPath, optionalString, requiredString, ToolError } from '../tool-args'
import { type AppToolDefinition, type AppToolsDeps, localTime, tool } from './tool'

/** The tools sessions_search and session_read: earlier sessions of the user. */

const MAX_SEARCH_RESULTS = 50
const DEFAULT_SEARCH_RESULTS = 10
const MAX_TRANSCRIPT_CHARS = 30_000
const MAX_MESSAGE_CHARS = 4000
const DEFAULT_READ_MESSAGES = 40
const MAX_READ_MESSAGES = 200

export const sessionTools: AppToolDefinition<never>[] = [
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
    run: async (app, session, p) => searchSessions(app.deps, session, p),
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
    run: async (app, session, p) => readSession(app.deps, session, p),
  }),
]

/** sessions_search: earlier sessions with these words or in this folder, newest first. */
export async function searchSessions(deps: AppToolsDeps, session: TerminalInfo, p: SearchParams): Promise<string> {
  const [groups, hits] = await Promise.all([deps.sessions.list(), p.query ? deps.sessions.search(p.query) : Promise.resolve(null)])
  const summaries = new Map<string, SessionSummary>()
  for (const group of groups) for (const summary of group.sessions) summaries.set(`${group.accountId}:${summary.id}`, summary)
  const names = new Map(deps.accounts.list().map((a) => [a.id, a.name]))
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

/** session_read: a part of an earlier session's conversation. */
export async function readSession(deps: AppToolsDeps, session: TerminalInfo, p: ReadParams): Promise<string> {
  let accountId = p.accountId
  if (!accountId) {
    const groups = await deps.sessions.list()
    accountId = groups.find((g) => g.sessions.some((s) => s.id === p.sessionId))?.accountId
    if (!accountId) throw new ToolError(`There is no session ${p.sessionId}. Find sessions with sessions_search.`)
  }
  let detail
  try {
    detail = await deps.sessions.get(accountId, p.sessionId)
  } catch {
    throw new ToolError(`There is no session ${p.sessionId} in account ${accountId}. Find sessions with sessions_search.`)
  }
  const name = deps.accounts.list().find((a) => a.id === accountId)?.name ?? accountId
  const own = p.sessionId === session.sessionId ? ' This is your current session.' : ''
  const s = detail.summary
  const head = [
    `Session ${JSON.stringify(s.title)} (${s.id}), account ${name}.${own}`,
    `Folder: ${s.cwd ?? 'unknown'}${s.gitBranch ? `, branch ${s.gitBranch}` : ''}; started ${localTime(s.createdAt)}, last active ${localTime(s.updatedAt)}.`,
  ].join('\n')
  return `${head}\n${formatTranscript(detail.messages, p.offset, p.limit, detail.truncated)}`
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

function parseSearch(args: Args): SearchParams {
  const query = optionalString(args, 'query', 500)?.trim() || undefined
  const folder = optionalPath(args, 'folder')
  if (!query && !folder) throw new ToolError('Give query, folder or both.')
  const limit = optionalNumber(args, 'limit', 1, MAX_SEARCH_RESULTS)
  return { query, folder, limit: limit === undefined ? DEFAULT_SEARCH_RESULTS : Math.floor(limit) }
}

function parseRead(args: Args): ReadParams {
  const sessionId = requiredString(args, 'sessionId', 128).trim()
  if (!/^[A-Za-z0-9_-]+$/.test(sessionId)) throw new ToolError('sessionId must be the id of a session, from sessions_search.')
  const accountId = optionalString(args, 'accountId', 200)?.trim() || undefined
  const offset = optionalNumber(args, 'offset', -100_000, 100_000)
  const limit = optionalNumber(args, 'limit', 1, MAX_READ_MESSAGES)
  return { sessionId, accountId, offset: Math.trunc(offset ?? 0), limit: limit === undefined ? DEFAULT_READ_MESSAGES : Math.floor(limit) }
}
