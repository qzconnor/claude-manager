/**
 * Full-text index for the session search: the prompts and answers of every transcript as plain text.
 * Tool calls and their output are left out, which shrinks gigabytes of transcripts to a few megabytes,
 * so the whole index stays in memory and every search is a plain substring scan.
 * It is kept on disk as well; transcripts only grow, so a changed one is read from where it was left.
 */
import { readFile, stat } from 'node:fs/promises'
import { sep } from 'node:path'
import { foldCase, searchTerms } from '@shared/utils'
import { readJson, writeJsonAtomic } from '../lib/json-file'
import { ThrottledSave } from '../lib/throttled-save'
import type { TranscriptSearchHit } from './indexer-protocol'
import { readAppended } from './read-appended'
import { collectSearchText, SEARCH_ASSISTANT, SEARCH_USER } from './transcript-parser'

interface Entry {
  size: number
  mtimeMs: number
  /** Bytes read so far, always the end of a complete line. */
  offset: number
  text: string
}

interface CacheFile {
  version: number
  files: Record<string, Entry>
}

export interface SearchFile {
  path: string
  sessionId: string
}

const CACHE_VERSION = 1
/** While typing, the transcripts are checked for changes at most this often. */
const REFRESH_INTERVAL_MS = 2000
/** Characters of context before the match and the snippet's length. */
const SNIPPET_BEFORE = 50
const SNIPPET_LENGTH = 200

export class SearchIndex {
  private entries: Record<string, Entry> = {}
  /** Lower-case text of an entry, made when it is first searched. */
  private readonly folded = new WeakMap<Entry, string>()
  private loaded: Promise<void> | null = null
  /** Written 5 seconds after a change, then at most once a minute (see the transcript index). */
  private readonly saver = new ThrottledSave(
    () => void writeJsonAtomic(this.cacheFile, { version: CACHE_VERSION, files: this.entries } satisfies CacheFile).catch(() => undefined),
    5000,
    60_000,
  )
  private readonly refreshes = new Map<string, { at: number; pending: boolean; files: Promise<SearchFile[]> }>()

  constructor(
    private readonly cacheFile: string,
    private readonly listFiles: (projectsDir: string) => Promise<SearchFile[]>,
  ) {}

  /** Sessions whose conversation contains every word of `query`, newest first. */
  async search(projectsDir: string, query: string, limit: number): Promise<TranscriptSearchHit[]> {
    const files = await this.refresh(projectsDir)
    const terms = searchTerms(query)
    if (terms.length === 0) return []
    const found: { sessionId: string; entry: Entry; folded: string }[] = []
    for (const file of files) {
      const entry = this.entries[file.path]
      if (!entry?.text) continue
      const folded = this.foldedText(entry)
      if (terms.every((term) => folded.includes(term))) found.push({ sessionId: file.sessionId, entry, folded })
    }
    found.sort((a, b) => b.entry.mtimeMs - a.entry.mtimeMs)
    return found
      .slice(0, limit)
      .map(({ sessionId, entry, folded }) => ({ sessionId, ...snippet(entry.text, folded, terms) }))
  }

  /** Brings one projects folder up to date; searches while it runs or shortly after share the result. */
  private refresh(projectsDir: string): Promise<SearchFile[]> {
    const last = this.refreshes.get(projectsDir)
    if (last && (last.pending || Date.now() - last.at < REFRESH_INTERVAL_MS)) return last.files
    const state = { at: 0, pending: true, files: Promise.resolve<SearchFile[]>([]) }
    state.files = this.refreshNow(projectsDir).finally(() => {
      state.pending = false
      state.at = Date.now()
    })
    this.refreshes.set(projectsDir, state)
    return state.files
  }

  private async refreshNow(projectsDir: string): Promise<SearchFile[]> {
    this.loaded ??= this.load()
    await this.loaded
    const files = await this.listFiles(projectsDir)
    let changed = false
    for (const file of files) {
      if (await this.update(file.path)) changed = true
    }
    // Transcripts that were deleted.
    const present = new Set(files.map((f) => f.path))
    const prefix = projectsDir.endsWith(sep) ? projectsDir : projectsDir + sep
    for (const path of Object.keys(this.entries)) {
      if (path.startsWith(prefix) && !present.has(path)) {
        delete this.entries[path]
        changed = true
      }
    }
    if (changed) this.saver.schedule()
    return files
  }

  /** Reads what is new in a transcript; true when its entry changed. */
  private async update(path: string): Promise<boolean> {
    let st
    try {
      st = await stat(path)
    } catch {
      return false
    }
    const entry = this.entries[path]
    if (entry && entry.size === st.size && entry.mtimeMs === st.mtimeMs) return false
    try {
      const appended = entry && st.size >= entry.offset ? await readAppended(path, entry.offset, st.size) : null
      if (entry && appended) {
        const { text, end } = collectSearchText(appended)
        this.entries[path] = { size: st.size, mtimeMs: st.mtimeMs, offset: entry.offset + end, text: entry.text + text }
      } else {
        const { text, end } = collectSearchText(await readFile(path))
        this.entries[path] = { size: st.size, mtimeMs: st.mtimeMs, offset: end, text }
      }
      return true
    } catch {
      return false
    }
  }

  private foldedText(entry: Entry): string {
    let folded = this.folded.get(entry)
    if (folded === undefined) {
      folded = foldCase(entry.text)
      this.folded.set(entry, folded)
    }
    return folded
  }

  private async load(): Promise<void> {
    const data = await readJson<CacheFile>(this.cacheFile)
    if (data?.version !== CACHE_VERSION || !data.files || typeof data.files !== 'object') return
    for (const [path, entry] of Object.entries(data.files)) {
      if (typeof entry?.text === 'string' && typeof entry.offset === 'number' && typeof entry.size === 'number') {
        this.entries[path] = entry
      }
    }
    void this.dropMissing()
  }

  /**
   * Drops the text of transcripts that are gone. A search only tidies up the folder it searches: the
   * folders of a removed account, or one no longer searched, would otherwise stay in the index forever.
   */
  private async dropMissing(): Promise<void> {
    let changed = false
    for (const path of Object.keys(this.entries)) {
      try {
        await stat(path)
      } catch {
        delete this.entries[path]
        changed = true
      }
    }
    if (changed) this.saver.schedule()
  }
}

const WORD_CHAR = /[\p{L}\p{N}]/u

/**
 * The longest word's first match with some context, within the message it is in.
 * A match at the start of a word goes first: "git" rather shows "git push" than "digital".
 */
function snippet(text: string, folded: string, terms: string[]): Omit<TranscriptSearchHit, 'sessionId'> {
  const term = terms.reduce((a, b) => (b.length > a.length ? b : a))
  let hit = -1
  let matches = 0
  for (let at = folded.indexOf(term); at !== -1; at = folded.indexOf(term, at + term.length)) {
    matches++
    if (hit === -1 && (at === 0 || !WORD_CHAR.test(folded[at - 1]))) hit = at
  }
  if (hit === -1) hit = folded.indexOf(term)

  const marker = Math.max(folded.lastIndexOf(SEARCH_USER, hit), folded.lastIndexOf(SEARCH_ASSISTANT, hit))
  const messageStart = marker + 1
  const ends = [folded.indexOf(SEARCH_USER, hit), folded.indexOf(SEARCH_ASSISTANT, hit)].filter((i) => i !== -1)
  const messageEnd = ends.length ? Math.min(...ends) : folded.length

  // foldCase keeps the length, so positions in `folded` hold in `text`; should that ever fail,
  // the snippet is taken from the lower-case text.
  const source = folded.length === text.length ? text : folded
  let from = Math.max(messageStart, hit - SNIPPET_BEFORE)
  if (from > messageStart) {
    // Start at a word.
    const space = source.slice(from, hit).search(/\s/)
    if (space !== -1) from += space + 1
  }
  const to = Math.min(messageEnd, Math.max(from + SNIPPET_LENGTH, hit + term.length))
  const body = source
    .slice(from, to)
    .replace(/\*\*|`/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  return {
    role: folded[marker] === SEARCH_ASSISTANT ? 'assistant' : 'user',
    snippet: `${from > messageStart ? '…' : ''}${body}${to < messageEnd ? '…' : ''}`,
    matches,
  }
}
