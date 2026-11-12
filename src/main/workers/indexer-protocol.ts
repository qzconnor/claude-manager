import type { TranscriptMessage } from '@shared/types'
import type { ParsedSummary } from './transcript-parser'

export type IndexerRequest =
  | { method: 'scanSessions'; projectsDir: string }
  | { method: 'tokenStats'; projectsDir: string; days: number }
  | { method: 'readConversation'; filePath: string; maxMessages: number }
  | { method: 'readToolCall'; filePath: string; toolUseId: string }
  /** An empty query only brings the search index up to date. */
  | { method: 'searchTranscripts'; projectsDir: string; query: string; limit: number }
  /** The sessions that changed a file (absolute path) with Claude's Edit or Write. */
  | { method: 'editedBy'; projectsDir: string; path: string }
  /**
   * What a session changed prompt by prompt (`historyDir`: its folder of Claude Code's file history,
   * `cwd`: its folder, for the paths of older versions).
   */
  | { method: 'sessionChanges'; filePath: string; historyDir: string; cwd: string | null }
  | { method: 'rewindPreview'; filePath: string; historyDir: string; cwd: string | null; turnId: string }
  | { method: 'changeTexts'; filePath: string; historyDir: string; cwd: string | null; turnId: string; path: string; kind: 'turn' | 'rewind' }
  /** Answered between two files: whether the worker is still alive while a request takes long. */
  | { method: 'ping' }

export type IndexerResponse =
  | { id: number; ok: true; result: unknown }
  | { id: number; ok: false; error: string }

export interface IndexedSession extends ParsedSummary {
  projectKey: string
  filePath: string
  sizeBytes: number
  fileUpdatedAt: string
}

/** A session that changed a file, and when it changed it last. */
export interface FileEditHit {
  session: IndexedSession
  at: string
}

/** The cost in US dollars at the API's prices, without the answers of models the app has no price for. */
export type TokenTuple = [input: number, output: number, cacheCreation: number, cacheRead: number, messages: number, cost: number]

/** One session with its subagents; the folder, title and model as its own transcript records them. */
export interface SessionTokenRow {
  projectKey: string
  sessionId: string
  path: string | null
  title: string | null
  model: string | null
  tokens: TokenTuple
}

/** Aggregates as tuples (see `TokenTuple`). */
export interface TokenStatsResult {
  days: [string, TokenTuple][]
  models: [string, TokenTuple][]
  /**
   * By the folder the sessions ran in (`null` when unknown), with Claude's project folder name and the
   * number of sessions. A worktree session counts for the folder it was started in.
   */
  folders: [string | null, string, TokenTuple, number][]
  /** The most expensive sessions (see `TOP_SESSIONS`). */
  sessions: SessionTokenRow[]
  sessionCount: number
  /** Answers of models without a known price, which no cost includes. */
  unpriced: number
}

/** Newest sessions first. */
export interface TranscriptSearchHit {
  sessionId: string
  role: 'user' | 'assistant'
  snippet: string
  matches: number
}

export interface ConversationResult {
  messages: TranscriptMessage[]
  truncated: boolean
  total: number
}
