/**
 * Worker thread that indexes Claude Code transcripts so the main process (and with it every
 * terminal) never blocks on parsing hundreds of megabytes of JSONL.
 *
 * Results are cached per file (size + mtime) in memory and on disk. A transcript that grew (a session
 * at work) is read on from where it was, as long as its scan is still in memory.
 */
import { readFile, readdir, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { parentPort, workerData } from 'node:worker_threads'
import { readJson, writeJsonAtomic } from '../lib/json-file'
import { readAppended } from './read-appended'
import {
  newTranscriptScan,
  readConversation,
  readToolCall,
  scanResult,
  scanTranscript,
  type ParsedSummary,
  type TranscriptScan,
  type UsageEntry,
} from './transcript-parser'
import type { IndexerRequest, IndexerResponse, IndexedSession, TokenStatsResult, TokenTuple } from './indexer-protocol'
import { SearchIndex } from './search-index'

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

// 3: `<synthetic>` replies no longer count as messages; summaries are parsed again once.
// 4: summaries know the worktree a session worked in.
// 5: summaries know the folder `/cd` moved a session to.
const CACHE_VERSION = 5
const { cacheFile, searchCacheFile } = workerData as { cacheFile: string; searchCacheFile: string }
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

const searchIndex = new SearchIndex(searchCacheFile, async (projectsDir) =>
  (await listTranscripts(projectsDir, false)).filter((f) => f.isSession),
)

type Indexed = { entry: CacheEntry; size: number; mtimeMs: number } | null
const inflight = new Map<string, Promise<Indexed>>()

/** A transcript read up to `offset`, the end of its last complete line. */
interface ScanProgress {
  scan: TranscriptScan
  offset: number
}

/**
 * The scans of the transcripts read last, the newest at the end. Sessions at work write to theirs all
 * the time; with the scan kept, only what they appended is read (transcripts get 100 MB and more).
 */
const scans = new Map<string, ScanProgress>()
const MAX_SCANS = 16

/** Reads on from the kept scan where the file continues it, otherwise the whole file. */
async function scanFile(file: TranscriptFile, key: string, size: number): Promise<ScanProgress | null> {
  const kept = scans.get(key)
  scans.delete(key)
  let progress: ScanProgress | null = null
  if (kept && size >= kept.offset) {
    const appended = await readAppended(file.path, kept.offset, size).catch(() => null)
    if (appended) {
      kept.offset += scanTranscript(kept.scan, appended)
      progress = kept
    }
  }
  if (!progress) {
    let buf: Buffer
    try {
      buf = await readFile(file.path)
    } catch {
      return null
    }
    const scan = newTranscriptScan(file.isSession)
    progress = { scan, offset: scanTranscript(scan, buf) }
  }
  scans.set(key, progress)
  for (const old of scans.keys()) {
    if (scans.size <= MAX_SCANS) break
    scans.delete(old)
  }
  return progress
}

/** Parses a file at most once at a time, even when several requests need it concurrently. */
function indexFile(file: TranscriptFile): Promise<Indexed> {
  const key = `${file.path}|${file.isSession}`
  let pending = inflight.get(key)
  if (!pending) {
    pending = indexFileNow(file, key).finally(() => inflight.delete(key))
    inflight.set(key, pending)
  }
  return pending
}

async function indexFileNow(file: TranscriptFile, key: string): Promise<Indexed> {
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
  const progress = await scanFile(file, key, st.size)
  if (!progress) return null
  const parsed = scanResult(progress.scan, file.sessionId)
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
  const byDay = new Map<string, TokenTuple>()
  const byModel = new Map<string, TokenTuple>()
  /** By session (`projectKey` + id), subagents included; the folder is looked up afterwards. */
  const bySession = new Map<string, { projectKey: string; sessionId: string; tokens: TokenTuple }>()

  for (const file of files) {
    const result = await indexFile(file)
    if (!result) continue
    const sessionKey = `${file.projectKey}\n${file.sessionId}`
    for (const [key, day, model, input, output, cacheCreation, cacheRead] of result.entry.usage) {
      if (day < sinceDay || seen.has(key)) continue
      seen.add(key)
      let session = bySession.get(sessionKey)
      if (!session) {
        session = { projectKey: file.projectKey, sessionId: file.sessionId, tokens: [0, 0, 0, 0, 0] }
        bySession.set(sessionKey, session)
      }
      for (const acc of [getOrAdd(byDay, day), getOrAdd(byModel, model), session.tokens]) {
        acc[0] += input
        acc[1] += output
        acc[2] += cacheCreation
        acc[3] += cacheRead
        acc[4] += 1
      }
    }
  }

  // The session's own transcript tells the folder, also for the usage of its subagents.
  const byFolder = new Map<string, { path: string | null; projectKey: string; tokens: TokenTuple; sessions: number }>()
  for (const { projectKey, sessionId, tokens } of bySession.values()) {
    const summary = cache[join(projectsDir, projectKey, `${sessionId}.jsonl`)]?.summary
    const path = summary?.worktree?.originalCwd ?? summary?.cwd ?? null
    const key = path ?? `#${projectKey}`
    const folder = byFolder.get(key) ?? { path, projectKey, tokens: [0, 0, 0, 0, 0], sessions: 0 }
    for (let i = 0; i < tokens.length; i++) folder.tokens[i]! += tokens[i]!
    folder.sessions += 1
    byFolder.set(key, folder)
  }

  pruneCache()
  return {
    days: [...byDay.entries()].sort(([a], [b]) => a.localeCompare(b)),
    models: [...byModel.entries()].sort(([, a], [, b]) => b[1] + b[0] - (a[1] + a[0])),
    folders: [...byFolder.values()].map((f) => [f.path, f.projectKey, f.tokens, f.sessions]),
    sessionCount: new Set([...bySession.values()].map((s) => s.sessionId)).size,
  }
}

function getOrAdd(map: Map<string, TokenTuple>, key: string): TokenTuple {
  let acc = map.get(key)
  if (!acc) {
    acc = [0, 0, 0, 0, 0]
    map.set(key, acc)
  }
  return acc
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
    case 'searchTranscripts':
      return searchIndex.search(request.projectsDir, request.query, request.limit)
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
