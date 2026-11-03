import { watch, type FSWatcher } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { shell } from 'electron'
import type {
  SessionDetail,
  SessionGroup,
  SessionRef,
  SessionRemoveResult,
  SessionSearchHit,
  SessionSummary,
  TranscriptToolDetail,
} from '@shared/types'
import { liveSessionIds, sessionFiles } from '../lib/session-files'
import { TypedEmitter } from '../lib/typed-emitter'
import type { ConversationResult, IndexedSession, TranscriptSearchHit } from '../workers/indexer-protocol'
import type { AccountService } from './account-service'
import type { IndexerClient } from './indexer-client'
import type { TerminalService } from './terminal-service'

type Events = { changed: [accountId: string] }

const MAX_CONVERSATION_MESSAGES = 600
/** Hits per account; a search with more is too vague to go through all of them. */
const MAX_SEARCH_HITS = 200
const TOOL_USE_ID_RE = /^[A-Za-z0-9_-]{1,128}$/
/** Files moved to the recycle bin at the same time. */
const TRASH_CONCURRENCY = 6

export class SessionService extends TypedEmitter<Events> {
  private readonly watchers = new Map<string, { dir: string; watcher: FSWatcher }>()
  private readonly debounce = new Map<string, NodeJS.Timeout>()
  private readonly filePaths = new Map<string, string>()

  constructor(
    private readonly accounts: AccountService,
    private readonly indexer: IndexerClient,
    private readonly terminals: TerminalService,
  ) {
    super()
    accounts.on('changed', () => this.syncWatchers())
  }

  init(): void {
    this.syncWatchers()
  }

  dispose(): void {
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

  async get(accountId: string, sessionId: string): Promise<SessionDetail> {
    // Re-scan first (cheap thanks to the worker cache) so the summary and file path are current.
    const [group] = await this.list(accountId)
    const summary = group?.sessions.find((s) => s.id === sessionId)
    const filePath = this.filePaths.get(`${accountId}:${sessionId}`)
    if (!summary || !filePath) throw new Error('Session nicht gefunden.')
    const conversation = await this.indexer.request<ConversationResult>({
      method: 'readConversation',
      filePath,
      maxMessages: MAX_CONVERSATION_MESSAGES,
    })
    return { summary, messages: conversation.messages, truncated: conversation.truncated }
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

  private toSummary(accountId: string, s: IndexedSession): SessionSummary {
    this.filePaths.set(`${accountId}:${s.id}`, s.filePath)
    return {
      id: s.id,
      accountId,
      projectKey: s.projectKey,
      cwd: s.cwd,
      title: s.title,
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

  /** Watches every account's projects folder and reports changes (debounced). */
  private syncWatchers(): void {
    const wanted = new Map(this.accounts.list().map((a) => [a.id, this.accounts.paths(a.id).projectsDir]))
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
            this.watchers.delete(id)
          })
          this.watchers.set(id, { dir, watcher })
        })
        .catch(() => undefined)
    }
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
