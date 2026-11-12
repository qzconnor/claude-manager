import { watch, type FSWatcher } from 'node:fs'
import { mkdir, stat } from 'node:fs/promises'
import { shell } from 'electron'
import type {
  SessionDetail,
  SessionGroup,
  SessionRef,
  SessionFileEdit,
  SessionRemoveResult,
  SessionSearchHit,
  SessionSummary,
  TranscriptToolDetail,
} from '@shared/types'
import { CONVERSATION_PAGE_MESSAGES } from '@shared/defaults'
import { folderKey, windowsPath } from '@shared/folders'
import { liveSessionIds, sessionFiles } from '../lib/session-files'
import { moveSession, moveSessions } from '../lib/session-move'
import { TypedEmitter } from '../lib/typed-emitter'
import type { ConversationResult, FileEditHit, IndexedSession, TranscriptSearchHit } from '../workers/indexer-protocol'
import type { AccountService } from './account-service'
import type { IndexerClient } from './indexer-client'
import type { SessionNames } from './session-names'
import type { TerminalService } from './terminal-service'

type Events = { changed: [accountId: string] }

/** The most messages of a history the window gets at once, however many it asks for. */
const MAX_CONVERSATION_MESSAGES = 100_000
/** Hits per account; a search with more is too vague to go through all of them. */
const MAX_SEARCH_HITS = 200
/** Sessions that changed a file the menu lists; older ones hardly matter any more. */
const MAX_FILE_EDITS = 50
const TOOL_USE_ID_RE = /^[A-Za-z0-9_-]{1,128}$/
/** Files moved to the recycle bin at the same time. */
const TRASH_CONCURRENCY = 6

/**
 * A session's folder as the app shows, groups and resumes it: on Windows `F:\Projekte` also when the
 * session wrote `/f/Projekte` (Claude Code in Git Bash) or `f:\Projekte`.
 */
const localPath = process.platform === 'win32' ? windowsPath : (path: string) => path

/** A projects folder that couldn't be watched (made, or its watcher failed) is tried again after this long. */
const WATCH_RETRY_MS = 30_000

export class SessionService extends TypedEmitter<Events> {
  private readonly watchers = new Map<string, { dir: string; watcher: FSWatcher }>()
  private retryTimer: NodeJS.Timeout | null = null
  private disposed = false
  private readonly debounce = new Map<string, NodeJS.Timeout>()
  private readonly filePaths = new Map<string, string>()
  /** Each account's projects folder, as the lists last knew it. */
  private projectsDirs = new Map<string, string>()

  constructor(
    private readonly accounts: AccountService,
    private readonly indexer: IndexerClient,
    private readonly terminals: TerminalService,
    private readonly names: SessionNames,
  ) {
    super()
    accounts.on('changed', () => {
      this.syncWatchers()
      this.reportMovedAccounts()
    })
    // A session named or renamed: the lists show it at once. Which account has it doesn't matter, it is cheap.
    names.on('changed', () => {
      for (const account of this.accounts.list()) this.emit('changed', account.id)
    })
  }

  /** Names the session (empty: it shows Claude Code's title again); also its tabs and the API show it. */
  rename(sessionId: string, name: string): void {
    this.names.set(sessionId, name)
  }

  init(): void {
    this.projectsDirs = this.currentDirs()
    this.syncWatchers()
  }

  dispose(): void {
    this.disposed = true
    if (this.retryTimer) clearTimeout(this.retryTimer)
    for (const { watcher } of this.watchers.values()) watcher.close()
    this.watchers.clear()
    for (const timer of this.debounce.values()) clearTimeout(timer)
  }

  async list(accountId?: string): Promise<SessionGroup[]> {
    const targets = this.accounts.list().filter((a) => !accountId || a.id === accountId)
    return Promise.all(
      targets.map(async (account): Promise<SessionGroup> => {
        try {
          const indexed = await this.indexer.request<IndexedSession[]>({
            method: 'scanSessions',
            projectsDir: this.accounts.paths(account.id).projectsDir,
          })
          const sessions = indexed.map((s) => this.toSummary(account.id, s))
          sessions.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
          return { accountId: account.id, sessions, error: null }
        } catch (error) {
          return { accountId: account.id, sessions: [], error: error instanceof Error ? error.message : String(error) }
        }
      }),
    )
  }

  /** The session with the newest `limit` messages of its history. */
  async get(accountId: string, sessionId: string, limit = CONVERSATION_PAGE_MESSAGES): Promise<SessionDetail> {
    // Re-scan first (cheap thanks to the worker cache) so the summary and file path are current.
    const [group] = await this.list(accountId)
    const summary = group?.sessions.find((s) => s.id === sessionId)
    const filePath = this.filePaths.get(`${accountId}:${sessionId}`)
    if (!summary || !filePath) throw new Error('Session nicht gefunden.')
    const conversation = await this.indexer.request<ConversationResult>({
      method: 'readConversation',
      filePath,
      maxMessages: Math.max(1, Math.min(Math.floor(limit), MAX_CONVERSATION_MESSAGES)),
    })
    return { summary, messages: conversation.messages, truncated: conversation.truncated, total: conversation.total }
  }

  /** Full-text search through the conversations of all accounts (see the indexer's search index). */
  async search(query: string): Promise<SessionSearchHit[]> {
    const groups = await Promise.all(
      this.accounts.list().map(async (account) => {
        try {
          const hits = await this.indexer.request<TranscriptSearchHit[]>({
            method: 'searchTranscripts',
            projectsDir: this.accounts.paths(account.id).projectsDir,
            query,
            limit: MAX_SEARCH_HITS,
          })
          return hits.map((hit): SessionSearchHit => ({ accountId: account.id, ...hit }))
        } catch {
          return []
        }
      }),
    )
    return groups.flat()
  }

  /** The sessions of all accounts that changed the file at `path`, the latest change first. */
  async editedBy(path: string): Promise<SessionFileEdit[]> {
    // Accounts may keep their sessions in the same folder: it is asked once.
    const dirs = new Map<string, string>()
    for (const account of this.accounts.list()) {
      const dir = this.accounts.paths(account.id).projectsDir
      if (!dirs.has(dir)) dirs.set(dir, account.id)
    }
    const groups = await Promise.all(
      [...dirs].map(async ([projectsDir, accountId]) => {
        try {
          const hits = await this.indexer.request<FileEditHit[]>({ method: 'editedBy', projectsDir, path })
          return hits.map((hit): SessionFileEdit => ({ session: this.toSummary(accountId, hit.session), changedAt: hit.at }))
        } catch {
          return []
        }
      }),
    )
    return groups
      .flat()
      .sort((a, b) => b.changedAt.localeCompare(a.changedAt))
      .slice(0, MAX_FILE_EDITS)
  }

  /** Complete input and output of one tool call, loaded when it is expanded in the transcript. */
  async toolCall(accountId: string, sessionId: string, toolUseId: string): Promise<TranscriptToolDetail | null> {
    if (!TOOL_USE_ID_RE.test(toolUseId)) throw new Error('Ungültige Tool-ID.')
    let filePath = this.filePaths.get(`${accountId}:${sessionId}`)
    if (!filePath) {
      await this.list(accountId)
      filePath = this.filePaths.get(`${accountId}:${sessionId}`)
    }
    if (!filePath) throw new Error('Session nicht gefunden.')
    return this.indexer.request<TranscriptToolDetail | null>({ method: 'readToolCall', filePath, toolUseId })
  }

  /**
   * Moves sessions to the recycle bin, so they can still be restored from there.
   * Sessions open in a tab (also an ended one, it may be resumed) or in a Claude Code running
   * elsewhere stay: Claude Code would write the transcript again.
   */
  async remove(refs: SessionRef[]): Promise<SessionRemoveResult> {
    const result: SessionRemoveResult = { removed: [], removedBytes: 0, inUse: [], failed: [], error: null }
    const tabs = new Set(
      this.terminals.list().flatMap((t) => [t.sessionId, t.resumeSessionId].map((id) => id && `${t.accountId}:${id}`)),
    )
    const byAccount = new Map<string, SessionRef[]>()
    for (const ref of refs) {
      const list = byAccount.get(ref.accountId)
      if (list) list.push(ref)
      else byAccount.set(ref.accountId, [ref])
    }
    const jobs: (() => Promise<void>)[] = []
    for (const [accountId, sessions] of byAccount) {
      const paths = this.accounts.paths(accountId)
      // Re-scan first: the file paths are only known for listed sessions.
      const [group] = await this.list(accountId)
      const known = new Map(group?.sessions.map((s) => [s.id, s]))
      const live = await liveSessionIds(paths.sessionsDir)
      for (const ref of sessions) {
        const summary = known.get(ref.sessionId)
        const transcript = this.filePaths.get(`${accountId}:${ref.sessionId}`)
        if (!summary || !transcript) continue
        if (tabs.has(`${accountId}:${ref.sessionId}`) || live.has(ref.sessionId)) {
          result.inUse.push(ref)
          continue
        }
        jobs.push(async () => {
          try {
            // The transcript first: once it is gone, the session is gone for Claude Code too.
            await shell.trashItem(transcript)
          } catch (error) {
            result.failed.push(ref)
            result.error ??= error instanceof Error ? error.message : String(error)
            return
          }
          this.filePaths.delete(`${accountId}:${ref.sessionId}`)
          result.removed.push(ref)
          result.removedBytes += summary.sizeBytes
          for (const extra of await sessionFiles(paths, ref.sessionId, transcript)) {
            await shell.trashItem(extra).catch(() => undefined)
          }
        })
      }
    }
    await Promise.all(
      Array.from({ length: Math.min(TRASH_CONCURRENCY, jobs.length) }, async () => {
        for (let job = jobs.shift(); job; job = jobs.shift()) await job()
      }),
    )
    for (const accountId of new Set(result.removed.map((r) => r.accountId))) this.emit('changed', accountId)
    return result
  }

  /**
   * The folder `from` is now `to`: the sessions of every account that worked in it (or below it) go
   * along, so they continue there. Returns how many moved; those a running Claude Code has open stay.
   */
  async relocate(from: string, to: string): Promise<number> {
    let moved = 0
    // Accounts can share a config dir: its sessions move once.
    const done = new Set<string>()
    for (const account of this.accounts.list()) {
      const paths = this.accounts.paths(account.id)
      if (done.has(paths.projectsDir)) continue
      done.add(paths.projectsDir)
      try {
        const [indexed, live] = await Promise.all([
          this.indexer.request<IndexedSession[]>({ method: 'scanSessions', projectsDir: paths.projectsDir }),
          liveSessionIds(paths.sessionsDir),
        ])
        const sessions = indexed.map((s) => ({ id: s.id, cwd: s.cwd && localPath(s.cwd), filePath: s.filePath }))
        const result = await moveSessions(paths.projectsDir, sessions, from, to, live)
        if (result.moved > 0) this.emit('changed', account.id)
        moved += result.moved
      } catch (error) {
        console.warn(`[sessions] sessions of ${account.name} could not move along`, error)
      }
    }
    return moved
  }

  /**
   * The session goes on in the folder `to`, as after `/cd` in Claude Code: its transcript moves into the
   * project folder of `to`, so Claude Code resumes it there. Not while a Claude Code has it open, it
   * would go on writing where it was: there `/cd` moves it.
   */
  async move(accountId: string, sessionId: string, to: string): Promise<void> {
    const folder = await stat(to).catch(() => null)
    if (!folder?.isDirectory()) throw new Error(`Den Ordner gibt es nicht: ${to}`)
    const paths = this.accounts.paths(accountId)
    // Re-scan first: the file paths are only known for listed sessions.
    const [group] = await this.list(accountId)
    const summary = group?.sessions.find((s) => s.id === sessionId)
    const filePath = this.filePaths.get(`${accountId}:${sessionId}`)
    if (!summary || !filePath) throw new Error('Session nicht gefunden.')
    if (summary.cwd && folderKey(summary.cwd) === folderKey(to)) throw new Error('Die Session ist schon in diesem Ordner.')
    if ((await liveSessionIds(paths.sessionsDir)).has(sessionId)) {
      throw new Error('Die Session läuft gerade in einem Claude Code außerhalb der App. Beende es dort, oder verschiebe sie dort mit /cd.')
    }
    if (!(await moveSession(paths.projectsDir, { id: sessionId, cwd: summary.cwd, filePath }, to))) {
      throw new Error('Im neuen Ordner liegt schon eine Kopie dieser Session.')
    }
    this.filePaths.delete(`${accountId}:${sessionId}`)
    this.terminals.followMovedSession(accountId, sessionId, to)
    this.emit('changed', accountId)
  }

  private toSummary(accountId: string, s: IndexedSession): SessionSummary {
    this.filePaths.set(`${accountId}:${s.id}`, s.filePath)
    const name = this.names.get(s.id)
    return {
      id: s.id,
      accountId,
      projectKey: s.projectKey,
      cwd: s.cwd && localPath(s.cwd),
      worktree: s.worktree ? { ...s.worktree, path: localPath(s.worktree.path), originalCwd: localPath(s.worktree.originalCwd) } : null,
      title: name ?? s.title,
      name,
      firstPrompt: s.firstPrompt,
      lastPrompt: s.lastPrompt,
      gitBranch: s.gitBranch,
      model: s.model,
      messageCount: s.messageCount,
      messageCountExact: true,
      createdAt: s.createdAt ?? s.fileUpdatedAt,
      updatedAt: s.updatedAt ?? s.fileUpdatedAt,
      sizeBytes: s.sizeBytes,
      version: s.version,
    }
  }

  private currentDirs(): Map<string, string> {
    return new Map(this.accounts.list().map((a) => [a.id, this.accounts.paths(a.id).projectsDir]))
  }

  /**
   * Accounts that came, went or keep their sessions in another folder now: their lists change all at
   * once, without a change in the folder the watcher would see (a new account with an existing folder).
   */
  private reportMovedAccounts(): void {
    if (this.disposed) return
    const dirs = this.currentDirs()
    for (const id of new Set([...this.projectsDirs.keys(), ...dirs.keys()])) {
      if (this.projectsDirs.get(id) !== dirs.get(id)) this.emit('changed', id)
    }
    this.projectsDirs = dirs
  }

  /** Watches every account's projects folder and reports changes (debounced). */
  private syncWatchers(): void {
    if (this.disposed) return
    const wanted = this.currentDirs()
    for (const [id, entry] of this.watchers) {
      if (wanted.get(id) !== entry.dir) {
        entry.watcher.close()
        this.watchers.delete(id)
      }
    }
    for (const [id, dir] of wanted) {
      if (this.watchers.has(id)) continue
      void mkdir(dir, { recursive: true })
        .then(() => {
          if (this.watchers.has(id) || wanted.get(id) !== dir) return
          const watcher = watch(dir, { recursive: true }, (_event, file) => {
            if (file && !String(file).endsWith('.jsonl')) return
            this.schedule(id)
          })
          watcher.on('error', () => {
            watcher.close()
            if (this.watchers.get(id)?.watcher === watcher) this.watchers.delete(id)
            // Deleted with the folder, or the drive was gone for a moment: the lists keep up again later.
            this.retryWatchers()
          })
          this.watchers.set(id, { dir, watcher })
        })
        .catch(() => this.retryWatchers())
    }
  }

  private retryWatchers(): void {
    if (this.disposed || this.retryTimer) return
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null
      this.syncWatchers()
    }, WATCH_RETRY_MS)
  }

  private schedule(accountId: string): void {
    const existing = this.debounce.get(accountId)
    if (existing) clearTimeout(existing)
    this.debounce.set(
      accountId,
      setTimeout(() => {
        this.debounce.delete(accountId)
        this.emit('changed', accountId)
      }, 2500),
    )
  }
}
