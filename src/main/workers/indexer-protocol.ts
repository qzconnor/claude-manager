import type { TranscriptMessage } from '@shared/types'
import type { ParsedSummary } from './transcript-parser'

export type IndexerRequest =
  | { method: 'scanSessions'; projectsDir: string }
  | { method: 'tokenStats'; projectsDir: string; days: number }
  | { method: 'readConversation'; filePath: string; maxMessages: number }
  | { method: 'readToolCall'; filePath: string; toolUseId: string }

export type IndexerResponse =
  | { id: number; ok: true; result: unknown }
  | { id: number; ok: false; error: string }

export interface IndexedSession extends ParsedSummary {
  projectKey: string
  filePath: string
  sizeBytes: number
  fileUpdatedAt: string
}

/** Aggregates as tuples: [input, output, cacheCreation, cacheRead, messages] */
export interface TokenStatsResult {
  days: [string, [number, number, number, number, number]][]
  models: [string, [number, number, number, number, number]][]
  sessionCount: number
}

export interface ConversationResult {
  messages: TranscriptMessage[]
  truncated: boolean
}
