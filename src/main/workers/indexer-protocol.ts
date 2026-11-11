import type { TranscriptMessage } from '@shared/types'
import type { ParsedSummary } from './transcript-parser'

export type IndexerRequest =
  | { method: 'scanSessions'; projectsDir: string }
  | { method: 'tokenStats'; projectsDir: string; days: number }
  | { method: 'readConversation'; filePath: string; maxMessages: number }
  | { method: 'readToolCall'; filePath: string; toolUseId: string }
  /** An empty query only brings the search index up to date. */
  | { method: 'searchTranscripts'; projectsDir: string; query: string; limit: number }

export type IndexerResponse =
  | { id: number; ok: true; result: unknown }
  | { id: number; ok: false; error: string }

export interface IndexedSession extends ParsedSummary {
  projectKey: string
  filePath: string
  sizeBytes: number
  fileUpdatedAt: string
}

/** [input, output, cacheCreation, cacheRead, messages] */
export type TokenTuple = [number, number, number, number, number]

/** Aggregates as tuples (see `TokenTuple`). */
export interface TokenStatsResult {
  days: [string, TokenTuple][]
  models: [string, TokenTuple][]
  /**
   * By the folder the sessions ran in (`null` when unknown), with Claude's project folder name and the
   * number of sessions. A worktree session counts for the folder it was started in.
   */
  folders: [string | null, string, TokenTuple, number][]
  sessionCount: number
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
