/**
 * Worker thread that indexes Claude Code transcripts so the main process (and with it every
 * terminal) never blocks on parsing hundreds of megabytes of JSONL.
 *
 * Results are cached per file (size + mtime) in memory and on disk.
 */
import { readFile, readdir, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { parentPort, workerData } from 'node:worker_threads'
import { readJson, writeJsonAtomic } from '../lib/json-file'
import { parseTranscript, readConversation, readToolCall, type ParsedSummary, type UsageEntry } from './transcript-parser'
import type { IndexerRequest, IndexerResponse, IndexedSession, TokenStatsResult } from './indexer-protocol'

interface CacheEntry {
  size: number
  mtimeMs: number
  summary: ParsedSummary | null
  usage: UsageEntry[]
}

interface CacheFile {
  version: number
  files: Record<string, CacheEntry>
}

const CACHE_VERSION = 2
const { cacheFile } = workerData as { cacheFile: string }
let cache: Record<string, CacheEntry> = {}
let cacheLoaded: Promise<void> | null = null
let saveTimer: NodeJS.Timeout | null = null

function ensureCache(): Promise<void> {
  cacheLoaded ??= readJson<CacheFile>(cacheFile).then((data) => {
    if (data?.version === CACHE_VERSION && data.files && typeof data.files === 'object') cache = data.files
  })
  return cacheLoaded
}

function scheduleSave(): void {
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    saveTimer = null
    void writeJsonAtomic(cacheFile, { version: CACHE_VERSION, files: cache } satisfies CacheFile).catch(() => undefined)
  }, 3000)
}

interface TranscriptFile {
  path: string
  projectKey: string
  sessionId: string
  /** top-level session transcript (vs. subagent transcript) */
  isSession: boolean
}

async function listTranscripts(projectsDir: string, includeSubagents: boolean): Promise<TranscriptFile[]> {
  const out: TranscriptFile[] = []
  let projects: string[]
  try {
    projects = (await readdir(projectsDir, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name)
  } catch {
    return out
  }
  for (const projectKey of projects) {
    const projectDir = join(projectsDir, projectKey)
    let entries
    try {
      entries = await readdir(projectDir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        out.push({ path: join(projectDir, entry.name), projectKey, sessionId: basename(entry.name, '.jsonl'), isSession: true })
      } else if (includeSubagents && entry.isDirectory()) {
        const subDir = join(projectDir, entry.name, 'subagents')
        try {
          for (const sub of await readdir(subDir, { withFileTypes: true })) {
            if (sub.isFile() && sub.name.endsWith('.jsonl')) {
              out.push({ path: join(subDir, sub.name), projectKey, sessionId: entry.name, isSession: false })
            }
          }
        } catch {
          // no subagents folder
        }
      }
    }
  }
  return out
}

type Indexed = { entry: CacheEntry; size: number; mtimeMs: number } | null
const inflight = new Map<string, Promise<Indexed>>()

/** Parses a file at most once at a time, even when several requests need it concurrently. */
function indexFile(file: TranscriptFile): Promise<Indexed> {
  const key = `${file.path}|${file.isSession}`
  let pending = inflight.get(key)
  if (!pending) {
    pending = indexFileNow(file).finally(() => inflight.delete(key))
    inflight.set(key, pending)
  }
  return pending
}

async function indexFileNow(file: TranscriptFile): Promise<Indexed> {
  let st
  try {
    st = await stat(file.path)
  } catch {
    return null
  }
  const cached = cache[file.path]
  if (cached && cached.size === st.size && cached.mtimeMs === st.mtimeMs && (cached.summary || !file.isSession)) {
    return { entry: cached, size: st.size, mtimeMs: st.mtimeMs }
  }
  let buf: Buffer
  try {
    buf = await readFile(file.path)
  } catch {
    return null
  }
  const parsed = parseTranscript(buf, file.sessionId, file.isSession)
  const entry: CacheEntry = {
    size: st.size,
    mtimeMs: st.mtimeMs,
    summary: file.isSession ? parsed.summary : null,
    usage: parsed.usage,
  }
  cache[file.path] = entry
  scheduleSave()
  return { entry, size: st.size, mtimeMs: st.mtimeMs }
}

async function scanSessions(projectsDir: string): Promise<IndexedSession[]> {
  await ensureCache()
  const files = await listTranscripts(projectsDir, false)
  const sessions: IndexedSession[] = []
  for (const file of files) {
    const result = await indexFile(file)
    const summary = result?.entry.summary
    if (!result || !summary) continue
    // Sessions without a single message (e.g. opened and closed immediately) are noise.
    if (summary.messageCount === 0) continue
    sessions.push({
      ...summary,
      projectKey: file.projectKey,
      filePath: file.path,
      sizeBytes: result.size,
      fileUpdatedAt: new Date(result.mtimeMs).toISOString(),
    })
  }
  pruneCache()
  return sessions
}

async function tokenStats(projectsDir: string, days: number): Promise<TokenStatsResult> {
  await ensureCache()
  const files = await listTranscripts(projectsDir, true)
  const since = new Date()
  since.setHours(0, 0, 0, 0)
  since.setDate(since.getDate() - (days - 1))
  const pad = (n: number) => String(n).padStart(2, '0')
  const sinceDay = `${since.getFullYear()}-${pad(since.getMonth() + 1)}-${pad(since.getDate())}`

  const seen = new Set<string>()
  const byDay = new Map<string, [number, number, number, number, number]>()
  const byModel = new Map<string, [number, number, number, number, number]>()
  const sessionIds = new Set<string>()

  for (const file of files) {
    const result = await indexFile(file)
    if (!result) continue
    let used = false
    for (const [key, day, model, input, output, cacheCreation, cacheRead] of result.entry.usage) {
      if (day < sinceDay || seen.has(key)) continue
      seen.add(key)
      used = true
      for (const [map, k] of [
        [byDay, day],
        [byModel, model],
      ] as const) {
        const acc = map.get(k) ?? [0, 0, 0, 0, 0]
        acc[0] += input
        acc[1] += output
        acc[2] += cacheCreation
        acc[3] += cacheRead
        acc[4] += 1
        map.set(k, acc)
      }
    }
    if (used) sessionIds.add(file.sessionId)
  }
  pruneCache()
  return {
    days: [...byDay.entries()].sort(([a], [b]) => a.localeCompare(b)),
    models: [...byModel.entries()].sort(([, a], [, b]) => b[1] + b[0] - (a[1] + a[0])),
    sessionCount: sessionIds.size,
  }
}

/** Drops cache entries of files that no longer exist (checked lazily, at most once a minute). */
let lastPrune = 0
function pruneCache(): void {
  const now = Date.now()
  if (now - lastPrune < 60000) return
  lastPrune = now
  void (async () => {
    let removed = false
    for (const path of Object.keys(cache)) {
      try {
        await stat(path)
      } catch {
        delete cache[path]
        removed = true
      }
    }
    if (removed) scheduleSave()
  })()
}

async function handle(request: IndexerRequest): Promise<unknown> {
  switch (request.method) {
    case 'scanSessions':
      return scanSessions(request.projectsDir)
    case 'tokenStats':
      return tokenStats(request.projectsDir, request.days)
    case 'readConversation': {
      const buf = await readFile(request.filePath)
      return readConversation(buf, request.maxMessages)
    }
    case 'readToolCall':
      return readToolCall(await readFile(request.filePath), request.toolUseId)
  }
}

parentPort?.on('message', (message: { id: number; request: IndexerRequest }) => {
  handle(message.request).then(
    (result) => parentPort?.postMessage({ id: message.id, ok: true, result } satisfies IndexerResponse),
    (error: unknown) =>
      parentPort?.postMessage({
        id: message.id,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      } satisfies IndexerResponse),
  )
})
