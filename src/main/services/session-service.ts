import { watch, type FSWatcher } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import type { SessionDetail, SessionGroup, SessionSummary, TranscriptToolDetail } from '@shared/types'
import { TypedEmitter } from '../lib/typed-emitter'
import type { ConversationResult, IndexedSession } from '../workers/indexer-protocol'
import type { AccountService } from './account-service'
import type { IndexerClient } from './indexer-client'

type Events = { changed: [accountId: string] }

const MAX_CONVERSATION_MESSAGES = 600
const TOOL_USE_ID_RE = /^[A-Za-z0-9_-]{1,128}$/

export class SessionService extends TypedEmitter<Events> {
  private readonly watchers = new Map<string, { dir: string; watcher: FSWatcher }>()
  private readonly debounce = new Map<string, NodeJS.Timeout>()
  private readonly filePaths = new Map<string, string>()

  constructor(
    private readonly accounts: AccountService,
    private readonly indexer: IndexerClient,
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
